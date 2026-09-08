const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");

exports.main = async (event) => {
  const { force } = event || {}; // force=true：跳过交易时段判断 + 只算不写，供部署后验证
  const _start = Date.now();
  const el = () => Date.now() - _start;

  try {
    // 北京时间交易时段判断
    const bj = new Date(Date.now() + 8 * 3600000);
    const bjDay = bj.getUTCDay();
    const totalMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    const inTrading = bjDay >= 1 && bjDay <= 5 && ((totalMin >= 570 && totalMin < 690) || (totalMin >= 780 && totalMin <= 900));
    if (!force && !inTrading) return { code: 0, msg: "非交易时段跳过" };
    const today = fd.formatBJDate();
    const time = fd.formatBJTime();

    // 1. 读取全部持仓（field 投影 + 游标分页，旧实现 100 条/页读 87 页耗时过长）
    const holdings = await readAllHoldings();
    if (holdings.length === 0) return { code: 0, msg: "无持仓" };
    const userMap = {};
    holdings.forEach(h => {
      if (!userMap[h._openid]) userMap[h._openid] = [];
      userMap[h._openid].push(h);
    });
    console.log(`[snapshotProfit] holdings=${holdings.length} users=${Object.keys(userMap).length} t=${el()}ms`);

    // 2. 全局基金估算：每只基金只算一次，跨用户共享。
    //    旧实现每个用户重复拉持仓/净值/行情，60s 超时只覆盖排在前面的少数用户，
    //    导致其余用户全天无快照点，当日走势只剩零星几个点连成折线。
    const fundCodes = [...new Set(holdings.map(h => h.fundCode))];
    const { fundRateMap, navMap, stockCount } = await buildGlobalFundRates(fundCodes, _start);
    console.log(`[snapshotProfit] rates=${Object.keys(fundRateMap).length}/${fundCodes.length} navs=${Object.keys(navMap).length} stocks=${stockCount} t=${el()}ms`);

    // 3. 逐用户聚合写快照（纯算术 + DB 写，预算保护避免超时被杀）
    // 优化：先纯内存算出所有用户的 rate（无 DB 等待），再分批并发写库（Promise.all），
    // 避免"逐用户串行 await 一读一写"的累积延迟——用户多时串行会累加到超时被截断，
    // 导致后面的用户整分钟没点（缺口）。并发写能显著提升单位时间内写全的用户数。
    let written = 0;
    const sample = [];
    const pending = [];
    // 聚合（纯内存，快）：每位用户算双口径加权收益率——
    // rate=官方口径（每基金官方 GSZZL 优先，缺值回退自算）、rateSelf=自算口径；
    // 快照点两值并存，读取端按用户数据源偏好展示，切换源历史曲线立即变化
    for (const [openid, userHoldings] of Object.entries(userMap)) {
      let totalWeightedRate = 0, totalWeightedSelf = 0, totalBase = 0;
      for (const h of userHoldings) {
        const fr = fundRateMap[h.fundCode];
        const nav = navMap[h.fundCode] || (parseFloat(h.buyPrice) > 0 ? parseFloat(h.buyPrice) : 0);
        const shares = parseFloat(h.shares || h.amount || 0);
        const weight = shares * nav;
        if (weight > 0) {
          const selfRate = fr ? fr.rate : 0;
          totalWeightedSelf += selfRate * weight;
          totalWeightedRate += (fr && fr.rateEm != null ? fr.rateEm : selfRate) * weight;
          totalBase += weight;
        }
      }
      if (totalBase <= 0) continue; // 无有效数据不写假 0 点
      const rate = +((totalWeightedRate / totalBase)).toFixed(2);
      const rateSelf = +((totalWeightedSelf / totalBase)).toFixed(2);
      if (sample.length < 5) sample.push({ openid: openid.slice(0, 8) + "…", funds: userHoldings.length, rate });
      if (force) { written++; continue; } // dry-run 只算不写
      pending.push({ openid, rate, rateSelf });
    }

    // 分批并发写：每批 CONCURRENT 个用户并行 upsert，预算在批间判断以尽量写全一批
    const CONCURRENT = 8;
    const WRITE_BUDGET_MS = 112000; // 留 ~8s 给函数收尾（timeout 120s）
    for (let i = 0; i < pending.length && el() < WRITE_BUDGET_MS; i += CONCURRENT) {
      const batch = pending.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(p => writePoints(p.openid, today, time, p.rate, p.rateSelf)));
      results.forEach(ok => { if (ok) written++; });
    }
    if (el() >= WRITE_BUDGET_MS && written < pending.length) {
      console.log(`[snapshotProfit] 时间预算用尽，已写 ${written}/${pending.length} 个用户`);
    }

    // 4. 盘中涨跌提醒：读提醒设置比对单基金估算涨跌，命中后委托 dailyBriefing 发送
    //    （每日每基金一次由 push_logs 查重保证；提醒独立于快照写入，预算外仍执行）
    let alertSent = 0;
    try {
      alertSent = await checkRateAlerts(userMap, fundRateMap, today, el);
    } catch (e) {
      console.warn("[snapshotProfit] 涨跌提醒检测失败:", e.message);
    }

    return {
      code: 0, msg: "ok", time, dryRun: !!force,
      users: Object.keys(userMap).length, written, funds: fundCodes.length, stocks: stockCount,
      alertSent, sample, costMs: el(),
    };
  } catch (e) {
    console.error("snapshotProfit 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// 盘中涨跌提醒：读 alert_settings 比对单基金估算涨跌阈值，命中（每日每用户一次，
// 多只同时命中取绝对涨幅最大的一条，防推送轰炸与额度烧穿）
// 后委托 dailyBriefing.alertPush 批量发送——发送/额度/日志单点在 dailyBriefing 维护
// globalOn=true 的用户全部持仓按默认阈值（±3，与客户端弹窗默认一致）兜底提醒
const ALERT_GLOBAL_DEFAULT = { upper: 3, lower: -3 };

async function checkRateAlerts(userMap, fundRateMap, today, el) {
  const alertDocs = await readAllSimple("alert_settings", {}, { _openid: true, settings: true, globalOn: true, src: true });
  if (alertDocs.length === 0) return 0;
  const alertMap = {};
  alertDocs.forEach(d => { alertMap[d._openid] = d; });

  // 当天已发送提醒的用户查重（openid 粒度：每用户每日一条）
  const fired = await readAllSimple("push_logs", { scene: "rate_alert", date: today, status: "sent" }, { _openid: true });
  const firedSet = new Set(fired.map(l => l._openid));

  // 每用户只保留 |rate| 最大的一条命中
  const best = {};
  for (const [openid, userHoldings] of Object.entries(userMap)) {
    if (firedSet.has(openid)) continue;
    const doc = alertMap[openid];
    if (!doc) continue;
    const settings = doc.settings || {};
    // 触发口径跟随用户数据源偏好：src=self → 自算；默认/无 src（老用户）→ 官方（缺值回退自算）
    const userSelf = doc.src === "self";
    for (const h of userHoldings) {
      const s = settings[h.fundCode] || (doc.globalOn ? ALERT_GLOBAL_DEFAULT : null);
      if (!s) continue;
      const fr = fundRateMap[h.fundCode];
      if (!fr || typeof fr.rate !== "number") continue;
      const rate = userSelf ? fr.rate : (fr.rateEm != null ? fr.rateEm : fr.rate);
      let kind = "";
      if (s.upper > 0 && rate >= s.upper) kind = "up";
      else if (s.lower < 0 && rate <= s.lower) kind = "down";
      if (!kind) continue;
      const cand = {
        openid,
        scene: "rate_alert",
        fundCode: h.fundCode,
        kind,
        fundName: h.fundName || h.fundCode,
        text: `估算${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%，触及提醒线`,
      };
      if (!best[openid] || Math.abs(rate) > Math.abs(best[openid]._rate)) {
        cand._rate = rate;
        best[openid] = cand;
      }
    }
  }
  const pushes = Object.values(best).map(p => {
    const { _rate, ...rest } = p;
    return rest;
  });
  if (pushes.length === 0) return 0;
  console.log(`[snapshotProfit] 涨跌提醒命中 ${pushes.length} 条 t=${el()}ms`);
  // 截断 200（=handleAlertPush 单次上限），溢出的下一分钟触发周期自然补上（查重后不再重发已发的）
  const r = await cloud.callFunction({
    name: "dailyBriefing",
    data: { action: "alertPush", pushes: pushes.slice(0, 200) },
  });
  const sent = (r.result && r.result.sent) || 0;
  console.log(`[snapshotProfit] alertPush sent=${sent} t=${el()}ms`);
  return sent;
}

// skip 分页读全量（提醒相关集合量级在千级，够用且实现简单）
async function readAllSimple(col, where, field) {
  const out = [];
  for (let skip = 0; skip < 20000; skip += 1000) {
    let q = db.collection(col);
    if (where && Object.keys(where).length > 0) q = q.where(where);
    if (field) q = q.field(field);
    const res = await q.skip(skip).limit(1000).get();
    out.push(...(res.data || []));
    if ((res.data || []).length < 1000) break;
  }
  return out;
}

// 分页读取全部持仓（只取聚合所需字段，1000 条/页 + _id 游标，避免 skip 深分页）
async function readAllHoldings() {
  const MAX_LIMIT = 1000;
  const FIELD = { _openid: true, fundCode: true, fundName: true, shares: true, amount: true, buyPrice: true, nav: true };
  const all = [];
  let lastId = "";
  while (true) {
    const q = db.collection("holdings").field(FIELD).limit(MAX_LIMIT);
    const res = lastId ? await q.where({ _id: _.gt(lastId) }).get() : await q.get();
    all.push(...(res.data || []));
    if (!res.data || res.data.length < MAX_LIMIT) break;
    lastId = res.data[res.data.length - 1]._id;
  }
  return all;
}

// 将单个用户当天的快照点写入 profit_snapshots（upsert + 同分钟去重）。
// 与原子写点的语义一致：当天文档存在则 push 新点（同分钟已存在则跳过），否则新建文档。
// 返回 true 表示本分钟这一点已写入（供调用方计数）。
async function writePoints(openid, today, time, rate, rateSelf) {
  try {
    const point = { time, rate };
    if (rateSelf != null) point.rateSelf = rateSelf; // 旧逻辑单值点无 rateSelf，读取端回退 rate
    const doc = await db.collection("profit_snapshots")
      .where({ _openid: openid, date: today }).get();
    if (doc.data && doc.data.length > 0) {
      const exists = (doc.data[0].points || []).some(p => p.time === time);
      if (exists) return true; // 同分钟已存在，视为写入成功（避免并发重写报错）
      await db.collection("profit_snapshots").doc(doc.data[0]._id).update({
        data: { points: db.command.push(point) }
      });
    } else {
      await db.collection("profit_snapshots").add({
        data: { _openid: openid, date: today, points: [point] }
      });
    }
    return true;
  } catch (e) {
    console.warn("[snapshotProfit] 写快照失败:", openid, e.message);
    return false;
  }
}

// ---- 全局基金估算涨跌（每只基金只算一次，跨用户共享） ----
// 各阶段均限时间预算：持仓/净值有当日 DB 缓存，稳态下秒级返回；
// 冷启动（当日首次触发）在几轮调用内逐步填满缓存，之后每分钟全覆盖。

async function buildGlobalFundRates(fundCodes, startTime) {
  const fundRateMap = {};
  const today = fd.formatBJDate();
  const el = () => Date.now() - startTime;

  // 1) 基金持仓：温度表 detailPEs + fund_holdings_cache 当日缓存 + 实时兜底（写入缓存）
  const holdingsMap = {};
  const cachedCodes = new Set();

  // 1a) 温度表（凌晨定时任务已算好的基金直接复用）
  try {
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length; i += BATCH) {
      const res = await db.collection("fund_temperatures")
        .where({ fundCode: _.in(fundCodes.slice(i, i + BATCH)), date: today })
        .field({ fundCode: true, detailPEs: true })
        .get();
      (res.data || []).forEach(t => {
        if (t.detailPEs && t.detailPEs.length > 0) {
          holdingsMap[t.fundCode] = t.detailPEs.map(p => ({ stockCode: p.code, navRatio: p.ratio }));
          cachedCodes.add(t.fundCode);
        }
      });
    }
  } catch (e) { console.warn("[snapshotProfit] 读温度表失败:", e.message); }

  // 1b) 当日持仓缓存（fund_holdings_cache，前一天/前几分钟实时兜底拉取的结果）
  try {
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length && el() < 30000; i += BATCH) {
      const res = await db.collection("fund_holdings_cache")
        .where({ fundCode: _.in(fundCodes.slice(i, i + BATCH)), date: today })
        .get();
      (res.data || []).forEach(d => {
        if (d.holdings && d.holdings.length > 0 && !cachedCodes.has(d.fundCode)) {
          holdingsMap[d.fundCode] = d.holdings;
          cachedCodes.add(d.fundCode);
        }
      });
    }
  } catch (e) { console.warn("[snapshotProfit] 读持仓缓存失败:", e.message); }

  // 1c) 仍缺失的基金实时拉取，结果写当日缓存（跨分钟调用复用，每只基金每天只拉一次）
  const missingHoldings = fundCodes.filter(c => !cachedCodes.has(c));
  if (missingHoldings.length > 0 && el() < 30000) {
    const CONCURRENT = 10;
    let fetched = 0;
    for (let i = 0; i < missingHoldings.length && el() < 30000; i += CONCURRENT) {
      const batch = missingHoldings.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const h = await fd.fetchTempHoldings(code);
          if (h && h.length > 0) {
            // _id=fundCode_date 幂等 upsert，避免并发重复 add 累积垃圾文档
            await db.collection("fund_holdings_cache")
              .doc(`${code}_${today}`)
              .set({ data: { fundCode: code, date: today, holdings: h } })
              .catch(() => {});
          }
          return { code, holdings: h, ok: h && h.length > 0 };
        } catch (e) { return { code, holdings: [], ok: false }; }
      }));
      results.forEach(r => {
        if (r.ok) { holdingsMap[r.code] = r.holdings; cachedCodes.add(r.code); fetched++; }
      });
    }
    if (fetched > 0) console.log(`[snapshotProfit] 实时兜底拉取持仓 ${fetched} 只，仍缺 ${fundCodes.length - cachedCodes.size} 只 t=${el()}ms`);
  }

  // 2) 昨收净值：fund_navs 当日缓存，缺失的实时拉取后写缓存
  const navMap = await loadNavMap(fundCodes, startTime);

  // 3) 全量股票行情只拉一次（所有基金持仓股并集，10 批并发，限预算）
  const stockSet = new Set();
  Object.values(holdingsMap).forEach(list => list.forEach(h => { if (h.stockCode) stockSet.add(h.stockCode); }));
  const stockPriceMap = await fetchAllStockPrices([...stockSet], startTime);

  // 4) 逐基金计算加权涨跌
  for (const code of fundCodes) {
    const holdings = holdingsMap[code];
    if (!holdings || holdings.length === 0) continue;
    let totalRatio = 0, weightedChange = 0;
    for (const h of holdings) {
      const price = stockPriceMap[h.stockCode];
      if (!price || price.changeRate == null) continue;
      totalRatio += h.navRatio;
      weightedChange += price.changeRate * h.navRatio;
    }
    if (totalRatio > 0) {
      fundRateMap[code] = { rate: +(weightedChange / totalRatio).toFixed(2), rateEm: null };
    }
  }

  // 5) 官方估值（FundMNFInfo GSZZL，与天天基金 App 同口径；仅盘中提供，净值公布/盘后为 null）：
  //    快照双口径（官方 rateEm + 自算 rate）并存，读取端按用户数据源偏好选值；
  //    官方缺值时该基金在"官方口径"聚合中回退自算（rateEm=null → 用 rate）
  try {
    if (Object.keys(fundRateMap).length > 0 && el() < 90000) {
      const mnfMap = await fetchMNFEstimates(Object.keys(fundRateMap));
      const todayStr = fd.formatBJDate();
      Object.keys(fundRateMap).forEach(code => {
        const m = mnfMap[code];
        if (m && m.gztime != null && (_gdIsToday(m.gztime, todayStr)) && m.gszzl != null) {
          fundRateMap[code].rateEm = m.gszzl;
        }
      });
    }
  } catch (e) { console.warn("[snapshotProfit] 官方估值获取失败:", e.message); }

  return { fundRateMap, navMap, stockCount: stockSet.size };
}

