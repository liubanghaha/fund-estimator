const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fd = require("./_shared/fund-data");
const https = require("https");
const ft = require("./_shared/fund-temperature");
const td = require("./_shared/trading-day");

exports.main = async (event) => {
  const { fundCode, src } = event;
  if (!fundCode || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "请提供有效的6位基金代码" };
  const estSrc = src === "self" ? "self" : "sina";

  try {
    const todayStr = fd.formatBJDate();
    // 净值历史缓存优先（2026-10-18：watchlistPerfWarmup 每日 05:30 预热 fund_nav_cache）。
    // 命中当日缓存 → 260 行历史 0 次东财请求；未命中 → 全量拉取并写缓存（当日首个用户付费）
    let cachedNav = null;
    try {
      try { await db.createCollection("fund_nav_cache"); } catch (e) { /* 已存在 */ }
      const c = await db.collection("fund_nav_cache").doc(fundCode).get();
      const doc = c.data;
      // 盘后缓存闸（同 getPortfolio）：交易日 15:00 后当日新净值陆续公布，只认
      // "缓存首行已是今天"的缓存；旧缓存 actualDate 停在昨天会误判净值公布状态
      const bjMin = new Date(Date.now() + 8 * 3600000);
      const afterClose = require("./_shared/trading-day").isTradingDay(todayStr)
        && bjMin.getUTCHours() * 60 + bjMin.getUTCMinutes() >= 900;
      const firstIsToday = Array.isArray(doc && doc.rows) && doc.rows[0] && doc.rows[0][0] === todayStr;
      if (doc && doc.date === todayStr && (!afterClose || firstIsToday) && Array.isArray(doc.rows) && doc.rows.length > 50) {
        cachedNav = doc.rows.map(r => ({ date: r[0], nav: r[1], changeRate: r[2] }));
      }
    } catch (e) { /* 无缓存/未建集合 → 现场拉取 */ }

    const [estimate, history, profileData, peTemp, estimateAccuracy] = await Promise.all([
      fetchEstimate(fundCode, estSrc),
      cachedNav ? Promise.resolve(cachedNav) : fd.fetchNAVHistory(fundCode, 260).then((rows) => {
        // 回写当日缓存（260 行压缩为 [date, nav, changeRate] 三元组），次日所有用户命中
        if (rows && rows.length > 50) {
          const compact = rows.map(r => [r.date, +r.nav.toFixed(4), r.changeRate == null ? null : +r.changeRate.toFixed(2)]);
          db.collection("fund_nav_cache").doc(fundCode).set({ data: { fundCode, date: todayStr, rows: compact } }).catch(() => {});
        }
        return rows;
      }),
      fetchProfileData(fundCode),
      fetchPeTemp(fundCode),
      fetchEstimateAccuracy(fundCode, todayStr),
    ]);
    return {
      code: 0, msg: "success",
      data: {
        ...estimate,
        history,
        profile: profileData.profile,
        manager: profileData.manager,
        peTemp,
        estimateAccuracy,
      },
    };
  } catch (e) {
    console.error("获取基金概览失败:", e.message);
    return { code: 500, msg: "获取基金概览失败" };
  }
};

