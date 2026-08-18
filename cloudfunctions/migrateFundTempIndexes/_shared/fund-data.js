/**
 * 云函数共享数据层（单一数据源）。
 * 云函数独立部署，副本通过 scripts/sync-shared.js 同步进各函数目录，
 * 修改本文件后必须运行 npm run sync:shared。
 */
"use strict";

const https = require("https");
const http = require("http");

// ---------------- 北京时间工具 ----------------

// 返回一个 UTC 字段等于北京壁钟时间的 Date 对象
function _bjDate(date) {
  const d = date instanceof Date ? date : new Date();
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
}

function formatBJDate(date) {
  const d = _bjDate(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function formatBJTime(date) {
  const d = _bjDate(date);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function isBJWeekday(date) {
  const d = _bjDate(date);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * 最近已发布季报的年份/月份（1-3月→上年12月，4-6月→3月，7-9月→6月，10-12月→9月）
 */
function getQuarterParams(date) {
  const d = _bjDate(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3;
  let curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) {
      curM = pubMonths[i];
      break;
    }
    if (i === 0) {
      curY = year - 1;
      curM = 12;
    }
  }
  return { year: curY, month: curM };
}

// ---------------- 东方财富基金持仓 ----------------

// 从表头 th 中定位「占净值比例」列索引（列数随基金类型/季度变化：
// 实测 7 列（无最新价/涨跌幅）与 9 列（有）两种，n-3 恰好都指向占比列，
// 但列数再变时固定下标会取错列 → 以表头列名为准，找不到时回退 n-3）
function _findRatioColIndex(html) {
  const thead = html.match(/<thead[\s\S]*?<\/thead>/);
  if (!thead) return -1;
  const ths = thead[0].match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [];
  for (let i = 0; i < ths.length; i++) {
    const text = ths[i].replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    if (text.indexOf("占净值") !== -1) return i;
  }
  return -1;
}

function _parseHoldingsHtml(body, withMeta) {
  const match = body.match(/content:"([^"]+)"/);
  if (!match) {
    return withMeta ? { holdings: [], fundName: "" } : [];
  }
  const html = match[1].replace(/\\"/g, '"');
  const nameMatch = html.match(/<a title='([^']*)'/);
  const fundName = nameMatch ? nameMatch[1] : "";
  const ratioCol = _findRatioColIndex(html);
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
    if (tds.length >= 7 && tds.length <= 10 && !tds[0].includes("*")) {
      const n = tds.length;
      const col = ratioCol >= 1 && ratioCol < n ? ratioCol : n - 3;
      const ratio = parseFloat(tds[col]) || 0;
      if (ratio > 0 && ratio <= 100) {
        rows.push({
          stockCode: tds[1],
          stockName: tds[2],
          navRatio: ratio,
        });
      }
    }
  }
  return withMeta ? { holdings: rows, fundName } : rows;
}

/**
 * 拉取基金持仓股列表（东方财富 FundArchivesDatas）
 */
function fetchTempHoldings(fundCode, opts = {}) {
  const { topline = 100, timeoutMs = 8000 } = opts;
  const { year, month } = getQuarterParams();
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=${topline}&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve(_parseHoldingsHtml(body, false));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

/**
 * 拉取基金持仓股列表 + 基金名称（温度计算需要名称判断 ETF）
 */
function fetchTempHoldingsWithMeta(fundCode, opts = {}) {
  const { topline = 20, timeoutMs = 8000 } = opts;
  const { year, month } = getQuarterParams();
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=${topline}&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve(_parseHoldingsHtml(body, true));
        } catch (e) {
          resolve({ holdings: [], fundName: "" });
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ holdings: [], fundName: "" }); });
    req.on("error", () => resolve({ holdings: [], fundName: "" }));
  });
}

/**
 * ETF 联接穿透：持仓主体是 ETF 份额时，穿透到 ETF 的持仓股
 */
async function fetchTempHoldingsDeep(fundCode, opts = {}) {
  const holdings = await fetchTempHoldings(fundCode, opts);
  if (!holdings || holdings.length === 0) return [];
  const isEtfCode = (code) => /^(1\d{4}|5\d{4}|159\d{3}|51\d{4}|56\d{4}|58\d{4})$/.test(code);
  const etfCodes = holdings.filter(h => h.stockCode && isEtfCode(h.stockCode)).map(h => h.stockCode);
  if (etfCodes.length > 0 && etfCodes.length >= holdings.length * 0.3) {
    const etfHoldings = await fetchTempHoldings(etfCodes[0], opts);
    if (etfHoldings && etfHoldings.length > 0) return etfHoldings;
  }
  return holdings;
}

// ---------------- 腾讯实时行情 ----------------

/**
 * 批量拉取腾讯全球股票行情（A股/港股/美股）
 * 返回 { [code]: { price, prevClose, changeRate } }
 */
