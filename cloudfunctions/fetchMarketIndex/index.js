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
    // 确保按日期升序排列（部分数据源可能返回降序）
    if (data && data.length > 1) {
      data.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    return { code: 0, msg: "success", data };
  } catch (e) {
    console.error("获取指数数据失败:", e.message || e);
    return { code: 500, msg: "获取指数数据失败" };
  }
};

// ========== A 股指数：实时行情为主，K 线兜底 ==========

async function fetchAShareIndexData(sinaSymbol, indexCode, days) {
  // 首页展示（days<=2）：直接用新浪实时行情，昨收→当前价，涨跌幅最准
  if (days <= 2) {
    const quote = await fetchSinaJSQuote(sinaSymbol);
    if (quote && quote.length >= 2) return quote;
    // 实时行情失败则用 K 线
    const kline = await fetchEastMoneyKline(indexCode, days);
    if (kline && kline.length > 0) {
      kline.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return kline;
    }
    return [];
  }

  // 历史数据（days>2）：东方财富 K 线 + 新浪实时行情融合
  const [kline, quote] = await Promise.all([
    fetchEastMoneyKline(indexCode, days),
    fetchSinaJSQuote(sinaSymbol),
  ]);

  let data = kline;
  if (!data || data.length === 0) {
    data = await fetchSinaKline(sinaSymbol, days);
  }

  if (data && data.length > 1) {
    data.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  if (quote && quote.length >= 2 && data && data.length > 0) {
    const quoteLatest = quote[quote.length - 1];
    const klineLatest = data[data.length - 1];
    const today = formatDate(new Date());

    if (klineLatest.date === today) {
      data[data.length - 1] = {
        ...klineLatest,
        close: quoteLatest.close,
        high: Math.max(klineLatest.high, quoteLatest.high),
        low: Math.min(klineLatest.low || quoteLatest.high, quoteLatest.low),
      };
    } else {
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
  return httpGet(`https://hq.sinajs.cn/list=${symbol}`, { Referer: "https://finance.sina.com.cn/" }, 8000).then((body) => {
    try {
      const match = body.match(/"([^"]+)"/);
      if (!match) return [];
      const parts = match[1].split(",");
      if (parts.length < 5) return [];
      const price = +parts[1] || 0;
      const prevClose = price - (+parts[4] || 0);
      const open = +parts[5] || 0, high = +parts[6] || 0, low = +parts[7] || 0;
      if (price <= 0) return [];
      return buildQuoteData(price, prevClose, open, high, low);
    } catch (e) { return []; }
  });
}

// ========== 实时行情接口（构建伪 K 线） ==========

function fetchSinaJSQuote(symbol) {
  return httpGet(`https://hq.sinajs.cn/list=${symbol}`, { Referer: "https://finance.sina.com.cn/" }, 8000).then((body) => {
    try {
      const match = body.match(/"([^"]+)"/);
      if (!match) return [];
      const parts = match[1].split(",");
      if (parts.length < 4) return [];
      const price = +parts[3] || 0, prevClose = +parts[2] || 0;
      const open = +parts[1] || price, high = +parts[4] || price, low = +parts[5] || price;
      if (price <= 0) return [];
      return buildQuoteData(price, prevClose, open, high, low);
    } catch (e) { return []; }
  });
}

function fetchEastMoneyRealtime(secid) {
  return httpGet({
    hostname: "push2.eastmoney.com",
    path: `/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170`,
  }, { Referer: "https://quote.eastmoney.com/" }, 8000).then((body) => {
    try {
      const d = JSON.parse(body).data;
      if (!d || !d.f43) return [];
      const marketPrefix = secid.split(".")[0] || "";
      const scale = marketPrefix === "124" ? 1000 : 100;
      const price = (d.f43 || 0) / scale, prevClose = (d.f60 || 0) / scale;
      const open = (d.f46 || 0) / scale, high = (d.f44 || 0) / scale, low = (d.f45 || 0) / scale;
      if (price <= 0) return [];
      return buildQuoteData(price, prevClose, open, high, low);
    } catch (e) { return []; }
  });
}

function fetchTencentRealtime(symbol) {
  return httpGet(`https://qt.gtimg.cn/q=${symbol}`, { Referer: "https://gu.qq.com/" }, 8000).then((body) => {
    try {
      const match = body.match(/"(.*?)"/);
      if (!match) return [];
      const parts = match[1].split("~");
      const price = +parts[3] || 0, prevClose = +parts[4] || 0, open = +parts[5] || 0;
      if (price <= 0) return [];
      return buildQuoteData(price, prevClose, open, price, price);
    } catch (e) { return []; }
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

// ========== 通用 HTTP 请求 ==========

function httpGet(urlOrOpts, headers, timeoutMs = 10000) {
  const https = require("https");
  return new Promise((resolve) => {
    const opts = typeof urlOrOpts === "string"
      ? [urlOrOpts, { headers: headers || {} }]
      : [{ hostname: urlOrOpts.hostname, path: urlOrOpts.path }, { headers: headers || {} }];
    const req = https.get(opts[0], opts[1], (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
}

// ========== K 线接口（历史数据） ==========

const EM_SECID = { "000001": "1.000001", "399001": "0.399001", "000300": "1.000300", "399006": "0.399006" };

function parseEMKlines(body) {
  try {
    const json = JSON.parse(body);
    return (json.data && json.data.klines || []).map((line) => {
      const parts = line.split(",");
      return { date: parts[0], open: +parts[1] || 0, close: +parts[2] || 0, high: +parts[3] || 0, low: +parts[4] || 0, volume: +parts[5] || 0 };
    });
  } catch (e) { return []; }
}

function parseSinaKlines(body) {
  try {
    const list = JSON.parse(body);
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({ date: item.day, open: +item.open || 0, close: +item.close || 0, high: +item.high || 0, low: +item.low || 0, volume: +item.volume || 0 }));
  } catch (e) { return []; }
}

function fetchSinaKline(symbol, days) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&datalen=${days}`;
  return httpGet(url, null, 10000).then(parseSinaKlines);
}

function fetchEastMoneyKline(indexCode, days) {
  const secid = EM_SECID[indexCode] || "1.000001";
  return httpGet({
    hostname: "push2his.eastmoney.com",
    path: `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`,
  }, { Referer: "https://quote.eastmoney.com/" }).then(parseEMKlines);
}

function fetchEastMoneyGlobalKline(secid, days) {
  return httpGet({
    hostname: "push2.eastmoney.com",
    path: `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`,
  }, { Referer: "https://quote.eastmoney.com/" }).then(parseEMKlines);
}

function fetchSinaHKKline(symbol, days) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/HK_MarketData.getKLineData?symbol=${symbol}&scale=240&datalen=${days}`;
  return httpGet(url, null, 10000).then(parseSinaKlines);
}

function fetchTencentHKKline(symbol, days) {
  return httpGet({
    hostname: "web.ifzq.gtimg.cn",
    path: `/appstock/app/fqkline/get?_var=kline_dayqfq&param=${symbol},day,,,${days},qfq`,
  }, { Referer: "https://gu.qq.com/" }).then((body) => {
    try {
      const jsonStr = body.replace(/^var\s+\w+\s*=\s*/, "").replace(/;?\s*$/, "");
      const json = JSON.parse(jsonStr);
      const list = (json.data && json.data[symbol] && json.data[symbol].day) || json.data || [];
      if (!Array.isArray(list)) return [];
      return list.map((item) => {
        const parts = Array.isArray(item) ? item : item.split ? item.split(",") : [];
        return { date: parts[0] || "", open: +parts[1] || 0, close: +parts[2] || 0, high: +parts[3] || 0, low: +parts[4] || 0, volume: +parts[5] || 0 };
      });
    } catch (e) { return []; }
  });
}

function fetchYahooKline(symbol, days) {
  let range = "3mo";
  if (days <= 5) range = "5d";
  else if (days <= 30) range = "1mo";
  const YAHOO_SYMBOLS = { "HSTECH": "%5EHSTECH", "HSI": "%5EHSI" };
  const ySymbol = YAHOO_SYMBOLS[symbol] || symbol;
  return httpGet(`https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?range=${range}&interval=1d`).then((body) => {
    try {
      const json = JSON.parse(body);
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result) return [];
      const timestamps = result.timestamp || [];
      const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
      if (!quote || timestamps.length === 0) return [];
      return timestamps.map((ts, i) => ({
        date: formatDate(new Date(ts * 1000)),
        open: +quote.open[i] || 0, close: +quote.close[i] || 0,
        high: +quote.high[i] || 0, low: +quote.low[i] || 0, volume: +quote.volume[i] || 0,
      }));
    } catch (e) { return []; }
  });
}
