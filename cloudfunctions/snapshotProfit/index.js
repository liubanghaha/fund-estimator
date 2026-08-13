const cloud = require("wx-server-sdk");
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
    let written = 0;
    const sample = [];
    for (const [openid, userHoldings] of Object.entries(userMap)) {
      if (el() > 105000) {
        console.log(`[snapshotProfit] 时间预算用尽，本轮已写 ${written} 个用户`);
        break;
      }
      let totalWeightedRate = 0, totalBase = 0;
      for (const h of userHoldings) {
        const fr = fundRateMap[h.fundCode];
        const nav = navMap[h.fundCode] || (parseFloat(h.buyPrice) > 0 ? parseFloat(h.buyPrice) : 0);
        const shares = parseFloat(h.shares || h.amount || 0);
        const weight = shares * nav;
        if (weight > 0) {
          totalWeightedRate += (fr ? fr.rate : 0) * weight;
          totalBase += weight;
        }
      }
      if (totalBase <= 0) continue; // 无有效数据不写假 0 点
      const rate = +((totalWeightedRate / totalBase)).toFixed(2);
      if (sample.length < 5) sample.push({ openid: openid.slice(0, 8) + "…", funds: userHoldings.length, rate });
      if (force) { written++; continue; }

      // upsert：当天文档存在则 push（内存去重防同分钟重复），不存在则创建
      const doc = await db.collection("profit_snapshots")
        .where({ _openid: openid, date: today }).get();
      if (doc.data && doc.data.length > 0) {
        const exists = (doc.data[0].points || []).some(p => p.time === time);
        if (exists) continue;
        await db.collection("profit_snapshots").doc(doc.data[0]._id).update({
          data: { points: db.command.push({ time, rate }) }
        });
      } else {
        await db.collection("profit_snapshots").add({
          data: { _openid: openid, date: today, points: [{ time, rate }] }
        });
      }
      written++;
    }

    return {
      code: 0, msg: "ok", time, dryRun: !!force,
      users: Object.keys(userMap).length, written, funds: fundCodes.length, stocks: stockCount,
      sample, costMs: el(),
    };
  } catch (e) {
    console.error("snapshotProfit 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// 分页读取全部持仓（只取聚合所需字段，1000 条/页 + _id 游标，避免 skip 深分页）
async function readAllHoldings() {
  const MAX_LIMIT = 1000;
  const FIELD = { _openid: true, fundCode: true, shares: true, amount: true, buyPrice: true, nav: true };
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
      fundRateMap[code] = { rate: +(weightedChange / totalRatio).toFixed(2) };
    }
  }

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
