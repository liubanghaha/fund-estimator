const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SYMBOL_MAP = {
  "000001": "sh000001",
  "399001": "sz399001",
  "000300": "sh000300",
  "399006": "sz399006",
};

const INDEX_SECID = {
  "000001": "1.000001",
  "399001": "0.399001",
  "000300": "1.000300",
  "399006": "0.399006",
};

exports.main = async (event) => {
  const { indexCode } = event;
  const symbol = SYMBOL_MAP[indexCode] || "sh000001";
  const secid = INDEX_SECID[indexCode] || "1.000001";

  try {
    // 主路径：新浪 5 分钟 K 线 + 从日线推断昨收
    let intraday = await fetchSinaKline(symbol, 5, 240);
    if (!intraday || intraday.length < 2) {
      // 兜底：trends2
      intraday = await fetchTrends2(secid);
    }
    if (!intraday || intraday.length < 2) {
      return { code: 500, msg: "无分时数据" };
    }

    // 用第一根K线的 open 作为昨收近似值（K线 open 即开盘价 ≈ 昨收）
    // 优先从日线API拿精确昨收
    let prevClose = await fetchPrevClose(secid);
    if (!prevClose || prevClose <= 0) {
      // 兜底：用第一条K线的open作为近似昨收
      const item0 = intraday[0];
      if (item0._open && item0._open > 0) {
        prevClose = item0._open;
      }
    }

    // 重算涨跌幅
    if (prevClose > 0) {
      intraday = intraday.map(d => ({
        time: d.time,
        close: d.close,
        changeRate: +((d.close / prevClose - 1) * 100).toFixed(2),
      }));
    }

    return { code: 0, msg: "success", data: intraday };
  } catch (e) {
    console.error("获取分时数据失败:", e.message);
    return { code: 500, msg: "获取分时数据失败" };
  }
};

// 获取昨日收盘价（日线 API）
function fetchPrevClose(secid) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=3`;
    console.log("请求昨收:", url);
    const req = https.get(url, {
      headers: { Referer: "https://quote.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const klines = (json.data && json.data.klines) || [];
          console.log("日线条数:", klines.length);
          // 取最新两条中较早的那条（昨收），或者倒数第二条
          let close = 0;
          if (klines.length >= 2) {
            // 如果最后一条日期是今天，倒数第二条是昨天
            const lastDate = klines[klines.length - 1].split(",")[0];
            const secondLast = klines[klines.length - 2].split(",");
            const today = new Date().toISOString().slice(0, 10);
            if (lastDate.slice(0, 10) === today) {
              close = parseFloat(secondLast[2]) || 0;
            } else {
              close = parseFloat(klines[klines.length - 1].split(",")[2]) || 0;
            }
          } else if (klines.length === 1) {
            close = parseFloat(klines[0].split(",")[2]) || 0;
          }
          console.log("昨收:", close);
          resolve(close);
        } catch (e) {
          console.error("解析昨收失败:", e.message);
          resolve(0);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
    req.on("error", (e) => {
      console.error("昨收请求失败:", e.message);
      resolve(0);
    });
  });
}

// 新浪 5 分钟 K 线
function fetchSinaKline(symbol, scale, datalen) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=${scale}&ma=no&datalen=${datalen}`;
    console.log("请求新浪K线:", url);
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (!json || !json.length) { resolve([]); return; }
          const firstOpen = parseFloat(json[0].open) || 0;
          const list = json.map(item => ({
            time: (item.day || "").length >= 16 ? item.day.slice(11, 16) : (item.day || ""),
            close: parseFloat(item.close) || 0,
            _open: firstOpen,
            changeRate: 0,
          })).filter(d => d.time && d.time.length === 5);
          resolve(list);
        } catch (e) {
          console.error("新浪解析失败:", e.message);
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", (e) => {
      console.error("新浪请求失败:", e.message);
      resolve([]);
    });
  });
}

// 东方财富 trends2 兜底
function fetchTrends2(secid) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbbd4dc3&isauto=1&ndays=1`;
    const req = https.get(url, {
      headers: { Referer: "https://quote.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const trends = (json.data && json.data.trends) || [];
          if (!trends.length) { resolve([]); return; }
          const list = [];
          trends.forEach((line) => {
            const parts = line.split(",");
            const time = parts[0];
            const price = parseFloat(parts[1]) || 0;
            if (time && time.length >= 16) {
              list.push({
                time: time.slice(11, 16),
                close: price,
                _open: parseFloat(trends[0].split(",")[1]) || 0,
                changeRate: 0,
              });
            }
          });
          resolve(list);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}
