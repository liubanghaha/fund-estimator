const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { historyDays, testOpenid } = event || {};
  const uid = testOpenid || OPENID;
  if (!uid) return { code: 400, msg: "无用户标识" };

  try {
    const res = await db.collection("holdings").where({ _openid: uid }).get();
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
      // 向后兼容：旧数据用 amount/nav 字段（金额/净值），新数据用 shares/buyPrice
      let shares = h.shares || 0;
      let buyPrice = h.buyPrice || h.nav || 0;
      const dbMarketValue = h.marketValue || 0;
      const dbHoldingReturn = h.holdingReturn || 0;

      // 旧 schema { amount, nav } 修复：amount 是持仓金额不是份额
      if (!shares && h.amount && buyPrice > 0) {
        shares = parseFloat(h.amount) / buyPrice;
      }

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
        shares,
        buyPrice,
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

    // 读取 PE 温度缓存（由 computeFundTemperature 定时写入或本地按需计算）
    let tempMap = {};
    try {
      const codes = enriched.map(h => h.fundCode);
      const tempRes = await db.collection("fund_temperatures")
        .where({ fundCode: _.in(codes), date: today })
        .get();
      (tempRes.data || []).forEach(t => { tempMap[t.fundCode] = t; });

      // 对缺失温度的基金，按需计算（只算当前用户的持仓）
      const missingCodes = codes.filter(c => !tempMap[c]);
      if (missingCodes.length > 0) {
        console.log(`[getPortfolio] 按需计算温度: ${missingCodes.length} 只基金 ${missingCodes.join(',')}`);
        const computed = await computeTemperaturesForCodes(missingCodes, today);
        Object.assign(tempMap, computed);
      }

      enriched.forEach(h => {
        // 债基/货基不适用估值，清空所有估值相关字段
        if (/债|债券|纯债|转债|货币|货基/.test(h.fundName || "")) {
          h.peTemp = { signal: "nodata" };
          h.position = null;
          h.navHigh = null;
          h.navLow = null;
          return;
        }
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
      const snapRes = await db.collection("profit_snapshots").where({ _openid: uid, date: today }).get();
      snapDebug = { openid: uid, date: today, found: snapRes.data ? snapRes.data.length : 0 };
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
        const fundValue = (parseFloat(h.shares) || 0) * (parseFloat(h.currentNav) || 0);
        if (fundValue <= 0) continue;
        withTempCount++;
        const t = tempMap[h.fundCode];
        if (!t || !t.detailPEs || !t.detailPEs.length) continue;
        withDetailCount++;
        for (const pe of t.detailPEs) {
          const w = fundValue * (pe.ratio / 100);
          const cat = _classifyIndustry(pe.industry, pe.name);
          industryMap[cat] = (industryMap[cat] || 0) + w;
          totalWeight += w;
        }
      }
      if (totalWeight > 0) {
	        console.log(`[getPortfolio] 资产配置: enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount} totalWeight=${totalWeight.toFixed(0)} industries=${Object.keys(industryMap).length}`);
        const list = Object.entries(industryMap)
          .map(([industry, w]) => ({ industry, raw: (w / totalWeight) * 100 }))
          .sort((a, b) => b.raw - a.raw);
        // 分离「其他」与真实行业；top10 只排真实行业，其余全合并到一个「其他」
        const realList = list.filter(i => i.industry !== "其他");
        const otherRaw = list.filter(i => i.industry === "其他").reduce((s, i) => s + i.raw, 0);
        const top10 = realList.slice(0, 20).map(i => ({ industry: i.industry, percent: +i.raw.toFixed(1) }));
        const overflow = realList.slice(20).reduce((s, i) => s + i.raw, 0);
        const totalOthers = otherRaw + overflow;
        if (totalOthers > 0.05) top10.push({ industry: "其他", percent: +totalOthers.toFixed(1) });
        // 归一化
        const sum = top10.reduce((s, i) => s + i.percent, 0);
        if (top10.length > 0 && Math.abs(sum - 100) > 0.01) {
          top10[0].percent = +(top10[0].percent + (100 - sum)).toFixed(1);
        }
        const maxReal = top10.find(i => i.industry !== "其他");
        const maxPercent = maxReal?.percent || 0;
        const maxName = maxReal?.industry || "";
        assetAllocation = {
          items: top10,
          warning: maxPercent > 30 ? `单一行业「${maxName}」占比 ${maxPercent}%，建议分散配置` : null,
        };
      } else {
        console.log(`[getPortfolio] 资产配置: 无有效数据 enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount}`);
      }
    } catch (e) { console.error("[getPortfolio] 资产配置失败:", e.message, e.stack); assetAllocation = null; }

    // 持仓健康分
    let healthScore = null;
    try {
      const tempScores = [];
      enriched.forEach(h => {
        if (h.peTemp && h.peTemp.normPE > 0) tempScores.push(h.peTemp.normPE);
      });
      const avgNormPE = tempScores.length > 0 ? tempScores.reduce((a, b) => a + b, 0) / tempScores.length : null;
      const tempScore = avgNormPE != null
        ? (avgNormPE < 0.7 ? 90 : avgNormPE < 1.0 ? 70 : avgNormPE < 1.3 ? 50 : 30)
        : 50;
      const maxIndustry = assetAllocation && assetAllocation.items && assetAllocation.items.length > 0
        ? (assetAllocation.items.find(i => i.industry !== "其他") || assetAllocation.items[0]).percent : 0;
      const concScore = maxIndustry < 30 ? 90 : maxIndustry < 50 ? 70 : maxIndustry < 70 ? 50 : 30;
      const score = Math.round(tempScore * 0.5 + concScore * 0.5);
      const grade = score >= 80 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
      healthScore = { score, grade, avgNormPE: avgNormPE != null ? +avgNormPE.toFixed(2) : null, maxIndustry, tempScore, concScore };
    } catch (e) { console.error("[getPortfolio] 健康分计算失败:", e.message); }

    // 分组维度汇总
    const groupMap = {};
    enriched.forEach(h => {
      const g = h.group || "未分组";
      if (!groupMap[g]) {
        groupMap[g] = { name: g, count: 0, totalAmount: 0, todayProfit: 0, totalReturn: 0, todayProfitRate: 0, totalReturnRate: 0, yesterdayMarket: 0, totalCost: 0 };
      }
      groupMap[g].count++;
      groupMap[g].totalAmount += parseFloat(h.marketValue) || 0;
      groupMap[g].todayProfit += parseFloat(h.todayProfit) || 0;
      groupMap[g].totalReturn += parseFloat(h.totalReturn) || 0;
      // 累计昨日市值和总成本用于计算分组收益率
      const shares = parseFloat(h.shares) || 0;
      const buyPrice = parseFloat(h.buyPrice) || 0;
      const currentNav = parseFloat(h.currentNav) || 0;
      const todayChangeRate = parseFloat(h.todayChangeRate) || 0;
      if (shares > 0 && currentNav > 0) {
        const yesterdayNav = todayChangeRate !== 0 ? currentNav / (1 + todayChangeRate / 100) : currentNav;
        groupMap[g].yesterdayMarket += yesterdayNav * shares;
        groupMap[g].totalCost += buyPrice * shares;
      }
    });
    const groups = Object.values(groupMap).map(g => {
      const tpr = g.yesterdayMarket > 0 ? ((g.todayProfit / g.yesterdayMarket) * 100) : 0;
      const trr = g.totalCost > 0 ? ((g.totalReturn / g.totalCost) * 100) : 0;
      return {
        name: g.name,
        count: g.count,
        totalAmount: g.totalAmount.toFixed(2),
        todayProfit: g.todayProfit.toFixed(2),
        todayProfitRate: tpr.toFixed(2),
        totalReturn: g.totalReturn.toFixed(2),
        totalReturnRate: trr.toFixed(2),
      };
    });

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
        healthScore,
        groups,
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

// ---- 按需温度计算（仅算当前用户的持仓基金） ----

async function computeTemperaturesForCodes(fundCodes, today) {
  const map = {};
  const fundHoldings = {};

  // 1. 拉取持仓股（并发 10 只）
  const CONCURRENT = 10;
  for (let i = 0; i < fundCodes.length; i += CONCURRENT) {
    const batch = fundCodes.slice(i, i + CONCURRENT);
    const results = await Promise.all(batch.map(async (code) => {
      try {
        const h = await fetchTempHoldingsDeep(code);
        return { code, holdings: h, ok: h.length > 0 };
      } catch (e) { return { code, holdings: [], ok: false }; }
    }));
    results.forEach(r => { if (r.ok) fundHoldings[r.code] = r.holdings; });
    if (i + CONCURRENT < fundCodes.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // 持仓数据不足时从历史恢复
  if (Object.keys(fundHoldings).length === 0) {
    const recovered = await recoverTempHoldings(fundCodes);
    Object.assign(fundHoldings, recovered);
  }

  // 2. 收集股票代码 & 批量查 PE
  const stockSet = new Set();
  Object.values(fundHoldings).forEach(list => {
    list.forEach(h => {
      if (h.stockCode && (h.stockCode.length === 6 || h.stockCode.length === 5)) {
        stockSet.add(h.stockCode);
      }
    });
  });
  const stockCodes = [...stockSet];
  const stockMap = stockCodes.length > 0 ? await batchFetchTempLive(stockCodes) : {};
  if (stockCodes.length > 0) {
    const histMap = await batchFetchTempHist(stockCodes);
    stockCodes.forEach(code => {
      if (stockMap[code] && histMap[code]) {
        stockMap[code].peHistory = histMap[code].peYears || [];
        stockMap[code].pbHistory = histMap[code].pbYears || [];
        stockMap[code].totalYears = histMap[code].totalYears || 0;
      }
    });
  }

  // 3. 计算信号
  for (const [code, holdings] of Object.entries(fundHoldings)) {
    const result = calcTempSignal(code, holdings, stockMap);
    if (result) {
      map[code] = {
        fundCode: code,
        date: today,
        signal: result.signal,
        label: result.label,
        normPE: result.normPE,
        weightedPE: result.weightedPE,
        coverage: result.coverage,
        stocksWithData: result.stocksWithData,
        totalStocks: result.totalStocks,
        detailPEs: result.detailPEs,
        createTime: new Date(),
      };
    }
  }

  // 4. 写入 DB 缓存
  if (Object.keys(map).length > 0) {
    const db = cloud.database();
    for (const [code, data] of Object.entries(map)) {
      await db.collection("fund_temperatures")
        .where({ fundCode: code, date: today })
        .remove()
        .catch(() => {});
      await db.collection("fund_temperatures").add({ data }).catch(() => {});
    }
  }

  return map;
}

function fetchTempHoldings(fundCode) {
  const https = require("https");
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3, curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
    if (i === 0) { curY = year - 1; curM = 12; }
  }

  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=20&year=${curY}&month=${curM}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const html = match[1].replace(/\\"/g, '"');
          const rows = [];
          const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
          let trMatch;
          while ((trMatch = trRegex.exec(html)) !== null) {
            const tds = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
              tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            if (tds.length >= 7 && !tds[0].includes("*")) {
              const n = tds.length;
              rows.push({
                rank: tds[0],
                stockCode: tds[1],
                stockName: tds[2],
                navRatio: parseFloat(tds[n - 3]) || 0,
                shares: tds[n - 2],
                marketValue: tds[n - 1],
              });
            }
          }
          resolve(rows);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

// ETF 联接穿透：拿到的是 ETF 份额，需要穿透到 ETF 的持仓股
async function fetchTempHoldingsDeep(fundCode) {
  let holdings = await fetchTempHoldings(fundCode);
  if (!holdings || holdings.length === 0) return [];
  // 检查是否为 ETF 联接（持仓为 ETF 代码，非普通股票）
  // ETF 代码规则：5位(1xxxx/5xxxx/159xxx) 或 6位(51xxxx/56xxxx/58xxxx)
  const isEtfCode = (code) => /^(1\d{4}|5\d{4}|159\d{3}|51\d{4}|56\d{4}|58\d{4})$/.test(code);
  const etfCodes = holdings.filter(h => h.stockCode && isEtfCode(h.stockCode)).map(h => h.stockCode);
  // 仅当主要持仓是ETF份额时才穿透
  if (etfCodes.length > 0 && etfCodes.length >= holdings.length * 0.3) {
    console.log(`[getPortfolio] ETF联接穿透: fund=${fundCode} etf=${etfCodes[0]}`);
    const etfHoldings = await fetchTempHoldings(etfCodes[0]);
    if (etfHoldings && etfHoldings.length > 0) return etfHoldings;
  }
  return holdings;
}

async function batchFetchTempLive(codes) {
  let map = await _fetchLiveEastMoney(codes);
  let withPE = Object.values(map).filter(s => s.pe != null).length;
  console.log(`[batchFetchTempLive] 东方财富 PE 覆盖率: ${withPE}/${codes.length}`);

  if (withPE < codes.length * 0.5) {
    console.log(`[batchFetchTempLive] PE 覆盖率偏低，1秒后重试缺失的`);
    await new Promise(r => setTimeout(r, 1000));
    const missed = codes.filter(c => !map[c] || map[c].pe == null);
    const retryMap = await _fetchLiveEastMoney(missed);
    for (const [code, data] of Object.entries(retryMap)) {
      if (!map[code] || map[code].pe == null) map[code] = data;
    }
    withPE = Object.values(map).filter(s => s.pe != null).length;
    console.log(`[batchFetchTempLive] 重试后 PE 覆盖率: ${withPE}/${codes.length}`);
  }

  const missedCodes = codes.filter(c => !map[c] || map[c].pe == null);
  if (missedCodes.length > 0) {
    console.log(`[batchFetchTempLive] ${missedCodes.length} 只从腾讯财经兜底`);
    const tencentMap = await _fetchLiveTencent(missedCodes);
    for (const [code, data] of Object.entries(tencentMap)) {
      if (!map[code] || map[code].pe == null) map[code] = data;
    }
    withPE = Object.values(map).filter(s => s.pe != null).length;
    console.log(`[batchFetchTempLive] 兜底后 PE 覆盖率: ${withPE}/${codes.length}`);
  }

  return map;
}

async function _fetchLiveEastMoney(codes) {
  const https = require("https");
  const map = {};
  const BATCH = 40;
  const buildSecid = (code) => {
    if (code.length === 5) return `116.${code}`;
    if (code.startsWith("6")) return `1.${code}`;
    return `0.${code}`;
  };
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const secids = batch.map(buildSecid).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f9,f12,f100,f164&secids=${secids}`;
    await new Promise((resolve) => {
      const req = https.get(url, { headers: { Referer: "https://quote.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const data = JSON.parse(body).data;
            if (data && data.diff) {
              data.diff.forEach(item => {
                const pe = item.f9;
                if (pe !== undefined && pe !== null) {
                  const actualPE = pe > 500 ? pe / 100 : pe;
                  const pb = item.f164 != null ? (+item.f164) : null;
                  map[item.f12] = {
                    pe: actualPE,
                    pb: pb && pb > 0 ? pb : null,
                    price: item.f2 || null,
                    industry: item.f100 || "其他",
                  };
                }
              });
            }
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.setTimeout(12000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

async function _fetchLiveTencent(codes) {
  const http = require("http");
  const map = {};
  const BATCH = 20;
  const toQtCode = (code) => {
    if (code.length === 5) return `hk${code}`;
    if (code.startsWith("6")) return `sh${code}`;
    return `sz${code}`;
  };
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const qtCodes = batch.map(toQtCode).join(",");
    const url = `http://qt.gtimg.cn/q=${qtCodes}`;
    await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => { chunks.push(c); });
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            for (const code of batch) {
              const qtCode = toQtCode(code);
              const re = new RegExp(`v_${qtCode}="([^"]*)"`);
              const match = body.match(re);
              if (!match) continue;
              const fields = match[1].split("~");
              const pe = parseFloat(fields[39]) || null;
              const pb = parseFloat(fields[46]) || null;
              const price = parseFloat(fields[3]) || null;
              if (pe || pb || price) {
                map[code] = {
                  pe: pe && pe > 0 ? pe : null,
                  pb: pb && pb > 0 ? pb : null,
                  price: price,
                  industry: "其他",
                };
              }
            }
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

async function batchFetchTempHist(codes) {
  const https = require("https");
  const map = {};
  for (const code of codes) {
    await new Promise((resolve) => {
      const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_VALUE_ANALYSIS&columns=PEAVG,PEMAX,PEMIN,PBAVG,PBMAX,PBMIN&filter=(SECURITY_CODE=%22${code}%22)&pageSize=50&sortColumns=STARTDATE&sortTypes=1`;
      const req = https.get(url, { headers: { Referer: "https://data.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            const data = (d.result && d.result.data) || [];
            map[code] = {
              peYears: data.map(r => ({ avg: +r.PEAVG, max: +r.PEMAX, min: +r.PEMIN })).filter(r => r.avg > 0 && r.avg < 10000),
              pbYears: data.map(r => ({ avg: +r.PBAVG, max: +r.PBMAX, min: +r.PBMIN })).filter(r => r.avg > 0 && r.avg < 1000),
              totalYears: data.length,
            };
          } catch (e) { map[code] = { peYears: [], pbYears: [], totalYears: 0 }; }
          resolve();
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

function _classifyIndustry(industry) {
  const cyc = ["煤炭","钢铁","有色","石油","化工","稀土","黄金","铜","铝","海运","造船","矿石","建材","水泥","玻璃"];
  const fin = ["银行","保险","证券","地产","房地产","多元金融"];
  for (const kw of cyc) if (industry.includes(kw)) return "cycle";
  for (const kw of fin) if (industry.includes(kw)) return "finance";
  return "other";
}

function _pePct(currentPE, peYears) {
  if (!peYears || peYears.length < 3) return null;
  const avgs = peYears.map(y => y.avg).sort((a, b) => a - b);
  let below = 0;
  for (const a of avgs) { if (currentPE > a) below++; }
  return Math.round((below / avgs.length) * 100);
}

function calcTempSignal(fundCode, holdings, stockMap) {
  const MIN_COVERAGE = 20;
  let totalRatio = 0, totalScore = 0, stocksWithData = 0, totalStocks = 0;
  const detailPEs = [];

  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (!stock) return;
    totalStocks++;
    const iType = _classifyIndustry(stock.industry || "");
    let stockScore, note = "";

	    if (!stock.pe || stock.pe <= 0 || stock.pe > 500) {
	      if (stock.pb && stock.pb > 0 && iType === "finance") {
	        const pp = _pePct(stock.pb, stock.pbHistory);
	        stockScore = pp != null ? (pp < 25 ? 1.6 : pp < 65 ? 1.0 : 0.4) : 1.0;
	        note = pp != null ? `PB${pp}%分位(PE无效)` : "PE无效";
	      } else { stockScore = 1.0; note = "PE无效"; }
	    } else if (stock.pe > 80) {
	      const pePct = _pePct(stock.pe, stock.peHistory);
	      stockScore = 0.5;
	      note = `PE${stock.pe.toFixed(0)}倍·${pePct != null ? pePct + '%分位' : ''}`;
	    } else if (stock.pe > 50) {
	      const pePct = _pePct(stock.pe, stock.peHistory);
	      if (pePct != null && pePct < 40) {
	        stockScore = 0.7;
	        note = `PE${stock.pe.toFixed(0)}倍偏高·${pePct}%分位`;
	      } else {
	        stockScore = pePct != null ? (pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5) : 1.0;
	        note = pePct != null ? `PE${pePct}%分位` : "数据不足";
	      }
	    } else {
	      const pePct = _pePct(stock.pe, stock.peHistory);
	      if (pePct == null) { stockScore = 1.0; note = "数据不足"; }
	      else if (iType === "finance" && stock.pb && stock.pb > 0) {
	        const pp = _pePct(stock.pb, stock.pbHistory);
	        if (pp != null) {
	          stockScore = +((pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5) * 0.5 + (pp < 25 ? 1.5 : pp < 65 ? 1.0 : 0.5) * 0.5).toFixed(2);
	          note = `PE${pePct}%分位 PB${pp}%分位`;
	        } else { stockScore = pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5; note = `PE${pePct}%分位`; }
	      } else if (iType === "cycle" && pePct < 40) {
	        stockScore = pePct < 20 ? 1.4 : 1.0;
	        note = pePct != null ? `PE${pePct}%分位⚠️周期顶` : "";
	      } else {
	        stockScore = pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5;
	        note = `PE${pePct}%分位`;
	      }
	    }

    totalScore += stockScore * h.navRatio;
    totalRatio += h.navRatio;
    stocksWithData++;
    detailPEs.push({
      code: h.stockCode, name: h.stockName,
      pe: stock.pe ? +stock.pe.toFixed(2) : null,
      pb: stock.pb ? +stock.pb.toFixed(2) : null,
      industry: stock.industry, normPE: stockScore, ratio: h.navRatio, note,
    });
  });

  if (totalRatio < MIN_COVERAGE) return null;
  if (stocksWithData === 0) {
    let tp = 0;
    holdings.forEach(h => { const s = stockMap[h.stockCode]; if (s && s.pe > 0) tp += s.pe * h.navRatio; });
    return { fundCode, signal: "nodata", label: "--", normPE: 0, weightedPE: totalRatio > 0 ? +(tp / totalRatio).toFixed(2) : 0, coverage: +totalRatio.toFixed(1), stocksWithData: 0, totalStocks, detailPEs };
  }
  const avgScore = +(totalScore / totalRatio).toFixed(3);
  const normPE = +(2.0 - avgScore).toFixed(3);
  let tp = 0;
  holdings.forEach(h => { const s = stockMap[h.stockCode]; if (s && s.pe > 0) tp += s.pe * h.navRatio; });
  const wp = totalRatio > 0 ? +(tp / totalRatio).toFixed(2) : 0;
  let signal, label;
  if (normPE < 0.7) { signal = "low"; label = "低估"; }
  else if (normPE > 1.3) { signal = "high"; label = "高估"; }
  else { signal = "mid"; label = "正常"; }
  return { fundCode, signal, label, normPE, weightedPE: wp, coverage: +totalRatio.toFixed(1), stocksWithData, totalStocks, detailPEs };
}

async function recoverTempHoldings(fundCodes) {
  const holdings = {};
  const db = cloud.database();
  for (let d = 1; d <= 10; d++) {
    const targetDate = `${new Date(Date.now() - d * 86400000).getFullYear()}-${String(new Date(Date.now() - d * 86400000).getMonth() + 1).padStart(2, '0')}-${String(new Date(Date.now() - d * 86400000).getDate()).padStart(2, '0')}`;
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length; i += BATCH) {
      const batch = fundCodes.slice(i, i + BATCH);
      const res = await db.collection("fund_temperatures")
        .where({ fundCode: _.in(batch), date: targetDate })
        .get();
      (res.data || []).forEach(t => {
        if (t.detailPEs && t.detailPEs.length > 0 && !holdings[t.fundCode]) {
          holdings[t.fundCode] = t.detailPEs.map(p => ({
            stockCode: p.code, stockName: p.name, navRatio: p.ratio,
          }));
        }
      });
    }
    if (Object.keys(holdings).length > 0) break;
  }
	  return holdings;
}

// ---- 行业分类（与 computeFundTemperature 保持一致） ----
function _classifyIndustry(ind, stockName) {
  // 东方财富 f100 直接可用，仅对「其他」兜底
  if (ind && ind !== "其他" && ind !== "其它") return ind;
  // f100 为「其他」时用股票名匹配
  const labels = { tech: "科技", biomed: "医药", consume: "消费", finance: "金融", cycle: "周期", utility: "公用事业", mfg: "制造" };
  const map = {
    tech: ["半导体","芯片","软件","计算机","通信","电子","光模块","互联网","游戏","传媒","元件","IT","信息","数据","智能","科技"],
    biomed: ["医药","生物","医疗","中药","化学制药","器械","医"],
    consume: ["白酒","食品","饮料","家电","汽车","服装","旅游","零售","免税","调味品","乳业","养殖","消费","农业","牧原","酒店","餐饮","美妆","纺织"],
    finance: ["银行","保险","证券","地产","房地产","金融","信托","期货","基金"],
    cycle: ["煤炭","钢铁","有色","石油","化工","稀土","黄金","铜","铝","海运","造船","矿石","建材","水泥","玻璃","金属","纸","化纤","塑料","橡胶","化学"],
    utility: ["电力","水务","高速","公路","港口","铁路","燃气","环保","新能源发电","电网","核电","水"],
    mfg: ["机械","电气","新能源","电池","军工","航天","船舶","仪器仪表","电力设备","航空","光伏","风电","通用设备","专用设备","电源","装备","重工","锅炉","电机","自动化","机器人","电器"],
  };
  if (stockName) {
    for (const [cat, keywords] of Object.entries(map)) {
      for (const kw of keywords) {
        if (stockName.includes(kw)) return labels[cat];
      }
    }
  }
  return "其他";
}
