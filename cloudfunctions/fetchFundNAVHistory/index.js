const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode, days = 80 } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const list = await fetchHistory(fundCode, days);
    return { code: 0, msg: "success", data: list };
  } catch (e) {
    console.error("获取历史净值失败:", e.message || e);
    return { code: 500, msg: "获取历史净值失败" };
  }
};

async function fetchHistory(fundCode, totalNeeded) {
  const https = require("https");
  const PER_PAGE = 20;
  const pages = Math.ceil(totalNeeded / PER_PAGE);

  const pageTasks = Array.from({ length: pages }, (_, i) =>
    new Promise((resolve) => {
      const path = `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=${i + 1}&pageSize=${PER_PAGE}`;
      const req = https.get({
        hostname: "api.fund.eastmoney.com",
        path,
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
      req.setTimeout(8000, () => { req.destroy(); resolve([]); });
      req.on("error", () => resolve([]));
    })
  );

  const results = await Promise.all(pageTasks);
  return results.flat();
}
