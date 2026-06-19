const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SECID = {
  "000001": "1.000001",
  "399001": "0.399001",
  "000300": "1.000300",
  "399006": "0.399006",
};

exports.main = async (event) => {
  const { indexCode } = event;
  const secid = SECID[indexCode] || "1.000001";

  try {
    const https = require("https");
    const raw = await new Promise((resolve, reject) => {
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=1&fqt=1&end=20500101&lmt=250`;
      const req = https.get(url, { headers: { Referer: "https://quote.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            const klines = (json.data && json.data.klines) || [];
            resolve(klines);
          } catch (e) { resolve([]); }
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
      req.on("error", () => resolve([]));
    });

    if (!raw.length) return { code: 500, msg: "无分时数据" };

    // 解析 K 线：时间,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
    const parsed = raw.map(line => {
      const parts = line.split(",");
      return {
        time: parts[0].length >= 16 ? parts[0].slice(11, 16) : parts[0],
        date: parts[0].slice(0, 10),
        close: parseFloat(parts[2]) || 0,
        changeRate: parseFloat(parts[8]) || 0,
      };
    }).filter(d => d.time && d.time.length === 5);

    // 取最新日期的数据
    const dates = [...new Set(parsed.map(d => d.date))].sort();
    const latestDate = dates[dates.length - 1];
    const intraday = parsed.filter(d => d.date === latestDate);
    if (intraday.length < 2) return { code: 500, msg: "今日数据不足" };

    const result = intraday.map(d => ({
      time: d.time,
      close: d.close,
      changeRate: d.changeRate,
    }));

    return { code: 0, msg: "success", data: result };
  } catch (e) {
    console.error("获取分时数据失败:", e.message);
    return { code: 500, msg: "获取分时数据失败" };
  }
};
