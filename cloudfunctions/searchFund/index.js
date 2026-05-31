const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { keyword } = event;
  if (!keyword || !keyword.trim()) {
    return { code: 400, msg: "请输入关键词", data: [] };
  }

  const kw = keyword.trim();

  // 6位数字 → 代码查询
  if (/^\d{6}$/.test(kw)) {
    try {
      const result = await lookUpFund(kw);
      if (result) return { code: 0, msg: "success", data: [result] };
      return { code: 404, msg: "未找到该基金", data: [] };
    } catch (e) {
      console.error("搜索失败:", e.message || e);
      return { code: 500, msg: "搜索失败，请重试", data: [] };
    }
  }

  // 非数字 → 名称搜索
  try {
    const results = await searchByName(kw);
    return { code: 0, msg: "success", data: results };
  } catch (e) {
    console.error("名称搜索失败:", e.message || e);
    return { code: 500, msg: "搜索失败，请重试", data: [] };
  }
};

function searchByName(name) {
  const https = require("https");
  const encoded = encodeURIComponent(name);
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encoded}&type=14&token=DGCE23MHKBN23AKDN23&count=5`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const datas = (json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];
          resolve(datas.map((d) => ({
            code: d.Code,
            fundCode: d.Code,
            fundName: d.Name,
            name: d.Name,
            fundType: d.SecurityTypeName || "",
          })));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function lookUpFund(fundCode) {
  const https = require("https");
  const url = `https://fundgz.1234567.com.cn/js/${fundCode}.js`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
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
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on("error", reject);
  });
}
