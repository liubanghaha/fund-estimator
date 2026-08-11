const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { historyDays, testOpenid } = event || {};
  const uid = testOpenid || OPENID;
  if (!uid) return { code: 400, msg: "无用户标识" };
  const _startTime = Date.now();

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

    // 批量请求估值（N 合 1），再并行获取东方财富最新净值与历史净值
    // 历史净值合并为一次请求（max(60, historyDays)），内存拆分 nav60，避免重复拉取
    const codes = holdings.map((h) => h.fundCode);
    const tiantianMap = await computeSelfEstimates(codes);
    const needDays = Math.max(60, historyDays || 60);
    // 分批限并发（8 只/批 + 150ms 间隔），避免瞬时大量外部请求被风控
    const CONCURRENT = 8;
    const resultsList = [];
    for (let i = 0; i < holdings.length; i += CONCURRENT) {
      const batch = holdings.slice(i, i + CONCURRENT);
      const batchResults = await Promise.all(batch.map(async (h) => {
        try {
          const tiantian = tiantianMap[h.fundCode] || {};
          const [eastmoney, navHistoryAll] = await Promise.all([
            fd.fetchLatestNavEastMoney(h.fundCode),
            fd.fetchNAVHistory(h.fundCode, needDays),
          ]);
          return {
            h, tiantian,
            eastmoney,
            nav60: (navHistoryAll || []).slice(0, 60),
            navHistory: historyDays ? (navHistoryAll || []) : null,
          };
        } catch (e) {
          console.error(`获取基金 ${h.fundCode} 失败:`, e);
          return { h, tiantian: {}, eastmoney: {}, nav60: [], navHistory: [] };
        }
      }));
      resultsList.push(...batchResults);
      if (i + CONCURRENT < holdings.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

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

      // 昨日净值兜底链：东方财富 day-1 → 东方财富当前 → 数据库存储值
      const yesterdayNav = eastmoney.yesterdayNav || eastmoney.actualNav || h.nav || null;
      const yesterdayNavSafe = yesterdayNav || 0;

      let currentNav = eastmoney.actualNav || tiantian.nav || null;
      // 单只基金数据源全挂时降级：用昨日净值兜底，仍拿不到则置 null，
      // 绝不能让一只失败基金拖垮整个持仓接口
      if (!currentNav || currentNav <= 0) {
        currentNav = yesterdayNavSafe > 0 ? yesterdayNavSafe : null;
      }
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

      // 今日净值是否已公布（北京时间 = UTC，净值日期无时区问题）
      const now = new Date();
      const todayStr = fd.formatBJDate(now);
      const estimateUpdated = eastmoney.actualDate === todayStr;
      if (!estimateUpdated && tiantian.estimatedChangeRate != null) {
        console.log(`[enrich] ${h.fundCode} 使用自主估算 estChangeRate=${tiantian.estimatedChangeRate} todayStr=${todayStr} actualDate=${eastmoney.actualDate}`);
      }

      if (!estimateUpdated && tiantian.estimatedChangeRate != null && yesterdayNav != null) {
        // 今日净值未公布 → 自主估算模式：用持仓股实时涨跌加权计算
        todayProfitAmount = yesterdayNav * tiantian.estimatedChangeRate / 100 * shares;
        todayChangeRate = tiantian.estimatedChangeRate;
      } else if (currentNav != null && yesterdayNav != null && currentNav !== yesterdayNav) {
        // 今日净值已公布 → 精确模式
        todayProfitAmount = (currentNav - yesterdayNav) * shares;
        todayChangeRate = eastmoney.actualChangeRate || 0;
      } else {
        todayChangeRate = eastmoney.actualChangeRate || 0;
      }

      totalYesterdayMarket += yesterdayNavSafe * shares;
      if (tiantian.estimateTime) updateTime = tiantian.estimateTime;

      const costValue = buyPrice * shares;
      const marketValue = currentNav != null ? currentNav * shares : dbMarketValue;
      const totalReturn = marketValue - costValue;
      const totalReturnRate = costValue > 0 ? ((totalReturn / costValue) * 100) : 0;

      totalCost += costValue;
      totalMarket += marketValue;
      totalTodayProfit += todayProfitAmount;

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
          if (range > 0 && currentNav != null) position = Math.round(((currentNav - low) / range) * 100);
        }
      }

      enriched.push({
        ...h,
        shares,
        buyPrice,
        currentNav: currentNav != null ? currentNav.toFixed(4) : null,
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

    const today = fd.formatBJDate();

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
      // 20s 时间预算内才计算，避免重计算拖垮用户请求（凌晨定时任务会兜底补全）
      const missingCodes = codes.filter(c => !tempMap[c]);
      if (missingCodes.length > 0 && Date.now() - _startTime < 20000) {
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
          const cat = ft.classifyIndustryLabel(pe.industry, pe.name);
          industryMap[cat] = (industryMap[cat] || 0) + w;
          totalWeight += w;
        }
      }
      if (totalWeight > 0) {
        console.log(`[getPortfolio] 资产配置: enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount} totalWeight=${totalWeight.toFixed(0)} industries=${Object.keys(industryMap).length}`);
        const list = Object.entries(industryMap)
          .map(([industry, w]) => ({ industry, raw: (w / totalWeight) * 100 }))
          .sort((a, b) => b.raw - a.raw);
        // 分离「其他」与真实行业；top20 只排真实行业，其余全合并到一个「其他」
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
        const maxPercent = maxReal ? maxReal.percent : 0;
        const maxName = maxReal ? maxReal.industry : "";
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
      // 与统一信号阈值 0.75/1.25 对齐
      const tempScore = avgNormPE != null
        ? (avgNormPE < 0.75 ? 90 : avgNormPE < 1.0 ? 70 : avgNormPE < 1.25 ? 50 : 30)
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

    // ---- 快照兜底：定时任务（snapshotProfit）未写快照时，用户打开小程序也能留点 ----
    // 仅在交易时段补（与定时任务语义一致），距上一点 >= 5 分钟才写，避免高频请求刷库
    try {
      const _bj = new Date(Date.now() + 8 * 3600000);
      const _day = _bj.getUTCDay();
      const _min = _bj.getUTCHours() * 60 + _bj.getUTCMinutes();
      const _inTrading = _day >= 1 && _day <= 5 && ((_min >= 570 && _min < 690) || (_min >= 780 && _min <= 900));
      if (_inTrading) {
        const _last = intradaySnapshots[intradaySnapshots.length - 1];
        const _lastMin = _last ? parseInt(_last.time.slice(0, 2)) * 60 + parseInt(_last.time.slice(3, 5)) : -Infinity;
        if (_min - _lastMin >= 5) {
          const _time = `${String(_bj.getUTCHours()).padStart(2, "0")}:${String(_bj.getUTCMinutes()).padStart(2, "0")}`;
          const _rate = +todayProfitRate.toFixed(2);
          const _doc = await db.collection("profit_snapshots").where({ _openid: uid, date: today }).get();
          if (_doc.data && _doc.data.length > 0) {
            await db.collection("profit_snapshots").doc(_doc.data[0]._id).update({
              data: { points: _.push({ time: _time, rate: _rate }) },
            });
          } else {
            await db.collection("profit_snapshots").add({
              data: { _openid: uid, date: today, points: [{ time: _time, rate: _rate }] },
            });
          }
          intradaySnapshots.push({ time: _time, rate: _rate });
          intradaySnapshots.sort((a, b) => a.time.localeCompare(b.time));
        }
      }
    } catch (e) { console.warn("[getPortfolio] 快照兜底失败:", e.message); }

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

// ---- 模块级持仓缓存（同一容器实例内复用，避免高频轮询重复抓取） ----
let _holdingsCache = {};
let _holdingsCacheTime = 0;
const HOLDINGS_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function getCachedHoldings(code) {
  const now = Date.now();
  if (now - _holdingsCacheTime > HOLDINGS_CACHE_TTL) {
    _holdingsCache = {};
    _holdingsCacheTime = now;
  }
  if (!_holdingsCache[code]) {
    _holdingsCache[code] = await fd.fetchTempHoldingsDeep(code);
  }
  return _holdingsCache[code] || [];
}

// ---- 自主计算基金估算涨跌（取代已下线的天天基金 API） ----
async function computeSelfEstimates(codes) {
  const map = {};
  if (!codes || codes.length === 0) return map;

  // 仅工作日计算（周一至周五），不限时段
  // 盘中用实时股价，盘后用收盘价，净值公布后 enrichment 自动切到精确值
  if (!fd.isBJWeekday()) {
    console.log(`[computeSelfEstimates] 周末, 跳过自主估算`);
    return map;
  }
  console.log(`[computeSelfEstimates] 工作日，开始计算 ${codes.length} 只基金`);

  try {
    // 1. 并发拉取所有基金的持仓（限流 10 只/批）
    const CONCURRENT = 10;
    const fundHoldingsMap = {};
    for (let i = 0; i < codes.length; i += CONCURRENT) {
      const batch = codes.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const holdings = await getCachedHoldings(code);
          return { code, holdings, ok: holdings && holdings.length > 0 };
        } catch (e) { return { code, holdings: [], ok: false }; }
      }));
      results.forEach(r => { if (r.ok) fundHoldingsMap[r.code] = r.holdings; });
      if (i + CONCURRENT < codes.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 2. 收集所有持仓股代码
    const stockSet = new Set();
    for (const holdings of Object.values(fundHoldingsMap)) {
      holdings.forEach(h => {
        if (h.stockCode && h.stockCode.length >= 4) stockSet.add(h.stockCode);
      });
    }
    const stockCodes = [...stockSet];

    // 3. 批量查腾讯实时行情（全球股票：A股/港股/美股）
    const stockPriceMap = stockCodes.length > 0 ? await fd.fetchStockPricesTencent(stockCodes) : {};

    // 4. 逐基金计算加权涨跌
    const timeStr = fd.formatBJTime();
    for (const code of codes) {
      const holdings = fundHoldingsMap[code];
      if (!holdings || holdings.length === 0) continue;

      let totalRatio = 0, weightedChange = 0;
      for (const h of holdings) {
        const price = stockPriceMap[h.stockCode];
        if (!price || price.changeRate == null) continue;
        totalRatio += h.navRatio;
        weightedChange += price.changeRate * h.navRatio;
      }

      if (totalRatio > 0) {
        const estChange = +(weightedChange / totalRatio).toFixed(2);
        map[code] = {
          fundCode: code,
          fundName: "",
          nav: null,
          estimatedNav: null,
          estimatedChangeRate: estChange,
          estimateTime: timeStr,
          _coverage: +totalRatio.toFixed(1),
        };
      }
    }
  } catch (e) {
    console.error("自主估算失败:", e.message);
  }

  return map;
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
        const h = await fd.fetchTempHoldingsDeep(code);
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
  const stockMap = {};
  if (stockCodes.length > 0) {
    const [liveMap, histMap] = await Promise.all([
      ft.fetchStockLiveBatch(stockCodes),
      ft.fetchStockHistBatch(stockCodes),
    ]);
    stockCodes.forEach(code => {
      if (liveMap[code]) {
        stockMap[code] = {
          ...liveMap[code],
          peHistory: (histMap[code] && histMap[code].peYears) || [],
          pbHistory: (histMap[code] && histMap[code].pbYears) || [],
          totalYears: (histMap[code] && histMap[code].totalYears) || 0,
        };
      }
    });
  }

  // 3. 计算信号（统一阈值与定时任务一致）
  for (const [code, holdings] of Object.entries(fundHoldings)) {
    const result = ft.calcSignal(code, holdings, stockMap);
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
        warnings: result.warnings || [],
        createTime: new Date(),
      };
    }
  }

  // 4. 写入 DB 缓存
  if (Object.keys(map).length > 0) {
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

// ---- 从历史温度数据恢复持仓（东方财富拉取失败时兜底） ----
async function recoverTempHoldings(fundCodes) {
  const holdings = {};
  for (let d = 1; d <= 10; d++) {
    const targetDate = fd.formatBJDate(new Date(Date.now() - d * 86400000));
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length; i += BATCH) {
      const batch = fundCodes.slice(i, i + BATCH);
      const res = await db.collection("fund_temperatures")
        .where({ fundCode: _.in(batch), date: targetDate })
        .get();
      (res.data || []).forEach(t => {
        if (t.detailPEs && t.detailPEs.length > 0 && !holdings[t.fundCode]) {
          holdings[t.fundCode] = t.detailPEs.map(p => ({
            stockCode: p.code,
            stockName: p.name,
            navRatio: p.ratio,
          }));
        }
      });
    }
    if (Object.keys(holdings).length > 0) break;
  }
  return holdings;
}
