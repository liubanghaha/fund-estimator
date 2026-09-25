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
 * 估算侧 = 新浪批量估值（当天这一档）；实际侧 = fund_navs 两天的"最新已公布净值"相除。
 * 消费端（后续）：详情页"近 30 天估算误差 ±X pp"徽章 —— 自曝误差，是全网黑箱里唯一的透明做法。
 *
 * 为什么 15:30：给数据源留出收盘后的最后更新时间，并与 15:35 的温度提醒错开。
 * fund_navs 的口径（重要）：doc(date=D).yesterdayNav = 在 D 当天取到的"最新已公布净值"= nav(D-1)，
 * 所以官方涨跌(D-1) = nav(prevDay 行) / nav(prevPrev 行) - 1。
 */

const COLL = "fund_estimate_deviations";
const PAGE = 1000;
const CONCURRENCY = 20;

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
    // 1) 基金池 = 温度表当天的行（全市场被跟踪的基金；凌晨 03:00 的任务已写好）
    const codes = await readTempCodes(today);
    if (codes.length === 0) return { code: 0, msg: "温度表无当日记录，跳过" };
    const prevDay = prevTradingDay(today);
    const prevPrev = prevTradingDay(prevDay);

    // 2) 当日估算档（新浪批量；只有日期=今天的才收，休市/停更/无覆盖的自然排除）
    const estMap = await fd.fetchSinaEstimates(codes, { budgetMs: 45000 }).catch(() => ({}));
    const todayEst = {};
    Object.keys(estMap).forEach((code) => {
      const s = estMap[code];
      if (s && s.date === today && typeof s.changeRate === "number") todayEst[code] = s.changeRate;
    });

    // 3) 补前一交易日的"实际"：只对"昨天写了估算"的基金补，避免给没有估算的基金留半截记录
    const navRows = await readNavRows(codes, [prevDay, prevPrev]);
    const navByKey = {};
    navRows.forEach((r) => { if (r.yesterdayNav > 0) navByKey[`${r.fundCode}|${r.date}`] = r.yesterdayNav; });
    const prevEstDocs = await readDeviationByDate(prevDay);
    const fillList = [];
    prevEstDocs.forEach((doc) => {
      const n1 = navByKey[`${doc.fundCode}|${prevDay}`];
      const n0 = navByKey[`${doc.fundCode}|${prevPrev}`];
      if (!(n1 > 0 && n0 > 0) || typeof doc.estRate !== "number") return;
      const actualRate = +(((n1 / n0) - 1) * 100).toFixed(4);
      fillList.push({ id: `${doc.fundCode}_${prevDay}`, estRate: doc.estRate, actualRate, diff: +(doc.estRate - actualRate).toFixed(4) });
    });

    if (dryRun) {
      return {
        code: 0, dryRun: true, today, prevDay,
        codes: codes.length,
        estWould: Object.keys(todayEst).length,
        fillWould: fillList.length,
        // 抽 3 条让人能一眼核对方向与量级
        estSample: Object.keys(todayEst).slice(0, 3).map((c) => `${c}:${todayEst[c]}`),
        fillSample: fillList.slice(0, 3).map((f) => `${f.id} est=${f.estRate} act=${f.actualRate} diff=${f.diff}`),
        costMs: el(),
      };
    }

    const estWritten = await writeEst(today, todayEst);
    const actualFilled = await fillActual(fillList);
    console.log(`[snapshotEstimateDeviation] today=${today} codes=${codes.length} est=${estWritten} filled=${actualFilled} t=${el()}ms`);
    return { code: 0, today, prevDay, codes: codes.length, estWritten, actualFilled, costMs: el() };
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

// 指定日期的净值缓存行（fund_navs 的 yesterdayNav = 当天取到的最新已公布净值）
async function readNavRows(codes, days) {
  const out = [];
  const BATCH = 100;
  for (let i = 0; i < codes.length; i += BATCH) {
    try {
      const res = await db.collection("fund_navs")
        .where({ fundCode: _.in(codes.slice(i, i + BATCH)), date: _.in(days) })
        .field({ fundCode: true, date: true, yesterdayNav: true })
        .limit(PAGE).get();
      out.push(...(res.data || []));
    } catch (e) { console.warn("[snapshotEstimateDeviation] 读净值缓存失败:", e.message); }
  }
  return out;
}

// 某一天的台账（用来给"实际值"补写）
async function readDeviationByDate(date) {
  const out = [];
  for (let skip = 0; skip < 20000; skip += PAGE) {
    const res = await db.collection(COLL)
      .where({ date }).field({ fundCode: true, date: true, estRate: true })
      .skip(skip).limit(PAGE).get();
    out.push(...(res.data || []));
    if ((res.data || []).length < PAGE) break;
  }
  return out;
}

// 写当日估算档（_id=fundCode_date 幂等 upsert，重跑不会累积垃圾文档）
async function writeEst(date, estMap) {
  const codes = Object.keys(estMap);
  const now = Date.now();
  let ok = 0;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((code) =>
      db.collection(COLL).doc(`${code}_${date}`)
        .set({ data: { fundCode: code, date, estRate: estMap[code], estSrc: "sina", createdAt: now } })
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
        .update({ data: { actualRate: f.actualRate, diff: f.diff, filledAt: now } })
        .then(() => true).catch(() => false)));
    ok += results.filter(Boolean).length;
  }
  return ok;
}
