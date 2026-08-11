const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const [estimate, peTemp] = await Promise.all([
      fetchSelfEstimate(fundCode),
      fetchTemperature(fundCode),
    ]);
    return {
      code: 0, msg: "success",
      data: { ...estimate, peTemp },
    };
  } catch (e) {
    console.error("获取估值失败:", e.message);
    return { code: 500, msg: "获取估值失败" };
  }
};

async function fetchSelfEstimate(fundCode) {
  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await fd.fetchLatestNavEastMoney(fundCode);

  // 2. 自主估算：持仓股涨跌加权
  let selfChangeRate = null;
  if (fd.isBJWeekday()) {
    try {
      const holdings = await fd.fetchTempHoldings(fundCode);
      if (holdings && holdings.length > 0) {
        const stockCodes = [...new Set(holdings.map(h => h.stockCode).filter(Boolean))];
        const prices = stockCodes.length > 0 ? await fd.fetchStockPricesTencent(stockCodes) : {};
        let totalRatio = 0, weightedChange = 0;
        for (const h of holdings) {
          const p = prices[h.stockCode];
          if (!p || p.changeRate == null) continue;
          totalRatio += h.navRatio;
          weightedChange += p.changeRate * h.navRatio;
        }
        if (totalRatio > 0) selfChangeRate = +(weightedChange / totalRatio).toFixed(2);
      }
    } catch (e) { /* ignore */ }
  }

  // 3. 组装返回：净值已公布用精确值，否则用自主估算
  const todayStr = fd.formatBJDate();
  const estimateUpdated = em.actualDate === todayStr;

  // nav 要与 actualNav 保持一致，避免前端 selectChangeRate 误判
  const baseNav = estimateUpdated ? (em.yesterdayNav || em.actualNav) : em.actualNav;

  return {
    fundCode,
    nav: baseNav || em.actualNav || null,
    estimatedNav: null,
    estimatedChangeRate: !estimateUpdated && selfChangeRate != null ? selfChangeRate : (em.actualChangeRate || null),
    estimateTime: !estimateUpdated && selfChangeRate != null ? fd.formatBJTime() : "",
    actualNav: em.actualNav,
    actualDate: em.actualDate,
    actualChangeRate: em.actualChangeRate,
    yesterdayNav: em.yesterdayNav,
  };
}

async function fetchTemperature(fundCode) {
  try {
    const res = await db.collection("fund_temperatures")
      .where({ fundCode })
      .orderBy("createTime", "desc")
      .limit(1)
      .get();
    if (res.data && res.data.length > 0) {
      const t = res.data[0];
      return {
        signal: t.signal,
        label: t.label,
        normPE: t.normPE,
        weightedPE: t.weightedPE,
        coverage: t.coverage,
        stocksWithData: t.stocksWithData,
        totalStocks: t.totalStocks,
        detailPEs: t.detailPEs || [],
        warnings: t.warnings || [],
        isETF: t.isETF || false,
      };
    }
  } catch (e) { /* ignore */ }

  // 数据库中无记录，按需计算
  try {
    return await computeTempOnDemand(fundCode);
  } catch (e) { console.error("按需计算温度失败:", e.message); }
  return null;
}

async function computeTempOnDemand(fundCode) {
  // 1. 拉取持仓股
  const { holdings, fundName } = await fd.fetchTempHoldingsWithMeta(fundCode);
  if (!holdings || holdings.length === 0) return null;
  const isETF = ft.isETFByName(fundName);

  // 2. 收集股票代码
  const stockCodes = [...new Set(holdings.map(h => h.stockCode).filter(c => c && (c.length === 6 || c.length === 5)))];
  if (stockCodes.length === 0) return null;

  // 3. 拉取实时 PE/PB + 历史 PE
  const [liveMap, histMap] = await Promise.all([
    ft.fetchStockLiveBatch(stockCodes),
    ft.fetchStockHistBatch(stockCodes),
  ]);

  // 4. 组装 stockMap 并统一打分
  const stockMap = {};
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
  const result = ft.calcSignal(fundCode, holdings, stockMap);
  if (!result) return null;

  const doc = {
    signal: result.signal,
    label: result.label,
    normPE: result.normPE,
    weightedPE: result.weightedPE,
    coverage: result.coverage,
    stocksWithData: result.stocksWithData,
    totalStocks: result.totalStocks,
    detailPEs: result.detailPEs,
    warnings: result.warnings || [],
    isETF,
  };

  // 写入 DB 缓存
  try {
    const today = fd.formatBJDate();
    await db.collection("fund_temperatures").add({
      data: { fundCode, date: today, ...doc, createTime: new Date() },
    }).catch(() => {});
  } catch (e) { /* ignore */ }

  return doc;
}