// 昨收净值当日缓存（fund_navs 集合），避免每分钟重复拉东方财富
async function loadNavMap(fundCodes, startTime) {
  const today = fd.formatBJDate();
  const el = () => Date.now() - startTime;
  const navMap = {};
  const cached = new Set();
  try {
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length; i += BATCH) {
      const res = await db.collection("fund_navs")
        .where({ fundCode: _.in(fundCodes.slice(i, i + BATCH)), date: today })
        .get();
      (res.data || []).forEach(d => {
        if (d.yesterdayNav > 0) { navMap[d.fundCode] = d.yesterdayNav; cached.add(d.fundCode); }
      });
    }
  } catch (e) { console.warn("[snapshotProfit] 读净值缓存失败:", e.message); }

  const missing = fundCodes.filter(c => !cached.has(c));
  if (missing.length > 0 && el() < 55000) {
    const CONCURRENT = 16;
    let fetched = 0;
    for (let i = 0; i < missing.length && el() < 55000; i += CONCURRENT) {
      const batch = missing.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const em = await fd.fetchLatestNavEastMoney(code);
          const nav = em.actualNav || em.yesterdayNav;
          if (nav && nav > 0) {
            // _id=fundCode_date 幂等 upsert
            await db.collection("fund_navs")
              .doc(`${code}_${today}`)
              .set({ data: { fundCode: code, date: today, yesterdayNav: nav } })
              .catch(() => {});
            return { code, nav };
          }
        } catch (e) { /* ignore */ }
        return { code, nav: 0 };
      }));
      results.forEach(r => { if (r.nav > 0) { navMap[r.code] = r.nav; fetched++; } });
    }
    if (fetched > 0) console.log(`[snapshotProfit] 实时兜底拉取净值 ${fetched} 只，仍缺 ${missing.length - fetched} 只 t=${el()}ms`);
  }
  return navMap;
}

