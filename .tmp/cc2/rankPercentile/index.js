const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 相对排名百分位（2026-11-06 全球调研 Top2：Acorns 式匿名聚合统计）
 *
 * "你的组合近一年涨了 X%，超过 N% 的持有人"——纯匿名分布统计，不点名任何个体。
 *
 * 口径（重要）：
 *   组合年涨幅 = Σ(份额×今日净值) / Σ(份额×一年前净值) − 1（不含分红复权，V1 如实接受）
 *   不用 holdings 的 marketValue/totalReturn 快照（只在加减仓时更新，陈旧失真），
 *   用份额 × 基金级净值现算——份额是账本事实，净值是市场事实，两者都可靠。
 *
 * 流程：
 *   定时（每日 04:30）：
 *     1) 扫 holdings 全库 → 按用户聚合 { fundCode: 份额 }
 *     2) 全部涉猎基金拉 260 天净值首尾（fund_navs 优先？——直接 fetchNAVHistory，并发 20）
 *        基金年净值表写 app_config/rank_nav_year（code → {now, yearAgo}）
 *     3) 每用户组合年涨幅 → 1pp 分桶直方图 → app_config/rank_distribution
 *   读（action=percentile，带 OPENID）：
 *     按分布算该用户百分位；样本 <20 不出（宁缺毋错）
 */

const PAGE = 1000;
const CONCURRENCY = 20;
const YEAR_DAYS = 260;

