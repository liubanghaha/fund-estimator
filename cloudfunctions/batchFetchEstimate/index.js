const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require("https");

function fetchOne(fundCode) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://fundgz.1234567.com.cn/js/${fundCode}.js`,
      { headers: { Referer: "https://fund.eastmoney.com/" } },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, ""));
            resolve({
              fundCode: json.fundcode,
              fundName: json.name,
              nav: parseFloat(json.dwjz) || null,
              estimatedNav: parseFloat(json.gsz) || null,
              estimatedChangeRate: parseFloat(json.gszzl) || null,
              estimateTime: json.gztime || "",
            });
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

exports.main = async (event) => {
  const { codes = [] } = event;
  if (!codes.length) return { code: 400, msg: "缺少基金代码" };

  try {
    const results = await Promise.all(codes.map((code) => fetchOne(code)));
    const data = {};
    results.forEach((r, i) => {
      data[codes[i]] = r;
    });
    return { code: 0, data };
  } catch (e) {
    console.error("批量获取估值失败:", e);
    return { code: 500, msg: "获取失败" };
  }
};
