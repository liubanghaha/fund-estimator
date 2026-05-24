const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INDEX_SYMBOL = {
  "000001": "sh000001",
  "399001": "sz399001",
  "000300": "sh000300",
  "399006": "sz399006",
};

exports.main = async (event) => {
  const { indexCode, days = 80 } = event;
  if (!indexCode || !INDEX_SYMBOL[indexCode]) {
    return { code: 400, msg: "不支持的指数代码" };
  }

  try {
    // Try Sina first, fallback to eastmoney
    let data = await fetchSinaKline(INDEX_SYMBOL[indexCode], days);
    if (!data || data.length === 0) {
      data = await fetchEastMoneyKline(indexCode, days);
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
