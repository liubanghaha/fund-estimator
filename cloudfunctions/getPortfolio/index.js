const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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
          const promises = [fetchEastMoney(h.fundCode), fetchNAVHistory(h.fundCode, 60)];
          if (historyDays && historyDays !== 60) promises.push(fetchNAVHistory(h.fundCode, historyDays));
          const results = await Promise.all(promises);
          return {
            h, tiantian,
            eastmoney: results[0],
            nav60: results[1] || [],
            navHistory: historyDays ? (results[2] || results[1]) : null,
          };
        } catch (e) {
          console.error(`获取基金 ${h.fundCode} 失败:`, e);
          return { h, tiantian: {}, eastmoney: {}, nav60: [], navHistory: [] };
        }
      })
    );

    const enriched = [];
    let totalMarket = 0;

    for (const { h, tiantian, eastmoney, navHistory, nav60 } of resultsList) {
      // 向后兼容：旧数据用 amount/nav 字段，新数据用 shares/buyPrice
      let shares = h.shares || h.amount || 0;
      let buyPrice = h.buyPrice || h.nav || 0;
      const dbMarketValue = h.marketValue || 0;
      const dbHoldingReturn = h.holdingReturn || 0;

      let currentNav = eastmoney.actualNav || tiantian.nav || buyPrice;
      let todayChangeRate = 0;
      let todayProfitAmount = 0;

      if (historyDays && navHistory) {
        navHistoryMap[h.fundCode] = navHistory;
      }

      // OCR 导入兜底：当 shares 或 buyPrice 为 0 时，用 OCR 提取的市值/收益反推
      if ((!shares || !buyPrice) && dbMarketValue > 0 && currentNav > 0) {
        if (!shares) shares = dbMarketValue / currentNav;
        if (!buyPrice && shares > 0) {
          buyPrice = currentNav - (dbHoldingReturn / shares);
          if (buyPrice <= 0) buyPrice = currentNav;
        }
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
      const totalReturn = marketValue - costValue;
      const totalReturnRate = costValue > 0 ? ((totalReturn / costValue) * 100) : 0;

      totalCost += costValue;
      totalMarket += marketValue;
      totalTodayProfit += todayProfitAmount;

      // 判断当天实际净值是否已公布（eastmoney actualDate 为今天）
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const estimateUpdated = eastmoney.actualDate === todayStr;

      // 60 日位置信号
      let position = null, navHigh = null, navLow = null;
      if (nav60 && nav60.length >= 5) {
        const navs = nav60.map(d => d.nav || 0).filter(v => v > 0);
        if (navs.length >= 5) {
          const high = Math.max(...navs);
          const low = Math.min(...navs);
          navHigh = high;
          navLow = low;
          const range = high - low;
          if (range > 0) position = Math.round(((currentNav - low) / range) * 100);
        }
      }

      enriched.push({
        ...h,
        currentNav: currentNav.toFixed(4),
        marketValue: marketValue.toFixed(2),
        todayChangeRate: todayChangeRate.toFixed(2),
        todayProfit: todayProfitAmount.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        estimateUpdated,
        position,
        navHigh: navHigh != null ? navHigh.toFixed(4) : null,
        navLow: navLow != null ? navLow.toFixed(4) : null,
      });
    }

    const todayProfitRate = totalYesterdayMarket > 0 ? ((totalTodayProfit / totalYesterdayMarket) * 100) : 0;
    const totalReturn = totalMarket - totalCost;
    const totalReturnRate = totalCost > 0 ? ((totalReturn / totalCost) * 100) : 0;

    const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;

    // 按当日收益金额倒序排序
    enriched.sort((a, b) => parseFloat(b.todayProfit) - parseFloat(a.todayProfit));

    // 读取 PE 温度缓存（由 computeFundTemperature 定时写入）
    let tempMap = {};
    try {
        const codes = enriched.map(h => h.fundCode);
        const tempRes = await db.collection("fund_temperatures")
          .where({ fundCode: _.in(codes), date: today })
          .get();
        (tempRes.data || []).forEach(t => { tempMap[t.fundCode] = t; });
        enriched.forEach(h => {
          const t = tempMap[h.fundCode];
          if (t) {
            h.peTemp = {
              signal: t.signal,
              label: t.label,
              normPE: t.normPE,
              weightedPE: t.weightedPE,
              coverage: t.coverage,
              stocksWith52w: t.stocksWith52w,
              totalStocks: t.totalStocks,
            };
          }
        });
      } catch (e) { console.warn("[getPortfolio] 读取 PE 温度失败:", e.message); }

    // 查询当天收益快照
    let intradaySnapshots = [];
    let snapDebug = {};
    try {
      const snapRes = await db.collection("profit_snapshots").where({ _openid: OPENID, date: today }).get();
      snapDebug = { openid: OPENID, date: today, found: snapRes.data ? snapRes.data.length : 0 };
      if (snapRes.data && snapRes.data.length > 0) {
        intradaySnapshots = snapRes.data[0].points || [];
        snapDebug.points = intradaySnapshots.length;
      }
    } catch (e) { snapDebug = { error: e.message }; }

    // 资产配置：按行业聚合持仓穿透
    let assetAllocation = null;
    try {
      let enrichedCount = 0, withTempCount = 0, withDetailCount = 0;
      const industryMap = {};
      let totalWeight = 0;
      for (const h of enriched) {
        if (!h.peTemp || !h.peTemp.totalStocks) continue;
        enrichedCount++;
        const fundValue = (h.shares || 0) * (h.currentNav || 0);
        if (fundValue <= 0) continue;
        withTempCount++;
        const t = tempMap[h.fundCode];
        if (!t || !t.detailPEs || !t.detailPEs.length) continue;
        withDetailCount++;
        for (const pe of t.detailPEs) {
          const w = fundValue * (pe.ratio / 100);
          industryMap[pe.industry] = (industryMap[pe.industry] || 0) + w;
          totalWeight += w;
        }
      }
      if (totalWeight > 0) {
        console.log(`[getPortfolio] 资产配置: enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount} totalWeight=${totalWeight.toFixed(0)} industries=${Object.keys(industryMap).length}`);
        const list = Object.entries(industryMap)
          .map(([industry, w]) => ({ industry, percent: +((w / totalWeight) * 100).toFixed(1) }))
          .sort((a, b) => b.percent - a.percent);
        const top10 = list.slice(0, 10);
        const others = list.slice(10).reduce((s, i) => s + i.percent, 0);
        if (others > 0) top10.push({ industry: "其他", percent: +others.toFixed(1) });
        const maxPercent = top10[0]?.percent || 0;
        assetAllocation = {
          items: top10,
          warning: maxPercent > 30 ? `单一行业「${top10[0].industry}」占比 ${maxPercent}%，建议分散配置` : null,
        };
      } else {
        console.log(`[getPortfolio] 资产配置: 无有效数据 enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount}`);
      }
    } catch (e) { console.error("[getPortfolio] 资产配置失败:", e.message, e.stack); assetAllocation = null; }

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
        intradaySnapshots,
        snapDebug,
        assetAllocation,
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

  return Promise.all(
    Array.from({ length: pages }, (_, i) => fetchPage(i + 1))
  ).then((results) => results.flat());
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
