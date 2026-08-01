const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
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
    _holdingsCache[code] = await fetchTempHoldingsDeep(code);
  }
  return _holdingsCache[code] || [];
}

// 基金持仓抓取（fundf10.eastmoney.com 季度持仓）
function fetchTempHoldings(fundCode) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3, curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
    if (i === 0) { curY = year - 1; curM = 12; }
  }

  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=100&year=${curY}&month=${curM}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const html = match[1].replace(/\\"/g, '"');
          const rows = [];
          const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
          let trMatch;
          while ((trMatch = trRegex.exec(html)) !== null) {
            const tds = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
              tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            if (tds.length >= 7 && !tds[0].includes("*")) {
              const n = tds.length;
              const ratio = parseFloat(tds[n - 3]) || 0;
              if (ratio > 0) {
                rows.push({
                  stockCode: tds[1],
                  stockName: tds[2],
                  navRatio: ratio,
                });
              }
            }
          }
          resolve(rows);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

// ETF 联接穿透：持仓为 ETF 份额时，穿透到 ETF 的持仓股
async function fetchTempHoldingsDeep(fundCode) {
  let holdings = await fetchTempHoldings(fundCode);
  if (!holdings || holdings.length === 0) return [];
  // ETF 代码规则：5位(1xxxx/5xxxx/159xxx) 或 6位(51xxxx/56xxxx/58xxxx)
  const isEtfCode = (code) => /^(1\d{4}|5\d{4}|159\d{3}|51\d{4}|56\d{4}|58\d{4})$/.test(code);
  const etfCodes = holdings.filter(h => h.stockCode && isEtfCode(h.stockCode)).map(h => h.stockCode);
  // 仅当主要持仓是 ETF 份额时才穿透
  if (etfCodes.length > 0 && etfCodes.length >= holdings.length * 0.3) {
    const etfHoldings = await fetchTempHoldings(etfCodes[0]);
    if (etfHoldings && etfHoldings.length > 0) return etfHoldings;
  }
  return holdings;
}

// 腾讯 qt.gtimg.cn 全球股票行情（A股/港股/美股）
function fetchStockPricesTencent(codes) {
  const http = require("http");
  const map = {};
  const BATCH = 50;

  const toQtCode = (code) => {
    const c = String(code).trim().toUpperCase();
    if (c.length === 5) return `hk${c}`;                         // 港股 5 位代码
    if (c.length <= 5 && /^[A-Z]/.test(c)) return `us${c}`;     // 美股 ticker
    if (c.startsWith("6") || c.startsWith("5") || c.startsWith("688")) return `sh${c}`;
    return `sz${c}`;
  };

  const fetchBatch = (batchCodes) => new Promise((resolve) => {
    const qtCodes = batchCodes.map(toQtCode).join(",");
    const req = http.get(`http://qt.gtimg.cn/q=${qtCodes}`, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          for (const code of batchCodes) {
            const qtCode = toQtCode(code);
            const re = new RegExp(`v_${qtCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`);
            const match = body.match(re);
            if (!match) continue;
            const fields = match[1].split("~");
            if (fields.length < 5) continue;
            const curr = parseFloat(fields[3]);
            const prev = parseFloat(fields[4]);
            if (!isNaN(prev) && !isNaN(curr) && prev > 0) {
              map[code] = {
                price: curr,
                prevClose: prev,
                changeRate: +(((curr - prev) / prev) * 100).toFixed(2),
              };
            }
          }
        } catch (e) { /* ignore */ }
        resolve();
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });

  return (async () => {
    for (let i = 0; i < codes.length; i += BATCH) {
      await fetchBatch(codes.slice(i, i + BATCH));
    }
    return map;
  })();
}

// 自主估算：持仓股实时涨跌 × 权重 加权（仅工作日，盘中实时价 / 盘后收盘价）
async function computeSelfEstimates(codes) {
  const map = {};
  if (!codes || codes.length === 0) return map;

  const now = new Date();
  const bjHours = (now.getUTCHours() + 8) % 24;
  const bjDay = (now.getUTCDay() + (now.getUTCHours() + 8 >= 24 ? 1 : 0)) % 7;
  if (bjDay === 0 || bjDay === 6) return map;

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
    const stockPriceMap = stockSet.size > 0 ? await fetchStockPricesTencent([...stockSet]) : {};

    // 3. 逐基金计算加权涨跌（北京时间估算时间）
    const timeStr = `${String(bjHours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
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

// 东方财富最新净值（昨收基准 + 实际涨跌兜底）
function fetchEastMoney(fundCode) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`,
      headers: { "Referer": "https://fundf10.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
          const list = (json.Data && json.Data.LSJZList) || [];
          const today = list[0] || {};
          resolve({
            actualNav: parseFloat(today.DWJZ) || null,
            actualDate: today.FSRQ || "",
            actualChangeRate: parseFloat(today.JZZZL) || null,
          });
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}

function selectChangeRate(nav, actualNav, estimatedChangeRate, actualChangeRate) {
  const n = parseFloat(nav);
  const a = parseFloat(actualNav);
  if (a && a !== n) return actualChangeRate != null ? actualChangeRate : (estimatedChangeRate || 0);
  return estimatedChangeRate != null ? estimatedChangeRate : (actualChangeRate || 0);
}

exports.main = async (event) => {
  const { codes = [] } = event;
  if (!codes.length) return { code: 400, msg: "缺少基金代码" };

  try {
    // 自主估算（持仓 × 实时行情加权）+ 东方财富最新净值，并行执行
    const [estMap, emResults] = await Promise.all([
      computeSelfEstimates(codes),
      Promise.all(codes.map(fetchEastMoney)),
    ]);

    const data = {};
    codes.forEach((code, i) => {
      const em = emResults[i] || {};
      const est = estMap[code] || {};
      const nav = em.actualNav != null ? em.actualNav : null;
      // 盘中优先自主估算；无估算（周末/持仓抓取失败）用净值涨跌幅兜底
      const estimatedChangeRate = est.estimatedChangeRate != null
        ? est.estimatedChangeRate
        : (em.actualChangeRate != null ? em.actualChangeRate : null);
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
        estimateTime: est.estimateTime || "",
      };
    });
    return { code: 0, data };
  } catch (e) {
    console.error("批量获取估值失败:", e);
    return { code: 500, msg: "获取失败" };
  }
};
