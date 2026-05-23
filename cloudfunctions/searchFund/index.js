const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { keyword } = event;
  if (!keyword || !keyword.trim()) {
    return { code: 400, msg: "请输入基金代码", data: [] };
  }

  const code = keyword.trim();
  // 基金代码都是6位数字
  if (!/^\d{6}$/.test(code)) {
    return { code: 400, msg: "请输入6位数字基金代码，如 000001", data: [] };
  }

  try {
    const result = await lookUpFund(code);
    if (result) {
      return { code: 0, msg: "success", data: [result] };
    }
    return { code: 404, msg: "未找到该基金", data: [] };
  } catch (e) {
    console.error("搜索失败:", e.message || e);
    return { code: 500, msg: "搜索失败，请重试", data: [] };
  }
};

function lookUpFund(fundCode) {
  const https = require("https");
  const url = `https://fundgz.1234567.com.cn/js/${fundCode}.js`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const jsonStr = body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, "");
          const data = JSON.parse(jsonStr);
          resolve({
            fundCode: data.fundcode,
            fundName: data.name,
            fundType: "off-market",
          });
        } catch (e) {
          resolve(null);
        }
      });
    }).on("error", reject);
  });
}
