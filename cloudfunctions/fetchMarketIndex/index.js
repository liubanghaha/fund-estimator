const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INDEX_SYMBOL = {
  "000001": "sh000001",
  "399001": "sz399001",
  "000300": "sh000300",
  "399006": "sz399006",
  "HSTECH": "HSTECH",
  "HSI": "HSI",
};

exports.main = async (event) => {
  const { indexCode, days = 80 } = event;
  if (!indexCode || !INDEX_SYMBOL[indexCode]) {
    return { code: 400, msg: "不支持的指数代码" };
  }

  try {
    let data;
    if (indexCode === "HSTECH" || indexCode === "HSI") {
      data = await fetchHKIndexKline(indexCode, days);
    } else {
      data = await fetchSinaKline(INDEX_SYMBOL[indexCode], days);
      if (!data || data.length === 0) {
        data = await fetchEastMoneyKline(indexCode, days);
      }
    }
    return { code: 0, msg: "success", data };
  } catch (e) {
    console.error("获取指数数据失败:", e.message || e);
    return { code: 500, msg: "获取指数数据失败" };
  }
};

function fetchSinaKline(symbol, days) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&datalen=${days}`;
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const list = JSON.parse(body);
          if (!Array.isArray(list)) { resolve([]); return; }
          resolve(list.map(item => ({
            date: item.day,
            open: parseFloat(item.open) || 0,
            close: parseFloat(item.close) || 0,
            high: parseFloat(item.high) || 0,
            low: parseFloat(item.low) || 0,
            volume: parseFloat(item.volume) || 0,
          })));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchEastMoneyKline(indexCode, days) {
  const https = require("https");
  const SECID_MAP = {
    "000001": "1.000001",
    "399001": "0.399001",
    "000300": "1.000300",
    "399006": "0.399006",
  };
  const secid = SECID_MAP[indexCode] || "1.000001";
  return new Promise((resolve) => {
    const path = `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`;
    const req = https.get({
      hostname: "push2his.eastmoney.com",
      path,
      headers: { Referer: "https://quote.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const klines = (json.data && json.data.klines) || [];
          resolve(klines.map((line) => {
            const parts = line.split(",");
            return {
              date: parts[0],
              open: parseFloat(parts[1]) || 0,
              close: parseFloat(parts[2]) || 0,
              high: parseFloat(parts[3]) || 0,
              low: parseFloat(parts[4]) || 0,
              volume: parseFloat(parts[5]) || 0,
            };
          }));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

// ========== 港股指数 ==========

const HK_SINA_SYMBOLS = {
  "HSTECH": "hstHSTECH",
  "HSI": "hstHSI",
};

const HK_EM_SECIDS = {
  "HSTECH": ["124.HSTECH", "100.HSTECH"],
  "HSI": ["124.HSI", "100.HSI"],
};

const HK_TENCENT_SYMBOLS = {
  "HSTECH": "hkHSTECH",
  "HSI": "hkHSI",
};

async function fetchHKIndexKline(code, days) {
  // 1) 新浪实时行情（最快、最可靠）
  const quoteData = await fetchSinaJSQuote(HK_SINA_SYMBOLS[code]);
  if (quoteData && quoteData.length > 0) return quoteData;

  // 2) 东方财富全球指数
  for (const secid of HK_EM_SECIDS[code]) {
    const data = await fetchEastMoneyGlobalKline(secid, days);
    if (data && data.length > 0) return data;
  }

  // 3) 新浪港股 K 线
  const sinaData = await fetchSinaHKKline(code, days);
  if (sinaData && sinaData.length > 0) return sinaData;

  // 4) 腾讯财经港股
  const tencentData = await fetchTencentHKKline(HK_TENCENT_SYMBOLS[code], days);
  if (tencentData && tencentData.length > 0) return tencentData;

  // 5) Yahoo Finance（兜底）
  return await fetchYahooKline(code, days);
}

function fetchSinaJSQuote(symbol) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://hq.sinajs.cn/list=${symbol}`;
    const req = https.get(url, {
      headers: { Referer: "https://finance.sina.com.cn/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          // Response format: var hq_str_XXX="name,open,prev_close,price,high,low,..."
          const match = body.match(/"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const parts = match[1].split(",");
          if (parts.length < 4) { resolve([]); return; }
          // Field mapping varies by index type; try to locate price & prev_close
          // Common HK index format: name, open, prev_close, price, high, low, ...
          const price = parseFloat(parts[3]) || 0;
          const prevClose = parseFloat(parts[2]) || 0;
          if (price <= 0) { resolve([]); return; }
          const today = new Date();
          const pad = (n) => String(n).padStart(2, "0");
          const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
          const yesterday = new Date(today.getTime() - 86400000);
          const yesterdayStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
          const list = [];
          if (prevClose > 0) {
            list.push({ date: yesterdayStr, open: prevClose, close: prevClose, high: prevClose, low: prevClose, volume: 0 });
          }
          list.push({
            date: todayStr,
            open: parseFloat(parts[1]) || price,
            close: price,
            high: parseFloat(parts[4]) || price,
            low: parseFloat(parts[5]) || price,
            volume: 0,
          });
          resolve(list);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchSinaHKKline(symbol, days) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/HK_MarketData.getKLineData?symbol=${symbol}&scale=240&datalen=${days}`;
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const list = JSON.parse(body);
          if (!Array.isArray(list)) { resolve([]); return; }
          resolve(list.map(item => ({
            date: item.day,
            open: parseFloat(item.open) || 0,
            close: parseFloat(item.close) || 0,
            high: parseFloat(item.high) || 0,
            low: parseFloat(item.low) || 0,
            volume: parseFloat(item.volume) || 0,
          })));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchTencentHKKline(symbol, days) {
  const https = require("https");
  return new Promise((resolve) => {
    const path = `/appstock/app/fqkline/get?_var=kline_dayqfq&param=${symbol},day,,,${days},qfq`;
    const req = https.get({
      hostname: "web.ifzq.gtimg.cn",
      path,
      headers: { Referer: "https://gu.qq.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const jsonStr = body.replace(/^var\s+\w+\s*=\s*/, "").replace(/;?\s*$/, "");
          const json = JSON.parse(jsonStr);
          const list = (json.data && json.data[symbol] && json.data[symbol].day) || json.data || [];
          if (!Array.isArray(list)) { resolve([]); return; }
          resolve(list.map(item => {
            const parts = Array.isArray(item) ? item : item.split ? item.split(",") : [];
            return {
              date: parts[0] || "",
              open: parseFloat(parts[1]) || 0,
              close: parseFloat(parts[2]) || 0,
              high: parseFloat(parts[3]) || 0,
              low: parseFloat(parts[4]) || 0,
              volume: parseFloat(parts[5]) || 0,
            };
          }));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchEastMoneyGlobalKline(secid, days) {
  const https = require("https");
  return new Promise((resolve) => {
    const path = `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`;
    const req = https.get({
      hostname: "push2.eastmoney.com",
      path,
      headers: { Referer: "https://quote.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const klines = (json.data && json.data.klines) || [];
          resolve(klines.map((line) => {
            const parts = line.split(",");
            return {
              date: parts[0],
              open: parseFloat(parts[1]) || 0,
              close: parseFloat(parts[2]) || 0,
              high: parseFloat(parts[3]) || 0,
              low: parseFloat(parts[4]) || 0,
              volume: parseFloat(parts[5]) || 0,
            };
          }));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchYahooKline(symbol, days) {
  const https = require("https");
  let range = "3mo";
  if (days <= 5) range = "5d";
  else if (days <= 30) range = "1mo";
  const YAHOO_SYMBOLS = { "HSTECH": "%5EHSTECH", "HSI": "%5EHSI" };
  const ySymbol = YAHOO_SYMBOLS[symbol] || symbol;
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?range=${range}&interval=1d`;
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const result = json.chart && json.chart.result && json.chart.result[0];
          if (!result) { resolve([]); return; }
          const timestamps = result.timestamp || [];
          const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
          if (!quote || timestamps.length === 0) { resolve([]); return; }
          const list = [];
          for (let i = 0; i < timestamps.length; i++) {
            const d = new Date(timestamps[i] * 1000);
            const pad = (n) => String(n).padStart(2, "0");
            const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            list.push({
              date: dateStr,
              open: parseFloat(quote.open[i]) || 0,
              close: parseFloat(quote.close[i]) || 0,
              high: parseFloat(quote.high[i]) || 0,
              low: parseFloat(quote.low[i]) || 0,
              volume: parseFloat(quote.volume[i]) || 0,
            });
          }
          resolve(list);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}
