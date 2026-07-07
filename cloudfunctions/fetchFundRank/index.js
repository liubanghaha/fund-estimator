const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 获取基金同类排名（按近1年收益）
 * 东方财富移动端 API 不支持按类型过滤，手动根据 FUNDTYPE 字段筛选
 */
exports.main = async (event) => {
  const { fundCode, fundType } = event;
  if (!fundCode) return { code: 400, msg: "缺少基金代码" };

  // 类型中文 → FUNDTYPE 代码映射
  const ftMap = { "股票": "001", "混合": "002", "债券": "003", "指数": "005", "QDII": "007" };
  let targetFt = "002"; // 默认混合型
  for (const k of Object.keys(ftMap)) {
    if ((fundType || "混合").includes(k)) { targetFt = ftMap[k]; break; }
  }

  // 估算同类型总数（基于首页分布比例 × 全局总数）
  // 实际总数需要遍历所有页，这里用估算值避免性能问题
  const ESTIMATED_TOTALS = { "001": 3200, "002": 21000, "003": 600, "005": 800, "007": 300 };

  try {
    const rank = await searchRank(fundCode, targetFt);
    const total = ESTIMATED_TOTALS[targetFt] || rank;
    return {
      code: 0,
      data: {
        rank: rank || `>${200 * 30}`,
        total: Math.max(total, rank > 0 ? rank : 0),
        pct: rank > 0 ? Math.round((1 - rank / total) * 100) : 0,
        category: fundType || "混合型",
      },
    };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
};

async function searchRank(fundCode, targetFt) {
  const https = require("https");
  const PAGE_SIZE = 30;
  const MAX_PAGES = 200; // 搜索前 6000 条

  const fetchPage = (page) => {
    return new Promise((resolve, reject) => {
      const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNRankNewList?pageIndex=${page}&pageSize=${PAGE_SIZE}&Sort=1nzf&SortOrder=desc&deviceid=wap&plat=Wap&product=EFund&version=2.0.0&_=${Date.now()}`;
      https.get(url, {
        headers: { Referer: "https://fund.eastmoney.com/" },
      }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body).Datas || []);
          } catch (e) { resolve([]); }
        });
      }).on("error", () => resolve([])).setTimeout(8000, () => resolve([]));
    });
  };

  // 分批并行请求（每批 20 页，避免同时请求太多）
  let sameTypeCount = 0;
  for (let batch = 1; batch <= Math.ceil(MAX_PAGES / 20); batch++) {
    const start = (batch - 1) * 20 + 1;
    const end = Math.min(batch * 20, MAX_PAGES);
    const pages = [];
    for (let i = start; i <= end; i++) pages.push(i);

    const results = await Promise.all(pages.map(p => fetchPage(p)));

    for (const items of results) {
      for (const item of items) {
        if ((item.FUNDTYPE || "") === targetFt) {
          sameTypeCount++;
          if (item.FCODE === fundCode) return sameTypeCount;
        }
      }
    }
  }
  return 0; // 未在前 6000 条中找到
}
