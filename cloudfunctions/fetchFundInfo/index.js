const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 获取基金基本信息
exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) {
    return { code: 400, msg: "请提供基金代码" };
  }

  try {
    const resp = await fetchFundDetail(fundCode);
    return { code: 0, msg: "success", data: resp };
  } catch (e) {
    console.error("获取基金信息失败:", e);
    return { code: 500, msg: "获取基金信息失败" };
  }
};

async function fetchFundDetail(fundCode) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const url = `https://fundgz.1234567.com.cn/js/${fundCode}.js`;
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            const jsonStr = body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, "");
            const data = JSON.parse(jsonStr);
            resolve({
              fundCode: data.fundcode,
              fundName: data.name,
              nav: parseFloat(data.dwjz) || null,
              lastNav: parseFloat(data.dwjz) || null,
              fundType: "off-market",
            });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}
