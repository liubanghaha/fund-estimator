const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const https = require("https");
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");
const td = require("./_shared/trading-day");

exports.main = async (event) => {
  const { fundCode, src } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const todayStr = td.bjDateStr();
    const [estimate, peTemp, estimateAccuracy] = await Promise.all([
      fetchSelfEstimate(fundCode, src),
      fetchTemperature(fundCode),
      fetchEstimateAccuracy(fundCode, todayStr),
    ]);
    return {
      code: 0, msg: "success",
      data: { ...estimate, peTemp, estimateAccuracy },
    };
  } catch (e) {
    console.error("获取估值失败:", e.message);
    return { code: 500, msg: "获取估值失败" };
  }
};

// 近 30 天估算误差（信任线：自曝误差，数据由 snapshotEstimateDeviation 每日 15:30 写入台账）
// 无样本返回 null（客户端不显示徽章），样本少也照实显示样本数——藏样本数就成了自欺
async function fetchEstimateAccuracy(fundCode, todayStr, days = 30) {
  try {
    const start = _addDays(todayStr, -days);
    // 台账 _id = `${fundCode}_${YYYY-MM-DD}`，按 _id 区间查走主键索引（不必依赖 fundCode 索引）
    const res = await db.collection("fund_estimate_deviations")
      .where({ _id: db.command.gte(`${fundCode}_${start}`).and(db.command.lte(`${fundCode}_${todayStr}`)) })
      .field({ date: true, estRate: true, actualRate: true, diff: true })
      .limit(60).get();
    const rows = (res.data || []).filter((r) => typeof r.diff === "number" && typeof r.actualRate === "number");
    if (rows.length === 0) return null;
    const meanAbs = rows.reduce((a, r) => a + Math.abs(r.diff), 0) / rows.length;
    // 方向命中率只在"官方当天真有涨跌"的样本上算：|实际| < 0.05pp 视为横盘，不计入
    const dirRows = rows.filter((r) => Math.abs(r.actualRate) >= 0.05 && typeof r.estRate === "number");
    const hitRate = dirRows.length >= 5
      ? Math.round((dirRows.filter((r) => (r.estRate >= 0) === (r.actualRate >= 0)).length / dirRows.length) * 100)
      : null;
    return { days, samples: rows.length, meanAbsDiff: +meanAbs.toFixed(2), hitRate };
  } catch (e) {
    console.warn("[fetchFundEstimate] 误差台账读取失败:", e.message);
    return null;
  }
}

// GZTIME 是否属于今日：兼容 "YYYY-MM-DD HH:mm:ss" 与 "MM-DD HH:mm:ss" 两种盘中格式
function _gdIsToday(gztime, todayStr) {
  const gd = String(gztime || "").trim();
  return gd.slice(0, 10) === todayStr || gd.slice(0, 5) === todayStr.slice(5);
}

// 新浪实时估值（数据源一）：轻接口单只查询，字段说明见 _shared/fund-data.fetchSinaEstimates
function fetchSinaEstimate(fundCode) {
  return fd.fetchSinaEstimates([fundCode]).then((m) => m[fundCode] || {});
}

async function fetchSelfEstimate(fundCode, src) {
  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await fd.fetchLatestNavEastMoney(fundCode);
  const estSrc = src === "self" ? "self" : "sina"; // 默认 sina（数据源一优先）
  const todayStr = fd.formatBJDate();
  // 数据所属日：当日 9:25 起为今日（集合竞价开盘价定出）；9:25 前/周末/节假日为上一交易日（净值已确定，按实际口径）
  const estimateUpdated = em.actualDate === _dataDay(todayStr);

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

  // 2+3. 新浪实时估值与自主估算互不依赖 → 并行拉取（原串行：新浪 → 指数 → 持仓 → 行情四轮叠加；
  //      em 先行只为净值公布短路省请求，与两支无取值依赖）
  const [sn, selfChangeRate] = await Promise.all([
    fetchSinaEstimate(fundCode),
    computeSelfChangeRate(fundCode),
  ]);

  // 4. 组装（净值未公布）：按所选源优先（sina=数据源一优先、self=数据源二优先），互相兜底后回退昨日涨幅
  //    新浪对无覆盖标的（债券基金/968 互认）返回空，或数据非当日（停更标的）→ 视为不可用
  const sinaToday = sn.date != null && (_gdIsToday(sn.date, todayStr)) && sn.changeRate != null;

  let estRate, estTime, source;
  if (estSrc === "sina" && sinaToday) {
    estRate = sn.changeRate; estTime = sn.time || ""; source = "sina";
  } else if (selfChangeRate != null) {
    estRate = selfChangeRate; estTime = fd.formatBJTime(); source = "self";
  } else if (sinaToday) {
    estRate = sn.changeRate; estTime = sn.time || ""; source = "sina";
  } else {
    // 今日既无净值也拿不到估算（债券/968/货币等无覆盖标的）→ 不留"上一交易日涨幅"冒充今日，
    // 置 null 让详情页显示 --（与 getPortfolio / batchFetchEstimate 同一约定）
    estRate = null; estTime = ""; source = "nav";
  }

  // nav 要与 actualNav 保持一致，避免前端 selectChangeRate 误判
  const baseNav = em.actualNav;

  return {
    fundCode,
    nav: baseNav || em.actualNav || null,
    estimatedNav: source === "sina" ? (sn.nav || null) : null,
    estimatedChangeRate: estRate,
    estimateTime: estTime,
    source,
    actualNav: em.actualNav,
    actualDate: em.actualDate,
    actualChangeRate: em.actualChangeRate,
    yesterdayNav: em.yesterdayNav,
  };
}

