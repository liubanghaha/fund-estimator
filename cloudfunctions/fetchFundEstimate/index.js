const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const https = require("https");
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");

exports.main = async (event) => {
  const { fundCode, src } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const [estimate, peTemp] = await Promise.all([
      fetchSelfEstimate(fundCode, src),
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

// GZTIME 是否属于今日：兼容 "YYYY-MM-DD HH:mm:ss" 与 "MM-DD HH:mm:ss" 两种盘中格式
function _gdIsToday(gztime, todayStr) {
  const gd = String(gztime || "").trim();
  return gd.slice(0, 10) === todayStr || gd.slice(0, 5) === todayStr.slice(5);
}

// FundMNFInfo 官方估值字段（GSZ/GSZZL/GZTIME），独立小请求避免改动 _shared 批量同步；
// 净值未公布时返回估算值，公布后应使用 actualChangeRate
function fetchMNFEstimate(fundCode, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=wechat_est&Fcodes=${encodeURIComponent(fundCode)}`;
    const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/", "User-Agent": "Mozilla/5.0" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const it = (JSON.parse(Buffer.concat(chunks).toString("utf8")).Datas || [])[0] || {};
          resolve({
            gsz: it.GSZ != null && it.GSZ !== "--" ? parseFloat(it.GSZ) : null,
            gzhm: (String(it.GZTIME || "").match(/(\d{1,2}:\d{2})/) || [])[1] || "",
            gszzl: it.GSZZL != null && it.GSZZL !== "--" ? parseFloat(it.GSZZL) : null,
            gztime: it.GZTIME || null,
          });
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}

async function fetchSelfEstimate(fundCode, src) {
  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await fd.fetchLatestNavEastMoney(fundCode);
  const estSrc = src === "self" ? "self" : "em"; // 默认 em（东财官方优先）
  const todayStr = fd.formatBJDate();
  const estimateUpdated = em.actualDate === todayStr;

  // 净值已公布：估算请求无意义（官方 GSZZL 已清空），直接走真值短路，省两轮外部请求
  if (estimateUpdated) {
    const baseNav = em.yesterdayNav || em.actualNav;
    return {
      fundCode,
      nav: baseNav || em.actualNav || null,
      estimatedNav: null,
      estimatedChangeRate: em.actualChangeRate || null,
      estimateTime: "",
      source: "nav",
      actualNav: em.actualNav,
      actualDate: em.actualDate,
      actualChangeRate: em.actualChangeRate,
      yesterdayNav: em.yesterdayNav,
    };
  }

  // 2. 官方估值（FundMNFInfo GSZZL，盘中值；与天天基金 App 同口径）
  const mnf = await fetchMNFEstimate(fundCode);

  // 3. 自主估算：指数基金优先用跟踪指数实时行情，否则持仓股加权兜底
  let selfChangeRate = null;
  if (fd.isBJWeekday()) {
    // 2a) 指数优先：东财 INDEXCODE 覆盖所有指数基金（行业天然全覆盖），用指数实时涨跌幅估算。
    //     带 fund_index_cache 缓存：命中直接用，未命中才调东财并写回。
    try {
      const track = await fd.getTrackIndexCached(db, fundCode);
      if (track && track.indexCode) {
        const idx = await fd.fetchIndexRealtime(track.indexCode);
        if (idx && idx.changeRate != null) selfChangeRate = idx.changeRate;
      }
    } catch (e) { /* ignore */ }

    // 2b) 持仓加权兜底：非指数基金 / 指数行情失败时，用持仓股实时涨跌加权
    if (selfChangeRate == null) {
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
  }

  // 4. 组装（净值未公布）：按所选源优先（em=官方估值优先、self=自算优先），互相兜底后回退昨日涨幅
  const mnfToday = mnf.gztime != null && (_gdIsToday(mnf.gztime, todayStr)) && mnf.gszzl != null;

  let estRate, estTime, source;
  if (estSrc === "em" && mnfToday) {
    estRate = mnf.gszzl; estTime = mnf.gzhm || mnf.gztime; source = "em";
  } else if (selfChangeRate != null) {
    estRate = selfChangeRate; estTime = fd.formatBJTime(); source = "self";
  } else if (mnfToday) {
    estRate = mnf.gszzl; estTime = mnf.gzhm || mnf.gztime; source = "em";
  } else {
    estRate = em.actualChangeRate || null; estTime = ""; source = "nav";
  }

  // nav 要与 actualNav 保持一致，避免前端 selectChangeRate 误判
  const baseNav = em.actualNav;

  return {
    fundCode,
    nav: baseNav || em.actualNav || null,
    estimatedNav: source === "em" ? (mnf.gsz || null) : null,
    estimatedChangeRate: estRate,
    estimateTime: estTime,
    source,
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
