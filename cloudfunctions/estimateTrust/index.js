const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 估算可信度个人化（信任线：自曝估算误差的聚合视图）
 *
 * 数据源 fund_estimate_deviations（snapshotEstimateDeviation 每交易日收盘落库：
 * { fundCode, date, estRate, actualRate, diff=estRate-actualRate }，全市场共用一表）。
 * 按当前用户持仓品种聚合近 35 天样本：
 *   overall  加权平均偏差（meanAbs=平均绝对偏差 pp，meanSigned=方向，正=估算偏高）
 *   best/worst  最准/最不准品种（n≥MIN_N 才参与评选，样本少不评选不虚构）
 * 只读不写；样本随交易日积累（2026-09-28 起落库），早期 n 小属预期。
 */

const COLL = "fund_estimate_deviations";
const WINDOW_DAYS = 35; // 自然日窗口，覆盖约 25 个交易日
const MIN_N = 3;        // 参与最准/最不准评选的最小样本数

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };
  try {
    const holdRes = await db.collection("holdings")
      .where({ _openid: OPENID })
      .field({ fundCode: true, fundName: true })
      .limit(1000).get();
    const nameMap = {};
    const codes = [];
    (holdRes.data || []).forEach((h) => {
      if (!h || !h.fundCode) return;
      if (!nameMap[h.fundCode]) {
        nameMap[h.fundCode] = h.fundName || h.fundCode;
        codes.push(h.fundCode);
      }
    });
    if (!codes.length) return { code: 0, data: { hasFunds: false } };

    const cutoff = new Date(Date.now() + 8 * 3600000 - WINDOW_DAYS * 86400000)
      .toISOString().slice(0, 10);

    // 按品种分块查询（_.in 上限保护），云函数端单页上限 1000，不足再翻页
    const rows = {}; // code -> { n, absSum, signedSum, dates:{} }
    for (let i = 0; i < codes.length; i += 50) {
      const chunk = codes.slice(i, i + 50);
      for (let skip = 0; skip < 5000; skip += 1000) {
        const res = await db.collection(COLL)
          .where({ fundCode: _.in(chunk), date: _.gte(cutoff) })
          .field({ fundCode: true, date: true, diff: true })
          .skip(skip).limit(1000).get();
        (res.data || []).forEach((d) => {
          if (typeof d.diff !== "number" || !d.date || !d.fundCode) return;
          const r = rows[d.fundCode] || (rows[d.fundCode] = { n: 0, absSum: 0, signedSum: 0, dates: {} });
          r.n++;
          r.absSum += Math.abs(d.diff);
          r.signedSum += d.diff;
          r.dates[d.date] = true;
        });
        if ((res.data || []).length < 1000) break;
      }
    }

    const list = Object.keys(rows).map((code) => ({
      fundCode: code,
      fundName: nameMap[code] || code,
      n: rows[code].n,
      meanAbs: +(rows[code].absSum / rows[code].n).toFixed(2),
      meanSigned: +(rows[code].signedSum / rows[code].n).toFixed(2),
    }));
    list.sort((a, b) => b.meanAbs - a.meanAbs); // 最不准在前

    const dates = {};
    let totalN = 0, absSumAll = 0, signedSumAll = 0;
    Object.values(rows).forEach((r) => {
      Object.keys(r.dates).forEach((d) => { dates[d] = true; });
      totalN += r.n;
      absSumAll += r.absSum;
      signedSumAll += r.signedSum;
    });
    const eligible = list.filter((r) => r.n >= MIN_N);
    return { code: 0, data: {
      hasFunds: true,
      fundCount: codes.length,
      sampledFunds: list.length,
      hasData: totalN > 0,
      window: { from: cutoff, sampleDays: Object.keys(dates).length },
      overall: totalN ? {
        n: totalN,
        meanAbs: +(absSumAll / totalN).toFixed(2),
        meanSigned: +(signedSumAll / totalN).toFixed(2),
      } : null,
      best: eligible.length ? eligible[eligible.length - 1] : null,
      worst: eligible.length ? eligible[0] : null,
      rows: list.slice(0, 12),
    } };
  } catch (e) {
    console.error("estimateTrust 失败:", e.message);
    return { code: 500, msg: "估算可信度统计失败" };
  }
};