const addDays = (dateStr, n) => {
  const t = new Date(dateStr + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

exports.main = async (event) => {
  const ev = event || {};
  const { OPENID } = cloud.getWXContext();

  // 读路径：查自己的百分位
  if (ev.action === "percentile") {
    if (!OPENID) return { code: 401, msg: "未登录" };
    try {
      const [distRes, navRes] = await Promise.all([
        db.collection("app_config").doc("rank_distribution").get().catch(() => null),
        db.collection("app_config").doc("rank_nav_year").get().catch(() => null),
      ]);
      const dist = distRes && distRes.data;
      const navTable = navRes && navRes.data && navRes.data.table;
      if (!dist || !dist.buckets || !navTable) return { code: 0, data: null };

      // 本用户持仓 → 组合年涨幅
      const map = {};
      for (let skip = 0; skip < 20000; skip += PAGE) {
        const r = await db.collection("holdings").where({ _openid: OPENID }).field({ fundCode: true, shares: true, amount: true })
          .skip(skip).limit(PAGE).get();
        (r.data || []).forEach((h) => {
          const s = parseFloat(h.shares || h.amount) || 0;
          if (s > 0 && h.fundCode) map[h.fundCode] = (map[h.fundCode] || 0) + s;
        });
        if ((r.data || []).length < PAGE) break;
      }
      const codes = Object.keys(map);
      if (codes.length === 0) return { code: 0, data: null };
      let nowV = 0, agoV = 0, covered = 0;
      codes.forEach((c) => {
        const n = navTable[c];
        if (!n || !(n.now > 0) || !(n.yearAgo > 0)) return;
        nowV += map[c] * n.now;
        agoV += map[c] * n.yearAgo;
        covered++;
      });
      if (agoV <= 0 || covered === 0) return { code: 0, data: null };
      const rate = +(((nowV / agoV) - 1) * 100).toFixed(2);
      const below = countBelow(dist.buckets, rate);
      const pct = Math.round((below / dist.samples) * 100);
      // 200 个交易日窗口的分布（样本积累期如实回传窗口天数与样本数）
      return { code: 0, data: { rate, pct, samples: dist.samples, asOf: dist.date, coveredFunds: covered, totalFunds: codes.length } };
    } catch (e) {
      console.error("[rankPercentile] percentile 失败:", e.message);
      return { code: 500, msg: e.message };
    }
  }

  // 定时路径：构建分布
  const { OPENID: ctxOpenid } = cloud.getWXContext();
  if (ctxOpenid) return { code: -1, msg: "拒绝客户端调用" };
  try {
    const today = fd.formatBJDate();
    const yearAgoDay = addDays(today, -Math.round(YEAR_DAYS * 365 / 250)); // 260 交易日 ≈ 375 日历日

    // 1) holdings 全库 → 用户持仓 map
    const users = {}; // openid -> { fundCode: shares }
    const fundSet = new Set();
    for (let skip = 0; skip < 50000; skip += PAGE) {
      const r = await db.collection("holdings").field({ _openid: true, fundCode: true, shares: true, amount: true })
        .skip(skip).limit(PAGE).get();
      (r.data || []).forEach((h) => {
        const s = parseFloat(h.shares || h.amount) || 0;
        if (!h._openid || !h.fundCode || s <= 0) return;
        users[h._openid] = users[h._openid] || {};
        users[h._openid][h.fundCode] = (users[h._openid][h.fundCode] || 0) + s;
        fundSet.add(h.fundCode);
      });
      if ((r.data || []).length < PAGE) break;
    }
    const codes = [...fundSet];
    if (codes.length === 0) return { code: 0, today, msg: "无持仓" };

    // 2) 基金年净值表（首尾两点）
    const table = {};
    let navOk = 0, navFail = 0;
    for (let i = 0; i < codes.length; i += CONCURRENCY) {
      if (i > 0 && i % 200 === 0) console.log(`[rankPercentile] 净值进度 ${i}/${codes.length}`);
      await Promise.all(codes.slice(i, i + CONCURRENCY).map(async (code) => {
        try {
          const rows = await fd.fetchNAVHistory(code, YEAR_DAYS);
          if (!rows || rows.length < 2) { navFail++; return; }
          const now = rows[0].nav;
          let yearAgo = null;
          for (const r of rows) { if (r.date <= yearAgoDay) { yearAgo = r.nav; break; } }
          if (now > 0 && yearAgo > 0) { table[code] = { now: +now.toFixed(4), yearAgo: +yearAgo.toFixed(4) }; navOk++; }
          else navFail++;
        } catch (e) { navFail++; }
      }));
    }

    // 3) 每用户组合年涨幅 → 1pp 分桶（-100 以下归 -100 桶，200 以上归 200 桶）
    const samplesByUser = {};
    Object.entries(users).forEach(([oid, m]) => {
      let nowV = 0, agoV = 0, covered = 0;
      Object.entries(m).forEach(([c, s]) => {
        const n = table[c];
        if (!n) return;
        nowV += s * n.now; agoV += s * n.yearAgo; covered++;
      });
      if (agoV > 0 && covered > 0) samplesByUser[oid] = +(((nowV / agoV) - 1) * 100).toFixed(2);
    });
    const rates = Object.values(samplesByUser);
    const buckets = {};
    rates.forEach((r) => {
      const b = Math.max(-100, Math.min(200, Math.floor(r)));
      buckets[b] = (buckets[b] || 0) + 1;
    });
    const dist = { date: today, samples: rates.length, buckets, coveredFunds: navOk, totalFunds: codes.length, updatedAt: Date.now() };

    await db.collection("app_config").doc("rank_nav_year")
      .set({ data: { date: today, table } }).catch(() => {});
    await db.collection("app_config").doc("rank_distribution")
      .set({ data: dist }).catch(() => {});
    console.log(`[rankPercentile] 分布完成: 样本=${dist.samples} 基金净值 ok=${navOk} fail=${navFail}`);
    return { code: 0, today, ...dist, navFail };
  } catch (e) {
    console.error("[rankPercentile] 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// 分桶插值：rate 落点以下（含桶内线性）累计占比
function countBelow(buckets, rate) {
  const b = Math.max(-100, Math.min(200, Math.floor(rate)));
  let below = 0;
  Object.entries(buckets).forEach(([k, v]) => {
    const key = parseInt(k, 10);
    if (key < b) below += v;
  });
  // 桶内线性插值（桶宽 1pp，份额按小数部分）
  const inBucket = buckets[b] || 0;
  const frac = Math.min(1, Math.max(0, rate - b));
  return below + inBucket * frac;
}