function fetchStockPricesTencent(codes, opts = {}) {
  const map = {};
  if (!codes || codes.length === 0) return Promise.resolve(map);
  const { timeoutMs = 10000, batchSize = 50 } = opts;

  const toQtCode = (code) => {
    const c = String(code).trim().toUpperCase();
    // 字母 ticker 优先（如 5 位美股 GOOGL，避免被误判为港股）
    if (/^[A-Z]/.test(c) && c.length <= 5) return `us${c}`;
    if (/^\d{5}$/.test(c)) return `hk${c}`;
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
            const re = new RegExp(`v_${qtCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`);
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
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });

  return (async () => {
    for (let i = 0; i < codes.length; i += batchSize) {
      await fetchBatch(codes.slice(i, i + batchSize));
    }
    return map;
  })();
}

// ---------------- 东方财富基金净值 ----------------

/**
 * 最新净值（含昨日净值，供估算兜底）
 * 东财 lsjz 不收录 968 互认基金（实测 TotalCount:0），空结果时自动兜底
 * FundMNFInfo 接口（T+1 公布，仅有最新净值+涨跌幅，无昨日净值/盘中估算）
 */
function fetchLatestNavEastMoney(fundCode, opts = {}) {
  const { pageSize = 2, timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=${pageSize}`,
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
          const list = (json.Data && json.Data.LSJZList) || [];
          const today = list[0] || {};
          const yesterday = list[1] || {};
          resolve({
            actualNav: parseFloat(today.DWJZ) || null,
            actualDate: today.FSRQ || "",
            actualChangeRate: parseFloat(today.JZZZL) || null,
            yesterdayNav: parseFloat(yesterday.DWJZ) || null,
          });
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  }).then((r) => {
    // 东财无数据（968 互认基金等）→ FundMNFInfo 兜底
    if (r && (r.actualNav == null || r.actualNav <= 0)) {
      return fetchLatestNavMNF(fundCode, opts);
    }
    return r;
  });
}

/**
 * 互认基金（968xxx）最新净值兜底：FundMNFInfo 接口
 * 返回结构与 fetchLatestNavEastMoney 对齐；T+1 公布、无昨日净值/盘中估算
 */
function fetchLatestNavMNF(fundCode, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "fundmobapi.eastmoney.com",
      path: `/FundMNewApi/FundMNFInfo?Fcodes=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`,
      headers: { Referer: "https://m.fund.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const d = (JSON.parse(body).Datas || [])[0] || {};
          const nav = parseFloat(d.NAV) || null;
          resolve({
            actualNav: nav,
            actualDate: d.PDATE || "",
            actualChangeRate: d.NAVCHGRT != null ? parseFloat(d.NAVCHGRT) : null,
            yesterdayNav: null,
            isMNF: true,
          });
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}

/**
 * 历史净值（分页并发拉取，页序从新到旧）
 * 注意：东财 lsjz 接口固定每页 20 条（实测 pageSize 任意值均被忽略），
 * 页数 = ceil(need/20)；天数钳制 600（防止 days 参数被滥用为外部 API DoS）
 */
function fetchNAVHistory(fundCode, totalNeeded, opts = {}) {
  const { perPage = 20, timeoutMs = 8000 } = opts;
  const need = Math.max(1, Math.min(600, totalNeeded || 0));
  const pages = Math.max(1, Math.ceil(need / perPage));

  const fetchPage = (pageIndex) => new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=${perPage}`,
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
          const list = (json.Data.LSJZList || []).map((item) => ({
            date: item.FSRQ,
            nav: parseFloat(item.DWJZ) || 0,
            cumulativeNav: parseFloat(item.LJJZ) || 0,
            changeRate: parseFloat(item.JZZZL) || 0,
          }));
          resolve(list);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });

  // 分批限并发（每批 3 页），避免页数多时瞬时大量请求打东财接口
  const pageIndexes = Array.from({ length: pages }, (_, i) => i + 1);
  const results = [];
  const CONCURRENT = 3;
  const pump = async () => {
    while (pageIndexes.length) {
      const batch = pageIndexes.splice(0, CONCURRENT);
      const batchRes = await Promise.all(batch.map(fetchPage));
      results.push(...batchRes);
      if (pageIndexes.length) await new Promise(r => setTimeout(r, 120));
    }
  };
  return pump().then(() => results.flat());
}

module.exports = {
  formatBJDate,
  formatBJTime,
  isBJWeekday,
  getQuarterParams,
  fetchTempHoldings,
  fetchTempHoldingsWithMeta,
  fetchTempHoldingsDeep,
  fetchStockPricesTencent,
  fetchLatestNavEastMoney,
  fetchLatestNavMNF,
  fetchNAVHistory,
};
