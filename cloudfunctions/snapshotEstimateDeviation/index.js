const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
const td = require("./_shared/trading-day");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 估算误差台账（信任线底座）
 *
 * 每个交易日 15:30 为"全市场被跟踪的基金"记一条：
 *   { fundCode, date, estRate(当日收盘档估算涨跌%), actualRate(官方涨跌幅%), diff(=estRate-actualRate) }
 * 估算侧 = 新浪批量估值（当天这一档）；实际侧 = 东财历史净值的官方日增长率（JZZZL，分红除息已调整）。
 *
 * ⚠️ 实际口径（2026-09-26 修正）：按 fund_navs 的 yesterdayNav 相除曾经错位一个交易日——
 * doc(date=D).yesterdayNav = 在 D 当天取到的"最新已公布净值" = nav(D-1)，
 * 旧写法 row(D-1)/row(D-2) 相除得到的是 D-2 的涨跌却记在 D-1 名下。现改为直接拉东财
 * lsjz 里 date=台账日 那一行的 JZZZL（与收盘播报同源），顺带解决分红除息日"净值相除出假涨跌"。
 *
 * 补写窗口 = 前两个交易日：某天任务挂了/净值晚公布，第二天自动重试（旧实现错过即永久半截）。
 * 温度表无当日记录只影响估算档，不再连坐补写（补写只需要台账自己的基金）。
 */

const COLL = "fund_estimate_deviations";
const PAGE = 1000;
const CONCURRENCY = 20;
const FILL_BUDGET_MS = 55000; // 补写拉净值预算。2026-10-18 修复：此前 45s（新浪估算）+75s（补写）=120s 恰好吃满 timeout，收尾写库被强杀 → 当日台账缺口永久；压缩到 45+55=100s 留 20s 写库收尾

