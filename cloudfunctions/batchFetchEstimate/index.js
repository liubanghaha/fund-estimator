const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const fd = require("./_shared/fund-data");
const td = require("./_shared/trading-day");
const https = require("https");

// 数据所属日：当日 9:25 起（集合竞价开盘价定出）为今日；9:25 前/周末/节假日为上一交易日。
// ⚠️ 必须与 getPortfolio 的 openedToday / 客户端 marketPhase() 同一边界——自选页原先用
// `actualDate === todayStr` 硬比，导致 9:25 前与周末把已确定净值标成"估算"、盘中拿不到估算时
// 又把上一交易日涨幅当"今日"（首页此时是 --，两页打架）
function _dataDay(todayStr) {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const openedToday = day >= 1 && day <= 5 && min >= fd.OPEN_MIN;
  return openedToday && td.isTradingDay(todayStr) ? todayStr : td.lastTradingDay(_addDays(todayStr, -1));
}

function _addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- 自主计算基金估算涨跌（取代已下线的天天基金 API） ----

let _holdingsCache = {};
let _holdingsCacheTime = 0;
const HOLDINGS_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function getCachedHoldings(code) {
  const now = Date.now();
  if (now - _holdingsCacheTime > HOLDINGS_CACHE_TTL) {
    _holdingsCache = {};
    _holdingsCacheTime = now;
  }
  if (!_holdingsCache[code]) {
    _holdingsCache[code] = await fd.fetchTempHoldingsDeep(code);
  }
  return _holdingsCache[code] || [];
}

// 自主估算：持仓股实时涨跌 × 权重 加权（仅工作日，盘中实时价 / 盘后收盘价）
async function computeSelfEstimates(codes) {
  const map = {};
  if (!codes || codes.length === 0) return map;

  if (!fd.isBJWeekday()) return map;

  try {
    // 1. 并发拉取所有基金的持仓（限流 10 只/批）
    const CONCURRENT = 10;
    const fundHoldingsMap = {};
    for (let i = 0; i < codes.length; i += CONCURRENT) {
      const batch = codes.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const holdings = await getCachedHoldings(code);
          return { code, holdings, ok: holdings && holdings.length > 0 };
        } catch (e) { return { code, holdings: [], ok: false }; }
      }));
      results.forEach(r => { if (r.ok) fundHoldingsMap[r.code] = r.holdings; });
      if (i + CONCURRENT < codes.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 2. 收集所有持仓股代码，批量查腾讯行情
    const stockSet = new Set();
    for (const holdings of Object.values(fundHoldingsMap)) {
      holdings.forEach(h => {
        if (h.stockCode && h.stockCode.length >= 4) stockSet.add(h.stockCode);
      });
    }
    const stockPriceMap = stockSet.size > 0 ? await fd.fetchStockPricesTencent([...stockSet]) : {};

    // 3. 逐基金计算加权涨跌（北京时间估算时间）
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
          estimatedChangeRate: +(weightedChange / totalRatio).toFixed(2),
          estimateTime: timeStr,
        };
      }
    }
  } catch (e) {
    console.error("自主估算失败:", e.message);
  }

  return map;
}

function selectChangeRate(nav, actualNav, estimatedChangeRate, actualChangeRate) {
  const n = parseFloat(nav);
  const a = parseFloat(actualNav);
  if (a && a !== n) return actualChangeRate != null ? actualChangeRate : (estimatedChangeRate || 0);
  return estimatedChangeRate != null ? estimatedChangeRate : (actualChangeRate || 0);
}