async function fetchEstimate(fundCode, estSrc) {
  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await fd.fetchLatestNavEastMoney(fundCode);
  const todayStr = fd.formatBJDate();
  // 数据所属日：当日 9:25 起为今日（集合竞价开盘价定出）；9:25 前/周末/节假日为上一交易日（净值已确定，按实际口径）
  const estimateUpdated = em.actualDate === _dataDay(todayStr);

  // 净值已公布：估算请求无意义（官方 GSZZL 已清空），直接走真值短路，省两轮外部请求
  if (estimateUpdated) {
    return {
      nav: (em.yesterdayNav || em.actualNav) || null,
      estimatedNav: null,
      estimatedChangeRate: em.actualChangeRate != null ? em.actualChangeRate : null,
      estimateTime: "",
      source: "nav",
      actualNav: em.actualNav,
      actualDate: em.actualDate,
      actualChangeRate: em.actualChangeRate,
    };
  }

  // 2+3. 新浪实时估值与自主估算（持仓→行情）互不依赖 → 并行拉取
  // （原串行三轮叠加：新浪 → 持仓 → 股票行情；两支与 em 无取值依赖，em 先行只为净值公布短路省请求）
  const [sn, selfEstimate] = await Promise.all([
    fd.fetchSinaEstimates([fundCode]).then((m) => m[fundCode] || {}),
    computeSelfEstimate(fundCode),
  ]);

  // 4. 组装（净值未公布）：口径统一走 _shared/fund-data.pickEstimate——
  //    数据源一 = 本轮新浪 → 同源最近值（fund_estimate_cache，缺值不换源）→ 自算；数据源二 = 自算 → 新浪兜底
  const sinaToday = sn.date != null && (_gdIsToday(sn.date, todayStr)) && sn.changeRate != null;

  let cached = null;
  if (estSrc === "sina" && !sinaToday) {
    const m = await fd.readEstimateCache(db, [fundCode]);
    cached = m[fundCode] || null;
  }
  const pick = fd.pickEstimate({
    pref: estSrc,
    sinaRate: sinaToday ? sn.changeRate : null, sinaTime: sn.time || "", sinaNav: sn.nav,
    selfRate: selfEstimate, selfTime: fd.formatBJTime(),
    cached, todayStr, now: Date.now(),
  });
  // 今日既无净值也拿不到估算（债券/968/货币等无覆盖标的）→ 置 null，别拿上一交易日涨幅
  // 冒充今日（与 getPortfolio / batchFetchEstimate / fetchFundEstimate 同一约定）
  const estRate = pick.rate;

  return {
    nav: em.actualNav || null,
    estimatedNav: pick.nav != null ? pick.nav : null,
    estimatedChangeRate: estRate,
    estimateTime: pick.time,
    source: pick.source || "nav",
    actualNav: em.actualNav,
    actualDate: em.actualDate,
    actualChangeRate: em.actualChangeRate,
  };
}

