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
    // 逐基金取最新记录：定时任务可能只写完部分基金（超时截断），
    // 直接按 date 降序取本基金最新温度——永远与列表页 getPortfolio 同源
    const res = await db.collection("fund_temperatures")
      .where({ fundCode })
      .orderBy("date", "desc").limit(1)
      .field({ signal: true, label: true, normPE: true, weightedPE: true, coverage: true, stocksWithData: true, totalStocks: true, warnings: true, isETF: true })
      .get();
    if (res.data && res.data.length > 0) {
      const t = res.data[0];
      return {
        signal: t.signal,
        label: ft.sanitizeLabel(t.label),
        normPE: t.normPE,
        weightedPE: t.weightedPE,
        coverage: t.coverage,
        stocksWithData: t.stocksWithData,
        totalStocks: t.totalStocks,
        warnings: t.warnings || [],
        isETF: t.isETF || false,
      };
    }
  } catch (e) { /* ignore */ }
  // 缺失温度不做请求内重计算（每只持仓股一个 HTTP 会拖垮请求），凌晨定时任务会补全
  return null;
}