// 东财最新净值分批限并发（8 只/批 + 150ms 间隔，与 getPortfolio 同款写法）：
// 自选多时瞬发几十个请求易被东财风控，批间串行让瞬时压力可控
async function fetchLatestNavsBatched(codes) {
  const CONCURRENT = 8;
  const out = [];
  for (let i = 0; i < codes.length; i += CONCURRENT) {
    const batch = codes.slice(i, i + CONCURRENT);
    out.push(...await Promise.all(batch.map(code => fd.fetchLatestNavEastMoney(code))));
    if (i + CONCURRENT < codes.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }
  return out;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };

  const { codes = [], src } = event;
  const estSrc = src === "self" ? "self" : "sina";
  if (!codes.length) return { code: 400, msg: "缺少基金代码" };

  try {
    // 数据源一（新浪实时估值）+ 数据源二（自主估算：持仓 × 实时行情加权）+ 东方财富最新净值，并行执行
    const todayStr = fd.formatBJDate();
    const [sinaMap, estMap, emResults] = await Promise.all([
      fd.fetchSinaEstimates(codes, { budgetMs: 8000 }),
      computeSelfEstimates(codes),
      fetchLatestNavsBatched(codes),
    ]);

    const data = {};
    codes.forEach((code, i) => {
      const em = emResults[i] || {};
      const est = estMap[code] || {};
      const sn = sinaMap[code] || {};
      const sinaToday = sn.date != null && (_gdIsToday(sn.date, todayStr)) && sn.changeRate != null;
      const nav = em.actualNav != null ? em.actualNav : null;
      // 净值已公布用精确值；未公布按所选源（sina=数据源一优先，self=数据源二优先），互相兜底
      // 判据用 displayDay（9:25 起=今天），不是硬比 todayStr——后者在 9:25 前/周末会把
      // 上一交易日的已确定净值误判成"今日未公布"，再据此编出假估算
      const displayDay = _dataDay(todayStr);
      let estimatedChangeRate = null, estimateTime = "", source = "";
      if (em.actualDate === displayDay) {
        estimatedChangeRate = em.actualChangeRate != null ? em.actualChangeRate : null;
        source = "nav";
      } else if (estSrc === "sina" && sinaToday) {
        estimatedChangeRate = sn.changeRate; estimateTime = sn.time || ""; source = "sina";
      } else if (est.estimatedChangeRate != null) {
        estimatedChangeRate = est.estimatedChangeRate; estimateTime = est.estimateTime || ""; source = "self";
      } else if (sinaToday) {
        estimatedChangeRate = sn.changeRate; estimateTime = sn.time || ""; source = "sina";
      } else {
        // 今日既无净值也拿不到估算（债券/968/货币等无覆盖标的）→ 不拿上一交易日涨幅顶替，
        // 留 null 让列表显示 --（与首页/详情页同一约定）
        estimatedChangeRate = null; source = "nav";
      }
      // 估算净值：数据源一直用新浪给的估算净值，数据源二/兜底按最新净值 × (1 + 估算涨跌%)
      const estimatedNav = (source === "sina" && sn.nav != null)
        ? sn.nav
        : ((estimatedChangeRate != null && nav != null)
          ? +(nav * (1 + estimatedChangeRate / 100)).toFixed(4)
          : null);
      data[code] = {
        fundCode: code,
        fundName: "",
        nav,
        estimatedNav,
        estimatedChangeRate,
        // 今日未出估值（estimatedChangeRate 为 null）→ displayChangeRate 也留 null，
        // 列表显示 --；否则 selectChangeRate 会回退成上一交易日涨幅（假"今日"）
        displayChangeRate: estimatedChangeRate == null
          ? null
          : selectChangeRate(nav, em.actualNav, estimatedChangeRate, em.actualChangeRate),
        estimateTime,
        source,
      };
    });
    return { code: 0, data };
  } catch (e) {
    console.error("批量获取估值失败:", e);
    return { code: 500, msg: "获取失败" };
  }
};


// GZTIME 是否属于今日：兼容 "YYYY-MM-DD HH:mm:ss" 与 "MM-DD HH:mm:ss" 两种盘中格式
function _gdIsToday(gztime, todayStr) {
  const gd = String(gztime || "").trim();
  return gd.slice(0, 10) === todayStr || gd.slice(0, 5) === todayStr.slice(5);
}
