const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const INDEX_CONFIG = {
  "000001": { name: "上证指数", secid: "1.000001" },
  "399001": { name: "深证成指", secid: "0.399001" },
  "000300": { name: "沪深300", secid: "1.000300" },
  "399006": { name: "创业板指", secid: "0.399006" },
};

exports.main = async (event) => {
  const { indexCode, days = 90 } = event;
  if (!indexCode || !INDEX_CONFIG[indexCode]) {
    return { code: 400, msg: "不支持的指数代码" };
  }

  try {
    const data = await fetchKline(INDEX_CONFIG[indexCode].secid, days);
    return { code: 0, msg: "success", data };
  } catch (e) {
    console.error("获取指数数据失败:", e.message || e);
    return { code: 500, msg: "获取指数数据失败" };
  }
};

function fetchKline(secid, days) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const path = `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`;
    const options = {
      hostname: "push2his.eastmoney.com",
      path,
      headers: { Referer: "https://quote.eastmoney.com/" },
    };
    const req = https.get(options, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const klines = (json.data && json.data.klines) || [];
          const list = klines.map((line) => {
            const parts = line.split(",");
            return {
              date: parts[0],
              open: parseFloat(parts[1]) || 0,
              close: parseFloat(parts[2]) || 0,
              high: parseFloat(parts[3]) || 0,
              low: parseFloat(parts[4]) || 0,
              volume: parseFloat(parts[5]) || 0,
              amount: parseFloat(parts[6]) || 0,
              amplitude: parseFloat(parts[7]) || 0,
              changeRate: parseFloat(parts[8]) || 0,
              changeAmount: parseFloat(parts[9]) || 0,
              turnover: parseFloat(parts[10]) || 0,
            };
          });
          resolve(list);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("请求超时")); });
    req.on("error", reject);
  });
};
