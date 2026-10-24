const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 搜索结果内存缓存（2026-10-24）：同实例 5 分钟内同关键词直接回，不打东财。
// 搜索是高频操作（165 次/周），热门词重复率极高；冷启动后缓存自然重建
const _searchCache = new Map(); // kw -> { ts, data }
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };
  const { keyword } = event;
  if (!keyword || !keyword.trim()) {
    return { code: 400, msg: "请输入关键词", data: [] };
  }

  const kw = keyword.trim();

  // 缓存命中直接返回（含 degraded 的失败结果不缓存）
  const hit = _searchCache.get(kw);
  if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) {
    return { ...hit.data, fromCache: true };
  }

  // 6位数字 → 代码查询
  if (/^\d{6}$/.test(kw)) {
    try {
      const result = await lookUpFund(kw);
      if (result) {
        const out = { code: 0, msg: "success", data: [result] };
        _searchCache.set(kw, { ts: Date.now(), data: out });
        return out;
      }
      return { code: 404, msg: "未找到该基金", data: [] };
    } catch (e) {
      // 超时/网络错误与"无结果"区分：degraded=true 时客户端提示"搜索服务暂时不可用"而非"无结果"
      console.error("搜索失败:", e.message || e);
      return { code: 0, data: [], degraded: true };
    }
  }

  // 非数字 → 名称搜索
  try {
    const results = await searchByName(kw);
    const out = { code: 0, msg: "success", data: results };
    if (_searchCache.size > 200) {
      const oldest = _searchCache.keys().next().value;
      _searchCache.delete(oldest);
    }
    _searchCache.set(kw, { ts: Date.now(), data: out });
    return out;
  } catch (e) {
    console.error("名称搜索失败:", e.message || e);
    return { code: 0, data: [], degraded: true };
  }
};

function searchByName(name) {
  const https = require("https");
  // searchapi.eastmoney.com 对 Node 运行时返回 JSONP，改用东财基金站搜索接口
  const encoded = encodeURIComponent(name);
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encoded}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => { res.setEncoding("utf8");
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
    // 超时/网络错误走 reject（与"无结果"的 resolve([]) 区分，由调用方转 degraded）
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", () => reject(new Error("network")));
  });
}

function lookUpFund(fundCode) {
  const https = require("https");
  // fundgz.1234567.com.cn 估值接口已失效（全部返回页面未找到）；
  // searchapi.eastmoney.com 对 Node 运行时返回 JSONP，统一改用东财基金站搜索接口
  const encoded = encodeURIComponent(fundCode);
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encoded}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => { res.setEncoding("utf8");
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
    // 超时/网络错误走 reject（与"未找到"的 resolve(null) 区分，由调用方转 degraded）
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", () => reject(new Error("network")));
  });
}
