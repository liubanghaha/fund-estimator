const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode, pageSize = 30 } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const list = await fetchHistory(fundCode, pageSize);
    return { code: 0, msg: "success", data: list };
  } catch (e) {
    console.error("获取历史净值失败:", e.message || e);
    return { code: 500, msg: "获取历史净值失败" };
  }
};

function fetchHistory(fundCode, pageSize) {
  const https = require("https");
  const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=${pageSize}`;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=${pageSize}`,
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    };
    https.get(options, (res) => {
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
          reject(e);
        }
      });
    }).on("error", reject);
  });
};