// 全量股票行情（50 只/批，10 批并发，限预算）
async function fetchAllStockPrices(codes, startTime) {
  const map = {};
  if (!codes || codes.length === 0) return map;
  const BATCH = 50, CONCURRENT = 10;
  for (let i = 0; i < codes.length && Date.now() - startTime < 90000; i += BATCH * CONCURRENT) {
    const slice = codes.slice(i, i + BATCH * CONCURRENT);
    const tasks = [];
    for (let j = 0; j < slice.length; j += BATCH) tasks.push(fd.fetchStockPricesTencent(slice.slice(j, j + BATCH)));
    const results = await Promise.all(tasks);
    results.forEach(m => Object.assign(map, m));
  }
  return map;
}


// GZTIME 是否属于今日：兼容 "YYYY-MM-DD HH:mm:ss" 与 "MM-DD HH:mm:ss" 两种盘中格式
function _gdIsToday(gztime, todayStr) {
  const gd = String(gztime || "").trim();
  return gd.slice(0, 10) === todayStr || gd.slice(0, 5) === todayStr.slice(5);
}

// FundMNFInfo 批量官方估值（200/批，与天天基金 App 同口径）
function fetchMNFEstimates(codes) {
  const map = {};
  if (!codes || !codes.length) return Promise.resolve(map);
  const all = [...codes];
  const batch = () => new Promise((resolve) => {
    const list = all.slice(0, 200);
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=wechat_est&Fcodes=${encodeURIComponent(list.join(","))}`;
    const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/", "User-Agent": "Mozilla/5.0" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          ((JSON.parse(Buffer.concat(chunks).toString("utf8")).Datas) || []).forEach((it) => {
            map[it.FCODE] = {
              gsz: it.GSZ != null && it.GSZ !== "--" ? parseFloat(it.GSZ) : null,
              gszzl: it.GSZZL != null && it.GSZZL !== "--" ? parseFloat(it.GSZZL) : null,
              gztime: it.GZTIME || null,
            };
          });
        } catch (e) { /* ignore */ }
        resolve();
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });
  return (async () => {
    while (all.length > 0) {
      await batch();
      all.splice(0, 200);
    }
    return map;
  })();
}
