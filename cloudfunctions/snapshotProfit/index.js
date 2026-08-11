const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fd = require("./_shared/fund-data");

exports.main = async () => {
  try {
    // 分页读取全部持仓（云函数 get() 默认最多返回 100 条，超出会静默截断）
    const MAX_LIMIT = 100;
    let holdings = [];
    let offset = 0;
    while (true) {
      const page = await db.collection("holdings").skip(offset).limit(MAX_LIMIT).get();
      holdings = holdings.concat(page.data || []);
      if (!page.data || page.data.length < MAX_LIMIT) break;
      offset += MAX_LIMIT;
    }
    if (holdings.length === 0) return { code: 0, msg: "无持仓" };

    // 按用户分组
    const userMap = {};
    holdings.forEach(h => {
      if (!userMap[h._openid]) userMap[h._openid] = [];
      userMap[h._openid].push(h);
    });

    // 北京时间交易时段判断
    const now = new Date();
    const bj = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
    const bjHours = bj.getUTCHours();
    const bjDay = bj.getUTCDay();
    const totalMin = bjHours * 60 + bj.getUTCMinutes();
    const inTrading = bjDay >= 1 && bjDay <= 5 && ((totalMin >= 570 && totalMin < 690) || (totalMin >= 780 && totalMin <= 900));
    if (!inTrading) return { code: 0, msg: "非交易时段跳过" };
    if (totalMin > 690 && totalMin < 780) return { code: 0, msg: "午休跳过" }; // 11:30~13:00
    const today = fd.formatBJDate(now);
    const time = fd.formatBJTime(now);

    for (const [openid, userHoldings] of Object.entries(userMap)) {
      const codes = userHoldings.map(h => h.fundCode);
      const tiantianMap = await batchFetchTiantian(codes);

      let totalWeightedRate = 0, totalBase = 0;
      for (const h of userHoldings) {
        const t = tiantianMap[h.fundCode] || {};
        const shares = h.shares || h.amount || 0;
        const yesterdayNav = t.nav || h.nav || 0;
        const rate = t.estimatedChangeRate || 0;
        const weight = shares * yesterdayNav;
        if (weight > 0) {
          totalWeightedRate += rate * weight;
          totalBase += weight;
        }
      }
      const rate = totalBase > 0 ? +((totalWeightedRate / totalBase)).toFixed(2) : 0;

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
    }

    return { code: 0, msg: "ok", time };
  } catch (e) {
    console.error("snapshotProfit 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// ---- 自主计算估值（取代已下线的天天基金 API） ----

// 模块级持仓缓存：季报持仓日内不变，6 小时足够，避免每分钟定时任务重复抓取
let _holdingsCache = {};
let _holdingsCacheTime = 0;
const HOLDINGS_CACHE_TTL = 6 * 60 * 60 * 1000;

async function getCachedHoldings(fundCode) {
  const now = Date.now();
  if (now - _holdingsCacheTime > HOLDINGS_CACHE_TTL) {
    _holdingsCache = {};
    _holdingsCacheTime = now;
  }
  if (!_holdingsCache[fundCode]) {
    _holdingsCache[fundCode] = await fd.fetchTempHoldings(fundCode);
  }
  return _holdingsCache[fundCode] || [];
}

// 基金最新净值缓存：盘中净值一天不变，按天只拉一次，避免每分钟定时任务重复请求
let _navCache = {};
let _navCacheDate = "";

async function fetchLatestNav(fundCode) {
  const dateKey = fd.formatBJDate();
  if (_navCacheDate !== dateKey) { _navCache = {}; _navCacheDate = dateKey; }
  if (_navCache[fundCode] !== undefined) return _navCache[fundCode];
  const em = await fd.fetchLatestNavEastMoney(fundCode, { pageSize: 1 });
  const nav = em.actualNav || 0;
  _navCache[fundCode] = nav;
  return nav;
}

async function batchFetchTiantian(codes) {
  const map = {};
  if (!codes || codes.length === 0) return map;

  try {
    // 1. 并发拉取持仓（走缓存）+ 最新净值（当日缓存，用作快照加权权重）
    const fundHoldingsMap = {};
    const fundNavMap = {};
    const CONCURRENT = 10;
    for (let i = 0; i < codes.length; i += CONCURRENT) {
      const batch = codes.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const [holdings, nav] = await Promise.all([
            getCachedHoldings(code),
            fetchLatestNav(code),
          ]);
          return { code, holdings, nav, ok: holdings && holdings.length > 0 };
        } catch (e) { return { code, holdings: [], nav: 0, ok: false }; }
      }));
      results.forEach(r => {
        if (r.ok) {
          fundHoldingsMap[r.code] = r.holdings;
          if (r.nav > 0) fundNavMap[r.code] = r.nav;
        }
      });
      if (i + CONCURRENT < codes.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 2. 收集所有股票代码 & 批量查腾讯行情
    const stockSet = new Set();
    for (const holdings of Object.values(fundHoldingsMap)) {
      holdings.forEach(h => { if (h.stockCode) stockSet.add(h.stockCode); });
    }
    const stockPriceMap = [...stockSet].length > 0 ? await fd.fetchStockPricesTencent([...stockSet]) : {};

    // 3. 逐基金计算加权涨跌
    const timeStr = fd.formatBJTime();
    for (const code of codes) {
      const holdings = fundHoldingsMap[code];
      if (!holdings || holdings.length === 0) continue;
      let totalRatio = 0, weightedChange = 0;
      for (const h of holdings) {
        const price = stockPriceMap[h.stockCode];
        if (!price || price.changeRate == null) continue;
        totalRatio += h.navRatio;
        weightedChange += price.changeRate * h.navRatio;
      }
      if (totalRatio > 0) {
        map[code] = {
          fundCode: code,
          fundName: "",
          nav: fundNavMap[code] || 0, // 最新净值（当日缓存），快照加权权重用，与昨日净值误差 <1%
          estimatedChangeRate: +(weightedChange / totalRatio).toFixed(2),
          estimateTime: timeStr,
        };
      }
    }
  } catch (e) {
    console.error("snapshotProfit自主估算失败:", e.message);
  }

  return map;
}
