const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INDEX_SYMBOL = {
  "000001": "sh000001",
  "399001": "sz399001",
  "000300": "sh000300",
  "399006": "sz399006",
  "HSTECH": "HSTECH",
  "HSI": "HSI",
  "SPX": "SPX",
  "IXIC": "IXIC",
};

const US_SINA_SYMBOLS = { "SPX": "gb_inx", "IXIC": "gb_ixic" };

exports.main = async (event) => {
  const { indexCode, days = 80 } = event;
  if (!indexCode || !INDEX_SYMBOL[indexCode]) {
    return { code: 400, msg: "不支持的指数代码" };
  }

  try {
    let data;
    if (indexCode === "HSTECH" || indexCode === "HSI") {
      data = await fetchHKIndexData(indexCode, days);
    } else if (indexCode === "SPX" || indexCode === "IXIC") {
      data = await fetchUSIndexData(indexCode, days);
    } else {
      data = await fetchAShareIndexData(INDEX_SYMBOL[indexCode], indexCode, days);
    }
    return { code: 0, msg: "success", data };
  } catch (e) {
    console.error("获取指数数据失败:", e.message || e);
    return { code: 500, msg: "获取指数数据失败" };
  }
};

// ========== A 股指数：K 线 + 实时行情融合 ==========

async function fetchAShareIndexData(sinaSymbol, indexCode, days) {
  const [kline, quote] = await Promise.all([
    fetchSinaKline(sinaSymbol, days),
    fetchSinaJSQuote(sinaSymbol),
  ]);

  // 无 K 线数据则 fallback 到东方财富
  let data = kline;
  if (!data || data.length === 0) {
    data = await fetchEastMoneyKline(indexCode, days);
  }

  // 融合实时行情
  if (quote && quote.length > 0 && data && data.length > 0) {
    const quoteLatest = quote[quote.length - 1];
    const klineLatest = data[data.length - 1];
    const today = formatDate(new Date());

    if (klineLatest.date === today) {
      // 已是今天数据，用实时价格覆盖
      data[data.length - 1] = {
        ...klineLatest,
        close: quoteLatest.close,
        high: Math.max(klineLatest.high, quoteLatest.high),
        low: Math.min(klineLatest.low || quoteLatest.high, quoteLatest.low),
      };
    } else if (quoteLatest.close !== quote[0].close) {
      // 今天有新数据（当前价 != 昨收），追加当日数据点
      data.push({
        date: today,
        open: quoteLatest.open || quoteLatest.close,
        close: quoteLatest.close,
        high: quoteLatest.high,
        low: quoteLatest.low,
        volume: 0,
      });
    }
  }

  return data || [];
}

// ========== 港股指数 ==========

const HK_SINA_SYMBOLS = { "HSTECH": "hstHSTECH", "HSI": "hstHSI" };
const HK_EM_SECIDS = { "HSTECH": "124.HSTECH", "HSI": "124.HSI" };
const HK_EM_REALTIME = { "HSTECH": "124.HSTECH", "HSI": "124.HSI" };
const HK_TENCENT = { "HSTECH": "hkHSTECH", "HSI": "hkHSI" };

async function fetchHKIndexData(code, days) {
  // 1) 腾讯实时行情（最可靠，已验证）
  const tencentRealtime = await fetchTencentRealtime(HK_TENCENT[code]);
  if (tencentRealtime && tencentRealtime.length > 0) return tencentRealtime;

  // 2) 东方财富实时行情
  const emRealtime = await fetchEastMoneyRealtime(HK_EM_REALTIME[code]);
  if (emRealtime && emRealtime.length > 0) return emRealtime;

  // 3) 新浪实时行情（港股指数通常无数据）
  const sinaQuote = await fetchSinaJSQuote(HK_SINA_SYMBOLS[code]);
  if (sinaQuote && sinaQuote.length > 0) return sinaQuote;

  // 4) 腾讯财经港股 K 线
  const tencentKline = await fetchTencentHKKline(HK_TENCENT[code], days);
  if (tencentKline && tencentKline.length > 0) return tencentKline;

  // 5) 东方财富全球 K 线
  const emKline = await fetchEastMoneyGlobalKline(HK_EM_SECIDS[code], days);
  if (emKline && emKline.length > 0) return emKline;

  // 6) 新浪港股 K 线
  const sinaKline = await fetchSinaHKKline(code, days);
  if (sinaKline && sinaKline.length > 0) return sinaKline;

  // 7) Yahoo 兜底
  return await fetchYahooKline(code, days);
}

