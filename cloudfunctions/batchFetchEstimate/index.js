const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const fd = require("./_shared/fund-data");
const https = require("https");

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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };

  const { codes = [], src } = event;
  const estSrc = src === "self" ? "self" : "em";
  if (!codes.length) return { code: 400, msg: "缺少基金代码" };

  try {
    // 官方估值（FundMNFInfo GSZZL）+ 自主估算（持仓 × 实时行情加权）+ 东方财富最新净值，并行执行
    const todayStr = fd.formatBJDate();
    const [mnfMap, estMap, emResults] = await Promise.all([
      fetchMNFEstimates(codes),
      computeSelfEstimates(codes),
      Promise.all(codes.map(code => fd.fetchLatestNavEastMoney(code))),
    ]);

    const data = {};
    codes.forEach((code, i) => {
      const em = emResults[i] || {};
      const est = estMap[code] || {};
      const mnf = mnfMap[code] || {};
      const mnfToday = mnf.gztime != null && (_gdIsToday(mnf.gztime, todayStr)) && mnf.gszzl != null;
      const nav = em.actualNav != null ? em.actualNav : null;
      // 净值已公布用精确值；未公布按所选源（em=官方 GSZZL 优先，self=自算优先），互相兜底
      let estimatedChangeRate = null, estimateTime = "", source = "";
      if (em.actualDate === todayStr) {
        estimatedChangeRate = em.actualChangeRate != null ? em.actualChangeRate : null;
        source = "nav";
      } else if (estSrc === "em" && mnfToday) {
        estimatedChangeRate = mnf.gszzl; estimateTime = mnf.gzhm || mnf.gztime; source = "em";
      } else if (est.estimatedChangeRate != null) {
        estimatedChangeRate = est.estimatedChangeRate; estimateTime = est.estimateTime || ""; source = "self";
      } else if (mnfToday) {
        estimatedChangeRate = mnf.gszzl; estimateTime = mnf.gzhm || mnf.gztime; source = "em";
      } else {
        estimatedChangeRate = em.actualChangeRate != null ? em.actualChangeRate : null; source = "nav";
      }
      // 估算净值 = 最新净值 × (1 + 估算涨跌%)
      const estimatedNav = (estimatedChangeRate != null && nav != null)
        ? +(nav * (1 + estimatedChangeRate / 100)).toFixed(4)
        : null;
      data[code] = {
        fundCode: code,
        fundName: "",
        nav,
        estimatedNav,
        estimatedChangeRate,
        displayChangeRate: selectChangeRate(nav, em.actualNav, estimatedChangeRate, em.actualChangeRate),
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
              gzhm: (String(it.GZTIME || "").match(/(\d{1,2}:\d{2})/) || [])[1] || "",
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
