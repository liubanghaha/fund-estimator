const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 获取基金同类排名
 */
exports.main = async (event) => {
  const { fundCode, fundType } = event;
  if (!fundCode) return { code: 400, msg: "缺少基金代码" };

  const https = require("https");

  // 确定基金类型代码
  const typeMap = { "股票型": "gp", "混合型": "hh", "债券型": "zq", "指数型": "zs", "QDII": "qdii" };
  const ft = typeMap[fundType] || "all";

  try {
    // 按近1年收益排名
    const rankData = await fetchRankData(fundCode, ft);
    return { code: 0, data: rankData };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
};

function fetchRankData(fundCode, ft) {
  const https = require("https");
  const url = `https://api.fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=500&v=0.1&_=${Date.now()}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Referer: "https://fund.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          // 解析 JSONP
          const jsonStr = body.replace(/^var rankData = /, "").replace(/;?$/, "");
          const data = JSON.parse(jsonStr);
          const list = (data && data.datas) || [];
          const allRecords = data.allRecords || list.length;

          // 找到本基金位置
          let rank = 0;
          for (const item of list) {
            const codes = (item.split(",")[0] || "").split("|");
            if (codes.includes(fundCode)) { rank = codes[0] === fundCode ? (list.indexOf(item) + 1) : rank; break; }
          }
          // 如果没找到，可能是两份额基金代码
          if (rank === 0) {
            for (const item of list) {
              const codes = (item.split(",")[0] || "");
              if (codes.includes(fundCode)) { rank = list.indexOf(item) + 1; break; }
            }
          }

          resolve({
            rank: rank || ">500",
            total: allRecords,
            pct: rank > 0 ? Math.round((1 - rank / allRecords) * 100) : 0,
            category: data.title || ft,
          });
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}