// ========== 美股指数 ==========

async function fetchUSIndexData(code, days) {
  // 新浪实时行情（主力源）
  const sinaQuote = await fetchSinaUSQuote(US_SINA_SYMBOLS[code]);
  if (sinaQuote && sinaQuote.length > 0) return sinaQuote;

  // K 线兜底
  const tencentKline = await fetchTencentHKKline(US_SINA_SYMBOLS[code], days);
  if (tencentKline && tencentKline.length > 0) return tencentKline;

  return await fetchYahooKline(code, days);
}

function fetchSinaUSQuote(symbol) {
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
          const match = body.match(/"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const parts = match[1].split(",");
          if (parts.length < 5) { resolve([]); return; }
          // Sina US format: name, price, change_pct, time, change, open, high, low, ...
          const price = parseFloat(parts[1]) || 0;
          const changeAmt = parseFloat(parts[4]) || 0;
          const prevClose = price - changeAmt;
          const open = parseFloat(parts[5]) || 0;
          const high = parseFloat(parts[6]) || 0;
          const low = parseFloat(parts[7]) || 0;
          if (price <= 0) { resolve([]); return; }
          resolve(buildQuoteData(price, prevClose, open, high, low));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

// ========== 实时行情接口（构建伪 K 线） ==========

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
          const match = body.match(/"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const parts = match[1].split(",");
          if (parts.length < 4) { resolve([]); return; }
          // Sina JS format: name, open, prev_close, price, high, low, ...
          const price = parseFloat(parts[3]) || 0;
          const prevClose = parseFloat(parts[2]) || 0;
          const open = parseFloat(parts[1]) || price;
          const high = parseFloat(parts[4]) || price;
          const low = parseFloat(parts[5]) || price;
          if (price <= 0) { resolve([]); return; }
          resolve(buildQuoteData(price, prevClose, open, high, low));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchEastMoneyRealtime(secid) {
  const https = require("https");
  return new Promise((resolve) => {
    const path = `/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170`;
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
          const d = json.data;
          if (!d || !d.f43) { resolve([]); return; }
          // EastMoney might return prices scaled (e.g. *100 for HK), detect scale
          const scale = d.f43 > 100000 ? 1000 : d.f43 > 10000 ? 100 : 1;
          const price = (d.f43 || 0) / scale;
          const prevClose = (d.f60 || 0) / scale;
          const open = (d.f46 || 0) / scale;
          const high = (d.f44 || 0) / scale;
          const low = (d.f45 || 0) / scale;
          if (price <= 0) { resolve([]); return; }
          resolve(buildQuoteData(price, prevClose, open, high, low));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function fetchTencentRealtime(symbol) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://qt.gtimg.cn/q=${symbol}`;
    const req = https.get(url, {
      headers: { Referer: "https://gu.qq.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/"(.*?)"/);
          if (!match) { resolve([]); return; }
          const parts = match[1].split("~");
          // Tencent format: market~name~code~price~prevClose~open~volume~...
          const price = parseFloat(parts[3]) || 0;
          const prevClose = parseFloat(parts[4]) || 0;
          const open = parseFloat(parts[5]) || 0;
          if (price <= 0) { resolve([]); return; }
          resolve(buildQuoteData(price, prevClose, open, price, price));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function buildQuoteData(price, prevClose, open, high, low) {
  const today = new Date();
  const todayStr = formatDate(today);
  const yesterday = new Date(today.getTime() - 86400000);
  const yesterdayStr = formatDate(yesterday);
  const list = [];
  const usePrev = prevClose > 0 ? prevClose : price;
  list.push({
    date: yesterdayStr,
    open: usePrev,
    close: usePrev,
    high: usePrev,
    low: usePrev,
    volume: 0,
  });
  list.push({
    date: todayStr,
    open: open || price,
    close: price,
    high: high || price,
    low: low || price,
    volume: 0,
  });
  return list;
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ========== K 线接口（历史数据） ==========

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
            const dateStr = formatDate(d);
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
