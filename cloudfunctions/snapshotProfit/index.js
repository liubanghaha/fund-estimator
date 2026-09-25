const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");
const td = require("./_shared/trading-day");

exports.main = async (event) => {
  const { force, dryRun } = event || {}; // force=true：跳过交易时段判断 + 只算不写（供部署后验证）
  // dryRun=true：提醒检测只算不发（不消耗用户订阅额度、不写推送日志），用于验证命中逻辑
  const _start = Date.now();
  const el = () => Date.now() - _start;

  try {
    // 北京时间交易时段判断（含 9:25 集合竞价段：开盘价 9:25 定出，当日曲线从这里起点）
    const bj = new Date(Date.now() + 8 * 3600000);
    const bjDay = bj.getUTCDay();
    const totalMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    const today = fd.formatBJDate();
    const time = fd.formatBJTime();
    // 交易日历守卫：cron 只能表达"周内"，节假日必须查表（2026-09-25 中秋就这样漏过）。
    // 漏了它会在休市日拿上一交易日的行情/净值当今天算，误发涨跌提醒（2026-09-25 实发一条）
    const isTradingDay = td.isTradingDay(today);
    const inTrading = bjDay >= 1 && bjDay <= 5 && fd.inTradingWindow(totalMin);
    if (!force && !(inTrading && isTradingDay)) {
      return { code: 0, msg: isTradingDay ? "非交易时段跳过" : "非交易日跳过" };
    }
    // 涨跌提醒检测起点 09:35：9:25-9:30 只有竞价缺口、自算口径失真最大，而提醒额度很贵，
    // 不该被开盘噪音吃掉（快照点仍从 9:25 起写，当日曲线起点不变）
    const alertAllowed = !!force || totalMin >= ALERT_START_MIN;

    // 1. 读取全部持仓（field 投影 + 游标分页，旧实现 100 条/页读 87 页耗时过长）
    //    h5_ 前缀 = H5/网页版时期的历史账号（实测 1243 个 vs 小程序侧 161 个有持仓），
    //    已确认 H5 侧不再运营、这些人也不进小程序 —— 给它们每轮算+写快照是纯浪费
    //    （曾占写入量约 88%），这里整批排除。注意：不删它们的持仓数据（老用户召回要用）
    const allHoldings = await readAllHoldings();
    const holdings = allHoldings.filter(h => !String(h._openid || "").startsWith("h5_"));
    const skippedLegacy = allHoldings.length - holdings.length;
    if (skippedLegacy > 0) console.log(`[snapshotProfit] 排除 h5_ 历史账号持仓 ${skippedLegacy} 条`);
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
    // rate=数据源一口径（每基金新浪估值优先，缺值回退自算）、rateSelf=自算口径；
    // 快照点两值并存，读取端按用户数据源偏好展示，切换源历史曲线立即变化
    for (const [openid, userHoldings] of Object.entries(userMap)) {
      let totalWeightedRate = 0, totalWeightedSelf = 0, totalBase = 0, ratedBase = 0;
      for (const h of userHoldings) {
        const fr = fundRateMap[h.fundCode];
        const nav = navMap[h.fundCode] || (parseFloat(h.buyPrice) > 0 ? parseFloat(h.buyPrice) : 0);
        const shares = parseFloat(h.shares || h.amount || 0);
        const weight = shares * nav;
        if (weight > 0) {
          const selfRate = fr ? fr.rate : 0;
          totalWeightedSelf += selfRate * weight;
          totalWeightedRate += (fr && fr.rateSina != null ? fr.rateSina : selfRate) * weight;
          totalBase += weight;
          // 该基金今日至少有一个口径有数据（自算或数据源一）才有资格进"有估算"的基数
          if (fr && (typeof fr.rate === "number" || fr.rateSina != null)) ratedBase += weight;
        }
      }
      // 无有效数据不写假 0 点。ratedBase 这一条专治"行情源给旧数据"：全组合都算不出今日估算时
      // 加权和恒为 0，写下去就是一条假 0（客户端会把"确认为零收益"当真值）
      if (totalBase <= 0 || ratedBase <= 0) continue;
      const rate = +((totalWeightedRate / totalBase)).toFixed(2);
      const rateSelf = +((totalWeightedSelf / totalBase)).toFixed(2);
      // 金额（元）= Σ(基准市值 × 收益率)/100 = 加权和/100，用未舍入值算：客户端只有 2 位小数
      // 收益率，乘几十万基数会差几十元，与首页金额对不上（点里存上金额，客户端直接用）
      const amount = +(totalWeightedRate / 100).toFixed(2);
      const amountSelf = +(totalWeightedSelf / 100).toFixed(2);
      if (sample.length < 5) sample.push({ openid: openid.slice(0, 8) + "…", funds: userHoldings.length, rate });
      if (force) { written++; continue; } // dry-run 只算不写
      pending.push({ openid, rate, rateSelf, amount, amountSelf, base: +totalBase.toFixed(2) });
    }

    // 分批并发写：每批 CONCURRENT 个用户并行 upsert，预算在批间判断以尽量写全一批
    const CONCURRENT = 8;
    const WRITE_BUDGET_MS = 112000; // 留 ~8s 给函数收尾（timeout 120s）
    for (let i = 0; i < pending.length && el() < WRITE_BUDGET_MS; i += CONCURRENT) {
      const batch = pending.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(p => writePoints(p.openid, today, time, p.rate, p.rateSelf, p.amount, p.amountSelf, p.base)));
      results.forEach(ok => { if (ok) written++; });
    }
    if (el() >= WRITE_BUDGET_MS && written < pending.length) {
      console.log(`[snapshotProfit] 时间预算用尽，已写 ${written}/${pending.length} 个用户`);
    }

    // 4. 盘中涨跌提醒：读提醒设置比对单基金估算涨跌，命中后委托 dailyBriefing 发送
    //    （每日每基金一次由 push_logs 查重保证；提醒独立于快照写入，预算外仍执行）
    let alertSent = 0, alertHits = [];
    try {
      const r = alertAllowed
        ? await checkRateAlerts(userMap, fundRateMap, today, el, !!dryRun)
        : { sent: 0, hits: [] };
      alertSent = r.sent;
      alertHits = r.hits || [];
    } catch (e) {
      console.warn("[snapshotProfit] 涨跌提醒检测失败:", e.message);
    }

    return {
      code: 0, msg: "ok", time, dryRun: !!dryRun || !!force,
      users: Object.keys(userMap).length, written, funds: fundCodes.length, stocks: stockCount,
      skippedLegacy,
      alertSent, alertHits, sample, costMs: el(),
    };
  } catch (e) {
    console.error("snapshotProfit 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// 盘中涨跌提醒：读 alert_settings 比对单基金估算涨跌阈值，命中后委托 dailyBriefing.alertPush
// 批量发送——发送/额度/日志单点在 dailyBriefing 维护。
// 查重粒度 = 每用户每只基金每天一条（原来按 openid 查重，一只基金的噪音命中就吃掉该用户
// 当天全部提醒），外加每用户每日总上限 ALERT_DAILY_CAP 条；同一轮里多只命中只取
// |涨幅| 最大的一条，防推送轰炸与额度烧穿。
// globalOn=true 的用户全部持仓按默认阈值（±3，与客户端弹窗默认一致）兜底提醒
const ALERT_GLOBAL_DEFAULT = { upper: 3, lower: -3 };
// 涨跌提醒检测起点（北京时间分钟数）：09:35 = 开盘后 5 分钟，避开集合竞价段噪音
const ALERT_START_MIN = 575;
// 每用户每天最多几条涨跌提醒（一次性订阅额度池有限，防止一次行情波动把额度烧穿）
const ALERT_DAILY_CAP = 3;

async function checkRateAlerts(userMap, fundRateMap, today, el, dryRun) {
  const alertDocs = await readAllSimple("alert_settings", {}, { _openid: true, settings: true, globalOn: true, src: true });
  if (alertDocs.length === 0) return { sent: 0, hits: [] };   // 形状统一：调用方取 .sent/.hits
  const alertMap = {};
  alertDocs.forEach(d => { alertMap[d._openid] = d; });

  // 当天已发送提醒的查重（fundCode 粒度：每用户每只基金每日一条）
  const fired = await readAllSimple("push_logs", { scene: "rate_alert", date: today, status: "sent" }, { _openid: true, fundCode: true });
  const firedKeys = new Set(fired.map(l => `${l._openid}|${l.fundCode || ""}`));
  const firedCount = {};
  fired.forEach(l => { firedCount[l._openid] = (firedCount[l._openid] || 0) + 1; });

  // 每用户只保留 |rate| 最大的一条命中
  const best = {};
  for (const [openid, userHoldings] of Object.entries(userMap)) {
    if ((firedCount[openid] || 0) >= ALERT_DAILY_CAP) continue;
    const doc = alertMap[openid];
    if (!doc) continue;
    const settings = doc.settings || {};
    // 触发口径跟随用户数据源偏好：src=self → 自算；默认/无 src（老用户）→ 数据源一（缺值回退自算）
    const userSelf = doc.src === "self";
    for (const h of userHoldings) {
      if (firedKeys.has(`${openid}|${h.fundCode}`)) continue;
      const s = settings[h.fundCode] || (doc.globalOn ? ALERT_GLOBAL_DEFAULT : null);
      if (!s) continue;
      // 提醒管理页的单条停用开关（旧数据无 enabled 字段视为启用）：此前只有 PE 提醒判了它，
      // 被关掉的涨跌规则服务端照样推
      if (s.enabled === false) continue;
      const fr = fundRateMap[h.fundCode];
      if (!fr || typeof fr.rate !== "number") continue;
      const rate = userSelf ? fr.rate : (fr.rateSina != null ? fr.rateSina : fr.rate);
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
  const hits = pushes.map(p => `${p.fundName}(${p.fundCode}) ${p.kind} ${p.text}`);
  if (pushes.length === 0) return { sent: 0, hits: [] };
  if (dryRun) {
    console.log(`[snapshotProfit][dryRun] 涨跌提醒命中 ${pushes.length} 条但不发送: ${hits.slice(0, 5).join("; ")}`);
    return { sent: 0, hits };
  }
  console.log(`[snapshotProfit] 涨跌提醒命中 ${pushes.length} 条 t=${el()}ms`);
  // 截断 200（=handleAlertPush 单次上限），溢出的下一分钟触发周期自然补上（查重后不再重发已发的）
  const r = await cloud.callFunction({
    name: "dailyBriefing",
    data: { action: "alertPush", pushes: pushes.slice(0, 200) },
  });
  const sent = (r.result && r.result.sent) || 0;
  const noQuota = (r.result && r.result.noQuota) || 0;
  console.log(`[snapshotProfit] alertPush sent=${sent} noQuota=${noQuota} t=${el()}ms`);
  return { sent, hits, noQuota };
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
async function writePoints(openid, today, time, rate, rateSelf, amount, amountSelf, base) {
  try {
    const point = { time, rate };
    // 当日基准市值（文档级，一天内不变）：周播报用"周初基准市值 × 周收益率"折算金额，
    // 不再拿 DB 里从不更新的 holdings.marketValue 反推；缺失时相关口径退回"只播百分比"
    const docBase = base != null ? { base } : {};
    if (rateSelf != null) point.rateSelf = rateSelf; // 旧逻辑单值点无 rateSelf，读取端回退 rate
    // 金额（元）：今日收益 = 基准市值 × 收益率，用未舍入收益率算好存进来（旧点无此字段，
    // 读取端退回「基准市值 × 2 位收益率」）
    if (amount != null) point.tp = amount;
    if (amountSelf != null) point.tpSelf = amountSelf;
    const doc = await db.collection("profit_snapshots")
      .where({ _openid: openid, date: today }).get();
    if (doc.data && doc.data.length > 0) {
      const exists = (doc.data[0].points || []).some(p => p.time === time);
      if (exists) return true; // 同分钟已存在，视为写入成功（避免并发重写报错）
      await db.collection("profit_snapshots").doc(doc.data[0]._id).update({
        data: { ...docBase, points: db.command.push(point) }
      });
    } else {
      await db.collection("profit_snapshots").add({
        data: { _openid: openid, date: today, ...docBase, points: [point] }
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
  const allCodes = [...stockSet];
  const stockPriceMap = await fetchAllStockPrices(allCodes, startTime);

  // 3b) A 股行情源活性闸门：A 股交易时段里行情日期必然是今天，若所有 A 股行情都不是今天，
  //     说明行情源给的是上一交易日的旧数据（休市但交易日历漏了、或行情源停更/降级）——
  //     此时整段跳过自算口径，免得把旧涨跌当今日估算写进快照、触发误报。
  //     港股/美股不参与判定：美股在 A 股白天天然是昨夜收盘，港股有自己的节假日
  const feedLive = _aShareFeedLive(allCodes, stockPriceMap, today);
  if (!feedLive) console.warn("[snapshotProfit] A 股行情非今日，跳过自算口径 t=" + el() + "ms");

  // 4) 逐基金计算加权涨跌。行情源给旧数据时自算留空（rate=null），但**仍然建条目**：
  //    下一步的数据源一（新浪）自带日期校验，它若有今日估值就该照常生效（两家源互相独立）
  for (const code of fundCodes) {
    const holdings = holdingsMap[code];
    if (!holdings || holdings.length === 0) continue;
    if (!feedLive) { fundRateMap[code] = { rate: null, rateSina: null }; continue; }
    let totalRatio = 0, weightedChange = 0;
    for (const h of holdings) {
      const price = stockPriceMap[h.stockCode];
      if (!price || price.changeRate == null) continue;
      totalRatio += h.navRatio;
      weightedChange += price.changeRate * h.navRatio;
    }
    if (totalRatio > 0) {
      fundRateMap[code] = { rate: +(weightedChange / totalRatio).toFixed(2), rateSina: null };
    }
  }

  // 5) 数据源一估值（新浪实时估值；无覆盖标的如债券基金/968 互认缺值，停更标的按日期判定剔除）：
  //    快照双口径（新浪 rateSina + 自算 rate）并存，读取端按用户数据源偏好选值；
  //    新浪缺值时该基金在"数据源一"聚合中回退自算（rateSina=null → 用 rate）
  try {
    if (Object.keys(fundRateMap).length > 0 && el() < 90000) {
      // 全平台基金要十几批，新浪降级时不能让它吃到 120s 超时被杀（那会让整分钟快照全丢）：
      // 预算 = 距 100s 还剩多少，留 20s 给聚合与分批写库
      const sinaBudget = Math.min(30000, 100000 - el());
      const sinaMap = sinaBudget > 1000
        ? await fd.fetchSinaEstimates(Object.keys(fundRateMap), { budgetMs: sinaBudget })
        : {};
      const todayStr = fd.formatBJDate();
      Object.keys(fundRateMap).forEach(code => {
        const s = sinaMap[code];
        if (s && s.date != null && (_gdIsToday(s.date, todayStr)) && s.changeRate != null) {
          fundRateMap[code].rateSina = s.changeRate;
        }
      });
    }
  } catch (e) { console.warn("[snapshotProfit] 数据源一估值获取失败:", e.message); }

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

// A 股行情源是否活着：持仓里有 A 股代码（6 位数字）时，要求至少一条 A 股行情日期=今天；
// 全是港股/美股时不判定（这些市场的"最新"天然可能不是今天，如美股在 A 股白天是昨夜收盘）
function _aShareFeedLive(codes, priceMap, todayStr) {
  const aCodes = codes.filter(c => /^\d{6}$/.test(String(c).trim()));
  if (aCodes.length === 0) return true;
  return aCodes.some(c => {
    const p = priceMap[c];
    return !!p && p.date === todayStr;
  });
}

// 仅供本地单测（/tmp 桩 DB）直接调提醒逻辑用，不是云函数入口（入口恒为 main）
exports.__test = { checkRateAlerts, ALERT_DAILY_CAP, ALERT_START_MIN };
