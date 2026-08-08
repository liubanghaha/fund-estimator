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
  // searchapi.eastmoney.com 对 Node 运行时返回 JSONP，改用东财基金站搜索接口
  const encoded = encodeURIComponent(name);
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encoded}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const datas = (json.Datas || []).map((d) => ({
            code: d.CODE,
            fundCode: d.CODE,
            fundName: d.NAME,
            name: d.NAME,
            fundType: d.CATEGORYDESC || "",
          }));
          resolve(datas);
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
  // fundgz.1234567.com.cn 估值接口已失效（全部返回页面未找到）；
  // searchapi.eastmoney.com 对 Node 运行时返回 JSONP，统一改用东财基金站搜索接口
  const encoded = encodeURIComponent(fundCode);
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encoded}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const datas = (json.Datas || []);
          const hit = datas.find((d) => String(d.CODE) === fundCode);
          if (hit) {
            resolve({
              fundCode: hit.CODE,
              fundName: hit.NAME,
              fundType: hit.CATEGORYDESC || "",
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}
