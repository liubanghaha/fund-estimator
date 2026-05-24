const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const [estimate, actual] = await Promise.all([
      fetchTiantian(fundCode),
      fetchEastMoney(fundCode),
    ]);
    return {
      code: 0, msg: "success",
      data: { ...estimate, ...actual },
    };
  } catch (e) {
    console.error("获取基金估值失败:", JSON.stringify(e));
    return { code: 500, msg: "获取估值失败" };
  }
};

function fetchTiantian(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, (res) => {
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
          resolve({});
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", (e) => {
      console.error("天天基金请求失败:", e.message);
      resolve({});
    });
  });
}

function fetchEastMoney(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`;
    const req = https.get(
      {
        hostname: "api.fund.eastmoney.com",
        path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`,
        headers: { "Referer": "https://fundf10.eastmoney.com/" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
            const list = (json.Data && json.Data.LSJZList) || [];
            const today = list[0] || {};
            resolve({
              actualNav: parseFloat(today.DWJZ) || null,
              actualDate: today.FSRQ || "",
              actualChangeRate: parseFloat(today.JZZZL) || null,
            });
          } catch (e) {
            console.error("东方财富解析失败:", e.message, body.substring(0, 200));
            resolve({});
          }
        });
      }
    );
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", (e) => {
      console.error("东方财富请求失败:", e.message);
      resolve({});
    });
  });
};
