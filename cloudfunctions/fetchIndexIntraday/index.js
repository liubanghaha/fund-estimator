const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SYMBOL_MAP = {
  "000001": "sh000001",
  "399001": "sz399001",
  "000300": "sh000300",
  "399006": "sz399006",
};

exports.main = async (event) => {
  const { indexCode } = event;
  const symbol = SYMBOL_MAP[indexCode] || "sh000001";

  try {
    // 取 2 天新浪 5 分钟 K 线（96 根），从里面分离昨收和今日数据
    let allData = await fetchSinaKline(symbol, 5, 96);
    if (!allData || allData.length < 2) {
      return { code: 500, msg: "无分时数据" };
    }

    // 按日期分组，取最新两天
    const byDate = {};
    allData.forEach(d => {
      if (!byDate[d._date]) byDate[d._date] = [];
      byDate[d._date].push(d);
    });
    const dates = Object.keys(byDate).sort();
    if (dates.length < 1) return { code: 500, msg: "日期数据异常" };

    // 最新日期 = 今天的数据
    const todayDate = dates[dates.length - 1];
    const intraday = byDate[todayDate];
    if (!intraday || intraday.length < 2) return { code: 500, msg: "今日数据不足" };

    // 昨收 = 倒数第二个日期的最后一条收盘价
    let prevClose = 0;
    if (dates.length >= 2) {
      const yesterdayData = byDate[dates[dates.length - 2]];
      prevClose = yesterdayData[yesterdayData.length - 1].close;
    }
    if (!prevClose) {
      prevClose = intraday[0].close;
    }

    console.log("昨收:", prevClose, "今日日期:", todayDate, "条数:", intraday.length);

    const result = intraday.map(d => ({
      time: d.time,
      close: d.close,
      changeRate: prevClose ? +((d.close / prevClose - 1) * 100).toFixed(2) : 0,
    }));

    return { code: 0, msg: "success", data: result };
  } catch (e) {
    console.error("获取分时数据失败:", e.message);
    return { code: 500, msg: "获取分时数据失败" };
  }
};

// 新浪 K 线
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
          const list = json.map(item => {
            const day = item.day || "";
            return {
              time: day.length >= 16 ? day.slice(11, 16) : day,
              _date: day.slice(0, 10),
              close: parseFloat(item.close) || 0,
              changeRate: 0,
            };
          }).filter(d => d.time && d.time.length === 5 && d._date);
          console.log("新浪解析条数:", list.length, "日期数:", new Set(list.map(d => d._date)).size);
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