// 上一交易日：服务端 trading-day 只导出 lastTradingDay（只有客户端的 market-time 有 prevTradingDay），
// 按服务端既有写法取"严格早于该日"的最近交易日
const addDays = (dateStr, n) => {
  const t = new Date(dateStr + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const prevTradingDay = (dateStr) => td.lastTradingDay(addDays(dateStr, -1));

exports.main = async (event) => {
  // 安全：定时任务专用，拒绝客户端调用（云函数默认可被小程序调用，防止有人伪造写台账/刷数据源）
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  const ev = event || {};
  const dryRun = !!ev.dryRun;   // 只算不写（部署后验证用）
  const force = !!ev.force;     // 跳过交易日判断
  const t0 = Date.now();
  const el = () => Date.now() - t0;
  try {
    const today = td.bjDateStr();
    if (!dryRun && !force && !td.isTradingDay(today)) {
      return { code: 0, msg: `非交易日 ${today} 跳过` };
    }
    const prevDay = prevTradingDay(today);
    const prevPrev = prevTradingDay(prevDay);

    // 1) 当日估算档（新浪批量；只有日期=今天的才收，休市/停更/无覆盖的自然排除）。
    //    温度表无当日记录时跳过估算档但**继续补写**——补写只需要台账里已有的基金
    const codes = await readTempCodes(today);
    let todayEst = {};
    // 源一（新浪批量）与源二（自算，腾讯行情加权）互不依赖 → 并行；
    // 串行会变成 45s + 10s + 55s(补写) ≈ 110s，逼近 120s 超时
    const [sinaMap, selfEst] = await Promise.all([
      codes.length > 0
        ? fd.fetchSinaEstimates(codes, { budgetMs: 45000 }).catch(() => ({}))
        : Promise.resolve({}),
      codes.length > 0
        ? computeSelfEstimates(today).catch(() => ({}))
        : Promise.resolve({}),
    ]);
    if (codes.length > 0) {
      Object.keys(sinaMap).forEach((code) => {
        const s = sinaMap[code];
        if (s && s.date === today && typeof s.changeRate === "number") todayEst[code] = s.changeRate;
      });
    } else {
      console.warn("[snapshotEstimateDeviation] 温度表无当日记录，跳过估算档（补写不受影响）");
    }

    // 2) 补前两个交易日的"实际"：台账里 estRate 已写、actualRate 还缺的都补（重试窗口）。
    //    官方涨跌 = 东财 lsjz 中 date=台账日 那行的 JZZZL（分红除息已调整，与收盘播报同源）；
    //    找不到该行（净值还没公布/基金无数据）→ 跳过，次日重试
    const openDocs = await readOpenDeviations([prevDay, prevPrev]);
    const fillList = await buildFillList(openDocs, el);
    const skippedFill = openDocs.length - fillList.length;

    if (dryRun) {
      return {
        code: 0, dryRun: true, today, prevDay,
        codes: codes.length,
        estWould: Object.keys(todayEst).length,
        selfWould: Object.keys(selfEst).length,
        fillWould: fillList.length,
        fillOpen: openDocs.length,
        // 抽 3 条让人能一眼核对方向与量级
        estSample: Object.keys(todayEst).slice(0, 3).map((c) => `${c}:${todayEst[c]}`),
        selfSample: Object.keys(selfEst).slice(0, 3).map((c) => `${c}:${selfEst[c]}`),
        fillSample: fillList.slice(0, 3).map((f) => `${f.id} est=${f.estRate} act=${f.actualRate} diff=${f.diff}`),
        costMs: el(),
      };
    }

    const estWritten = await writeEst(today, todayEst, selfEst);
    const actualFilled = await fillActual(fillList);
    console.log(`[snapshotEstimateDeviation] today=${today} codes=${codes.length} est=${estWritten} self=${Object.keys(selfEst).length} filled=${actualFilled} open=${openDocs.length} skippedFill=${skippedFill} t=${el()}ms`);
    return { code: 0, today, prevDay, codes: codes.length, estWritten, actualFilled, fillOpen: openDocs.length, skippedFill, costMs: el() };
  } catch (e) {
    console.error("snapshotEstimateDeviation 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// 温度表当天的全部 fundCode（分页读，只取 fundCode 字段）
async function readTempCodes(date) {
  const out = new Set();
  for (let skip = 0; skip < 20000; skip += PAGE) {
    const res = await db.collection("fund_temperatures")
      .where({ date }).field({ fundCode: true })
      .skip(skip).limit(PAGE).get();
    (res.data || []).forEach((d) => { if (d.fundCode) out.add(d.fundCode); });
    if ((res.data || []).length < PAGE) break;
  }
  return [...out];
}

// 数据源二（自算估值）：温度表当日 detailPEs（持仓股 + 占净值比）→ 腾讯批量行情加权。
// detailPEs 项结构 { code, ratio }（ratio = navRatio）。行情按 50 只/请求内部分批
async function computeSelfEstimates(date) {
  const holdingsMap = {};
  const all = new Set();
  for (let skip = 0; skip < 20000; skip += PAGE) {
    const res = await db.collection("fund_temperatures")
      .where({ date }).field({ fundCode: true, detailPEs: true })
      .skip(skip).limit(PAGE).get();
    const rows = res.data || [];
    rows.forEach((d) => {
      const hs = (d.detailPEs || []).map((p) => ({
        code: String(p.code || "").trim(),
        ratio: parseFloat(p.ratio) || 0,
      })).filter((h) => h.code && h.ratio > 0);
      if (d.fundCode && hs.length > 0) {
        holdingsMap[d.fundCode] = hs;
        hs.forEach((h) => all.add(h.code));
      }
    });
    if (rows.length < PAGE) break;
  }
  const codes = [...all];
  if (codes.length === 0) return {};
  const prices = await fd.fetchStockPricesTencent(codes, { timeoutMs: 20000, batchSize: 50 }).catch(() => ({}));
  const out = {};
  Object.entries(holdingsMap).forEach(([fundCode, hs]) => {
    // 加权口径收敛到 _shared（2026-11-08 审查）
    const rate = fd.weightedChangeRate(hs, prices);
    if (rate != null) out[fundCode] = rate;
  });
  return out;
}

// 前两个交易日的台账中"有估算、缺实际"的文档（补写目标；已补过的天然跳过 = 幂等）
async function readOpenDeviations(days) {
  const out = [];
  for (const date of days) {
    for (let skip = 0; skip < 20000; skip += PAGE) {
      const res = await db.collection(COLL)
        .where({ date }).field({ fundCode: true, date: true, estRate: true, estRateSelf: true, actualRate: true })
        .skip(skip).limit(PAGE).get();
      (res.data || []).forEach((doc) => {
        if ((typeof doc.estRate === "number" || typeof doc.estRateSelf === "number") && typeof doc.actualRate !== "number") out.push(doc);
      });
      if ((res.data || []).length < PAGE) break;
    }
  }
  return out;
}

// 逐基金拉 10 天净值找台账日那行 JZZZL（1 页就够）；预算内能补多少补多少，剩余次日重试
async function buildFillList(openDocs, el) {
  const fillList = [];
  for (let i = 0; i < openDocs.length; i += CONCURRENCY) {
    if (el() > FILL_BUDGET_MS) {
      console.warn(`[snapshotEstimateDeviation] 补写预算用尽，已核 ${i}/${openDocs.length}，剩余次日重试`);
      break;
    }
    const batch = openDocs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (doc) => {
      try {
        const rows = await fd.fetchNAVHistory(doc.fundCode, 10);
        const row = (rows || []).find((r) => r && r.date === doc.date);
        if (!row || typeof row.changeRate !== "number") return null;
        return {
          id: `${doc.fundCode}_${doc.date}`,
          estRate: doc.estRate,
          estRateSelf: doc.estRateSelf,
          actualRate: +row.changeRate.toFixed(4),
          diff: typeof doc.estRate === "number" ? +(doc.estRate - row.changeRate).toFixed(4) : null,
          diffSelf: typeof doc.estRateSelf === "number" ? +(doc.estRateSelf - row.changeRate).toFixed(4) : null,
        };
      } catch (e) { return null; }
    }));
    results.forEach((r) => { if (r) fillList.push(r); });
  }
  return fillList;
}

// 写当日估算档（_id=fundCode_date 幂等 upsert，重跑不会累积垃圾文档）
// 源一（新浪）与源二（自算）取并集：只缺一边的基金也写，读端按字段各自统计样本
async function writeEst(date, estMap, selfMap) {
  const codes = [...new Set([...Object.keys(estMap || {}), ...Object.keys(selfMap || {})])];
  const now = Date.now();
  let ok = 0;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((code) =>
      db.collection(COLL).doc(`${code}_${date}`)
        .set({
          data: {
            fundCode: code, date,
            estRate: typeof estMap[code] === "number" ? estMap[code] : null,
            estSrc: "sina",
            estRateSelf: typeof selfMap[code] === "number" ? selfMap[code] : null,
            createdAt: now,
          },
        })
        .then(() => true).catch(() => false)));
    ok += results.filter(Boolean).length;
  }
  return ok;
}

// 补写前一交易日的实际值与误差
async function fillActual(list) {
  const now = Date.now();
  let ok = 0;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((f) =>
      db.collection(COLL).doc(f.id)
        .update({ data: { actualRate: f.actualRate, diff: f.diff, diffSelf: f.diffSelf, filledAt: now } })
        .then(() => true).catch(() => false)));
    ok += results.filter(Boolean).length;
  }
  return ok;
}
