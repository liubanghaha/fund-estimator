const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { historyDays } = event || {};

  try {
    const res = await db.collection("holdings").where({ _openid: OPENID }).get();
    const holdings = res.data || [];

    if (holdings.length === 0) {
      return {
        code: 0,
        data: { holdings: [], totalAmount: "0.00", todayProfit: "0.00",
          todayProfitRate: "0.00", totalReturn: "0.00", totalReturnRate: "0.00", updateTime: "" },
      };
    }

    let totalCost = 0, totalYesterdayMarket = 0, totalTodayProfit = 0;
    let updateTime = "";
    const navHistoryMap = {};

    // 批量请求天天基金估值（N 合 1），再并行获取东方财富最新净值
    const codes = holdings.map((h) => h.fundCode);
    const tiantianMap = await batchFetchTiantian(codes);
    const resultsList = await Promise.all(
      holdings.map(async (h) => {
        try {
          const tiantian = tiantianMap[h.fundCode] || {};
          const promises = [fetchEastMoney(h.fundCode)];
          if (historyDays) promises.push(fetchNAVHistory(h.fundCode, historyDays));
          const results = await Promise.all(promises);
          return { h, tiantian, eastmoney: results[0], navHistory: historyDays ? results[1] : null };
        } catch (e) {
          console.error(`获取基金 ${h.fundCode} 失败:`, e);
          return { h, tiantian: {}, eastmoney: {}, navHistory: [] };
        }
      })
    );

    const enriched = [];
    let totalMarket = 0;

    for (const { h, tiantian, eastmoney, navHistory } of resultsList) {
      // 向后兼容：旧数据用 amount/nav 字段，新数据用 shares/buyPrice
      const shares = h.shares || h.amount || 0;
      const buyPrice = h.buyPrice || h.nav || 0;

      let currentNav = eastmoney.actualNav || tiantian.nav || buyPrice;
      let todayChangeRate = 0;
      let todayProfitAmount = 0;

      if (historyDays && navHistory) {
        navHistoryMap[h.fundCode] = navHistory;
      }

      const yesterdayNav = tiantian.nav;

      if (eastmoney.actualNav != null && yesterdayNav != null && eastmoney.actualNav !== yesterdayNav) {
        todayProfitAmount = (eastmoney.actualNav - yesterdayNav) * shares;
        todayChangeRate = eastmoney.actualChangeRate || 0;
      } else if (tiantian.estimatedNav != null && yesterdayNav != null) {
        todayProfitAmount = (tiantian.estimatedNav - yesterdayNav) * shares;
        todayChangeRate = tiantian.estimatedChangeRate || 0;
      } else {
        todayChangeRate = eastmoney.actualChangeRate || 0;
      }

      totalYesterdayMarket += (yesterdayNav || currentNav) * shares;
      if (tiantian.estimateTime) updateTime = tiantian.estimateTime;

      const costValue = buyPrice * shares;
      const marketValue = currentNav * shares;
      const totalReturn = h.holdingReturn || (marketValue - costValue);
      const totalReturnRate = costValue > 0 ? ((totalReturn / costValue) * 100) : 0;

      totalCost += costValue;
      totalMarket += marketValue;
      totalTodayProfit += todayProfitAmount;

      // 判断当天实际净值是否已公布（eastmoney actualDate 为今天）
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const estimateUpdated = eastmoney.actualDate === todayStr;

      enriched.push({
        ...h,
        currentNav: currentNav.toFixed(4),
        marketValue: marketValue.toFixed(2),
        todayChangeRate: todayChangeRate.toFixed(2),
        todayProfit: todayProfitAmount.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        estimateUpdated,
      });
    }

    const todayProfitRate = totalYesterdayMarket > 0 ? ((totalTodayProfit / totalYesterdayMarket) * 100) : 0;
    const totalReturn = totalMarket - totalCost;
    const totalReturnRate = totalCost > 0 ? ((totalReturn / totalCost) * 100) : 0;

    // 按当日收益金额倒序排序
    enriched.sort((a, b) => parseFloat(b.todayProfit) - parseFloat(a.todayProfit));

    return {
      code: 0,
      data: {
        holdings: enriched,
        totalAmount: totalMarket.toFixed(2),
        todayProfit: totalTodayProfit.toFixed(2),
        todayProfitRate: todayProfitRate.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        updateTime,
        navHistoryMap: historyDays ? navHistoryMap : undefined,
      },
    };
  } catch (e) {
    console.error("获取持仓失败:", e);
    return { code: 500, msg: "获取持仓失败" };
  }
};

async function batchFetchTiantian(codes) {
  const https = require("https");
  const map = {};
  if (!codes || codes.length === 0) return map;

  // 批量请求：逗号分隔多基金代码，N 合 1
  const batchCode = codes.join(",");
  const batchResult = await new Promise((resolve) => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${batchCode}.js`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          // 批量返回格式：jsonpgzs({fundcode:{...}, fundcode:{...}})
          const clean = body.replace(/^jsonpgzs\(/, "").replace(/\)\;?$/, "").trim();
          const obj = JSON.parse(clean);
          resolve(typeof obj === "object" && !Array.isArray(obj) ? obj : {});
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });

  // 解析批量结果
  for (const [code, data] of Object.entries(batchResult)) {
    if (data && typeof data === "object") {
      map[code] = {
        fundCode: data.fundcode || code,
        fundName: data.name || "",
        nav: parseFloat(data.dwjz) || null,
        estimatedNav: parseFloat(data.gsz) || null,
        estimatedChangeRate: parseFloat(data.gszzl) || null,
        estimateTime: data.gztime || "",
      };
    }
  }

  // 对批量请求中缺失的基金，逐个回退请求
  const missing = codes.filter((c) => !map[c]);
  if (missing.length > 0) {
    const fallbacks = await Promise.all(missing.map((c) => fetchTiantian(c)));
    missing.forEach((c, i) => { map[c] = fallbacks[i]; });
  }

  return map;
}

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

function fetchNAVHistory(fundCode, totalNeeded) {
  const https = require("https");
  const PER_PAGE = 20;
  const pages = Math.ceil(totalNeeded / PER_PAGE);
  const allList = [];

  const fetchPage = (pageIndex) => new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=${PER_PAGE}`,
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
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });

  return (async () => {
    for (let i = 1; i <= pages; i++) {
      const pageData = await fetchPage(i);
      if (pageData.length === 0) break;
      allList.push(...pageData);
      if (pageData.length < PER_PAGE) break;
    }
    return allList;
  })();
}

function fetchEastMoney(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
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
            console.error("东方财富解析失败:", e.message);
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
}