// 自主估算涨跌：指数基金优先用跟踪指数实时行情，否则持仓股加权兜底（仅工作日，失败返回 null）
async function computeSelfChangeRate(fundCode) {
  if (!fd.isBJWeekday()) return null;
  // 2a) 指数优先：东财 INDEXCODE 覆盖所有指数基金（行业天然全覆盖），用指数实时涨跌幅估算。
  //     带 fund_index_cache 缓存：命中直接用，未命中才调东财并写回。
  try {
    const track = await fd.getTrackIndexCached(db, fundCode);
    if (track && track.indexCode) {
      const idx = await fd.fetchIndexRealtime(track.indexCode);
      if (idx && idx.changeRate != null) return idx.changeRate;
    }
  } catch (e) { /* ignore */ }

  // 2b) 持仓加权兜底：非指数基金 / 指数行情失败时，用持仓股实时涨跌加权
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
      if (totalRatio > 0) return +(weightedChange / totalRatio).toFixed(2);
    }
  } catch (e) { /* ignore */ }
  return null;
}

  async function fetchTemperature(fundCode) {
    try {
      // 逐基金取最近记录（原为只取最新 1 条）：多取一批是为了算"当前温度在它自己的历史里处于什么分位"。
      // 定时任务可能只写完部分基金（超时截断），按 date 降序取本基金最新的一批——永远与列表页 getPortfolio 同源
      const res = await db.collection("fund_temperatures")
        .where({ fundCode })
        .orderBy("date", "desc").limit(90)
        .field({ signal: true, label: true, normPE: true, weightedPE: true, coverage: true, stocksWithData: true, totalStocks: true, warnings: true, isETF: true })
        .get();
      if (res.data && res.data.length > 0) {
        const t = res.data[0];
        // 历史分位（信任线：给"温度 0.82"一个水平感）：最新值落在本基金近 N 天分布中的位置。
        // 样本少于 20 天不出分位（样本太少的分位数会误导）；窗口天数如实回传，不用"近一年/三年"这种话撑场面
        const hist = res.data.map((r) => r.normPE).filter((v) => typeof v === "number");
        let tempPercentile = null;
        if (hist.length >= 20 && typeof t.normPE === "number") {
          const below = hist.filter((v) => v <= t.normPE).length;
          tempPercentile = { days: hist.length, pct: Math.round((below / hist.length) * 100) };
        }
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
          tempPercentile,
        };
      }
    } catch (e) { /* ignore */ }
  // 缺失温度不做请求内重计算（每只持仓股一个 HTTP 会拖垮请求），凌晨定时任务会补全
  return null;
}

// 数据所属日（净值/估算口径）：当日 9:25 起（含盘后当晚）为今日——集合竞价开盘价 9:25 定出，
// 从这一刻起就有今日估值；次日 9:25 前与周末、节假日为上一交易日——净值已确定，按实际口径
// ⚠️ 与 getPortfolio 的 openedToday / 客户端 marketPhase() 用同一个边界（fd.OPEN_MIN）
function _dataDay(todayStr) {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const openedToday = day >= 1 && day <= 5 && min >= fd.OPEN_MIN;
  // lastTradingDay 含当天，取"上一交易日"须从昨天回找
  return openedToday && td.isTradingDay(todayStr) ? todayStr : td.lastTradingDay(_addDays(todayStr, -1));
}

function _addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