// 自主估算：持仓股实时涨跌加权（仅工作日；失败/无数据返回 null）
async function computeSelfEstimate(fundCode) {
  if (!fd.isBJWeekday()) return null;
  try {
    const holdings = await fetchTempHoldingsCached(fundCode);
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

// 持仓读取带 DB 缓存（三级来源与 getPortfolio.computeSelfEstimates 同口径）：
// 温度表 detailPEs（当日）→ fund_holdings_cache（当日）→ 东财现拉并回写缓存（每只基金每天只拉一次），
// DB 命中即跳过东财外呼
async function fetchTempHoldingsCached(fundCode) {
  const today = fd.formatBJDate();
  try {
    const res = await db.collection("fund_temperatures")
      .where({ fundCode, date: today })
      .field({ detailPEs: true })
      .limit(1)
      .get();
    const t = (res.data || [])[0];
    if (t && fd.isValidHoldings(t.detailPEs)) {
      return t.detailPEs.map(p => ({ stockCode: p.code, navRatio: p.ratio }));
    }
  } catch (e) { /* ignore */ }
  try {
    const res = await db.collection("fund_holdings_cache")
      .where({ fundCode, date: today })
      .limit(1)
      .get();
    const d = (res.data || [])[0];
    if (d && fd.isValidHoldings(d.holdings)) {
      return d.holdings.map(h => ({ stockCode: h.stockCode, navRatio: h.navRatio }));
    }
  } catch (e) { /* ignore */ }
  const holdings = await fd.fetchTempHoldings(fundCode);
  if (holdings && holdings.length > 0) {
    // _id=fundCode_date 幂等 upsert（与 getPortfolio 兜底写缓存同款）
    await db.collection("fund_holdings_cache")
      .doc(`${fundCode}_${today}`)
      .set({ data: { fundCode, date: today, holdings } })
      .catch(() => {});
  }
  return holdings;
}

async function fetchProfileData(fundCode) {
  const https = require("https");
  const [profile, manager] = await Promise.all([
    new Promise((resolve) => {
      const url = `https://fundmobapi.eastmoney.com/FundMApi/FundDetailInformation.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
      const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = (JSON.parse(body).Datas) || {};
            resolve({
              fundType: d.FTYPE || "",
              establishDate: d.ESTABDATE || "",
              fundSize: parseFloat(d.ENDNAV) || null,
              riskLevel: d.RISKLEVEL || "",
              company: d.JJGS || "",
              mgmtFee: d.MGREXP || null,
              trustFee: d.TRUSTEXP || null,
              salesFee: d.SALESEXP || null,
            });
          } catch (e) { resolve(null); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    }),
    new Promise((resolve) => {
      const url = `https://fundmobapi.eastmoney.com/FundMApi/FundManagerList.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
      const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const list = (JSON.parse(body).Datas || []).filter((m) => !m.LEMPDATE);
            const cur = list[0] || {};
            resolve({
              name: cur.MGRNAME || "",
              tenureDays: Math.round(cur.DAYS) || 0,
              startDate: cur.FEMPDATE || "",
              tenureReturn: cur.PENAVGROWTH ? parseFloat(cur.PENAVGROWTH).toFixed(2) : null,
            });
          } catch (e) { resolve(null); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    }),
  ]);
  return { profile, manager };
}

async function fetchPeTemp(fundCode) {
  try {
    // 取本基金最近 90 条温度（与 fetchFundEstimate.fetchTemperature 同口径）：
    // 当天任务偶发失败/未跑到时兜底最近一次；顺带算温度分位——
    // 首次访问详情页只走概览接口，不同步这段的话分位要等二次刷新才出现
    const res = await db.collection("fund_temperatures")
      .where({ fundCode })
      .orderBy("date", "desc").limit(90)
      .field({ signal: true, label: true, normPE: true })
      .get();
    if (res.data && res.data.length > 0) {
      const t = res.data[0];
      // 历史分位（信任线：给"温度 0.82"一个水平感）：与 fetchFundEstimate 同式，样本 <20 不出
      const hist = res.data.map((r) => r.normPE).filter((v) => typeof v === "number");
      let tempPercentile = null;
      if (hist.length >= 20 && typeof t.normPE === "number") {
        const below = hist.filter((v) => v <= t.normPE).length;
        tempPercentile = { days: hist.length, pct: Math.round((below / hist.length) * 100) };
      }
      return { signal: t.signal, label: ft.sanitizeLabel(t.label), normPE: t.normPE, tempPercentile };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 近 30 天估算误差（与 fetchFundEstimate.fetchEstimateAccuracy 同口径）：概览带一份，
// 详情页首访（无缓存历史走 overview）也能直接看到徽章，不必等二次刷新
async function fetchEstimateAccuracy(fundCode, todayStr, days = 30) {
  try {
    const start = _addDays(todayStr, -days);
    // 台账 _id = `${fundCode}_${YYYY-MM-DD}`，按 _id 区间查走主键索引
    const res = await db.collection("fund_estimate_deviations")
      .where({ _id: db.command.gte(`${fundCode}_${start}`).and(db.command.lte(`${fundCode}_${todayStr}`)) })
      .field({ date: true, estRate: true, actualRate: true, diff: true })
      .limit(60).get();
    const rows = (res.data || []).filter((r) => typeof r.diff === "number" && typeof r.actualRate === "number" && typeof r.estRate === "number");
    if (rows.length === 0) return null;
    const meanAbs = rows.reduce((a, r) => a + Math.abs(r.diff), 0) / rows.length;
    // 方向命中率只在"官方当天真有涨跌"的样本上算：|实际| < 0.05pp 视为横盘，不计入
    const dirRows = rows.filter((r) => Math.abs(r.actualRate) >= 0.05 && typeof r.estRate === "number");
    const hitRate = dirRows.length >= 5
      ? Math.round((dirRows.filter((r) => (r.estRate >= 0) === (r.actualRate >= 0)).length / dirRows.length) * 100)
      : null;
    // 明细随聚合一并返回（详情页误差行点击展开 30 天对账列表）
    const log = rows
      .map((r) => ({ date: r.date, estRate: r.estRate, actualRate: r.actualRate, diff: +r.diff.toFixed(2) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    return { days, samples: rows.length, meanAbsDiff: +meanAbs.toFixed(2), hitRate, log };
  } catch (e) {
    console.warn("[fetchFundOverview] 误差台账读取失败:", e.message);
    return null;
  }
}

// 数据所属日（净值/估算口径）：当日 9:25 起（含盘后当晚）为今日——盘中估算/晚间精确；
// 次日凌晨开盘前与周末、节假日为上一交易日——净值已确定，按实际口径
// GZTIME/数据日期是否属于今日：兼容 "YYYY-MM-DD HH:mm:ss"、"YYYY-MM-DD" 与 "MM-DD HH:mm:ss" 三种格式
function _gdIsToday(gztime, todayStr) {
  const gd = String(gztime || "").trim();
  return gd.slice(0, 10) === todayStr || gd.slice(0, 5) === todayStr.slice(5);
}

// 数据所属日（净值/估算口径）：当日 9:25 起（含盘后当晚）为今日——集合竞价开盘价 9:25 定出；
// 次日 9:25 前与周末、节假日为上一交易日。⚠️ 与 getPortfolio 的 openedToday 同一边界
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
