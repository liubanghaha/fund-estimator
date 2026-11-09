const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 交易确认校准（2026-11-05，方案 A"向前修"）
 *
 * 背景：加减仓提交时份额按"提交时刻最新已公布净值"折算（那一刻确认净值还不存在），
 * 与确认日（date，15 点后/节假日已顺延）存在一天错位——确认日净值公布后无人回头重算，
 * 份额误差永久固化，污染收益/回本缺口/费用等一切累积口径。
 *
 * 本任务每日 21:30（净值公布高峰后）扫 confirmed === false 的新交易：
 *   date=D 的确认净值 nav(D) 已公布 → 按差额重算持仓 shares/加权成本，交易置 confirmed=true
 *   nav(D) 未公布（QDII/晚披露）→ 留给明天；date 超出窗口（10 天）→ 放弃并标记保留
 *
 * 口径与边界：
 *   - 只处理 confirmed === false（manageTransaction.add 强制写入）；无此字段的存量交易视为
 *     "用户已接受的历史记录"，绝不翻旧账（账面突变不可追溯）
 *   - buy:  holding.shares += correctShares - tx.shares，加权成本重算
 *     sell: holding.shares += tx.shares - correctShares，成本单价不变
 *   - 多笔持仓：tx.holdingId 精确对（新交易写入时带）；无 holdingId 且该基金多笔 → 跳过（宁缺毋错）
 *   - 持仓已删除：只标记交易 confirmed（无账可调）
 *   - 清仓/异常负份额：收敛到 0；|Δ份额| < 0.005 忽略
 *   - correctShares 与写入端同精度（2 位小数）
 *   - amount/date 不变 → 行为账单/年报/赎回费持有天数全部不受影响
 */

const CONCURRENCY = 5;
const WINDOW_DAYS = 10;      // 确认净值获取窗口：超期放弃（QDII 最晚披露也在此内）
const EPS_SHARES = 0.005;

const addDays = (dateStr, n) => {
  const t = new Date(dateStr + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

exports.main = async (event) => {
  // 定时任务专用：拒绝客户端调用（防伪造重算他人账目）
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  const ev = event || {};
  const dryRun = !!ev.dryRun;
  try {
    const today = fd.formatBJDate();
    const since = addDays(today, -WINDOW_DAYS);

    // 1) 待校准交易：confirmed === false 且 date 在窗口内（含今天：21:30 时当日净值大多已公布）
    const res = await db.collection("transactions")
      .where({ confirmed: false, date: _.gte(since).and(_.lte(today)) })
      .limit(500)
      .get();
    const txs = (res.data || [])
      .filter((t) => (t.type === "buy" || t.type === "sell") && parseFloat(t.amount) > 0);
    if (txs.length === 0) return { code: 0, today, since, total: 0, msg: "无待校准交易" };

    // 2) 按基金去重拉净值（窗口 15 天 > 交易窗口 10 天）：rows[0]=最新（用于市值重算）
    const codes = [...new Set(txs.map((t) => t.fundCode).filter(Boolean))];
    const navMap = {}; // code → { byDate: {D: nav}, latest: nav }
    for (let i = 0; i < codes.length; i += CONCURRENCY) {
      await Promise.all(codes.slice(i, i + CONCURRENCY).map(async (code) => {
        try {
          const rows = await fd.fetchNAVHistory(code, 15);
          if (!rows || !rows.length) return;
          const byDate = {};
          rows.forEach((r) => { if (r && r.date && r.nav > 0) byDate[r.date] = r.nav; });
          navMap[code] = { byDate, latest: rows[0].nav };
        } catch (e) { /* 单基金失败 → 该基金交易本轮跳过 */ }
      }));
    }

    // 3) 逐笔校准（串行：同一持仓多笔时按库返回顺序处理，每笔写回后下一笔读到新值）
    const stat = { total: txs.length, calibrated: 0, skippedNoNav: 0, skippedMulti: 0, noHolding: 0, tinyDelta: 0, dryRun };
    const notes = [];
    for (const tx of txs) {
      // 竞态守卫：扫描列表与逐笔处理之间，另一实例（手动 invoke 撞定时）可能已完成同笔校准——
      // 差额基于各自读时快照，重放会双倍应用。逐笔 re-check confirmed，已确认的跳过
      try {
        const fresh = await db.collection("transactions").doc(tx._id).get();
        if (!fresh.data || fresh.data.confirmed !== false) { stat.total--; continue; }
      } catch (e) { /* 交易被删等：按原记录继续，markConfirmed 会失败但不致错账 */ }
      const navInfo = navMap[tx.fundCode];
      const navD = navInfo && navInfo.byDate[tx.date];
      if (!navD) { stat.skippedNoNav++; continue; }
      const amount = parseFloat(tx.amount);
      // 值域校验（2026-11-09 D-02）：负数/0/超大会污染份额换算与持仓 patch
      if (!(amount > 0) || amount > 1e8) { stat.skippedNoNav++; continue; }
      const correctShares = +(amount / navD).toFixed(2);
      const recordedShares = parseFloat(tx.shares) || 0;

      // 持仓定位：holdingId 优先；缺失时仅当该用户该基金恰好一笔才动（多笔无法对应 → 宁缺毋错）
      let holdDoc = null;
      if (tx.holdingId) {
        try { holdDoc = await db.collection("holdings").doc(tx.holdingId).get(); } catch (e) { holdDoc = null; }
        if (holdDoc && holdDoc.data && holdDoc.data._openid !== tx._openid) holdDoc = null; // 归属校验
      } else {
        const m = await db.collection("holdings").where({ _openid: tx._openid, fundCode: tx.fundCode }).limit(2).get();
        const n = (m.data || []).length;
        if (n === 1) holdDoc = { data: m.data[0] };
        else if (n === 0) { /* 持仓已删/不存在：holdDoc 保持 null，走下方"持仓已删"分支闭环标记 */ }
        else { stat.skippedMulti++; notes.push(`${tx.fundCode}@${tx.date} 多笔无holdingId跳过`); continue; }
      }
      const hold = holdDoc && holdDoc.data;
      if (!hold) {
        // 持仓已删：交易账本仍需闭环（份额已无意义，按确认净值落账并标记）
        if (!dryRun) await markConfirmed(tx._id, correctShares, navD, 0, "持仓已删除");
        stat.noHolding++;
        continue;
      }

      const oldS = parseFloat(hold.shares || hold.amount) || 0;
      const oldP = parseFloat(hold.buyPrice || hold.nav) || 0;
      const isBuy = tx.type === "buy";
      // buy: 正确贡献 - 已记贡献；sell: 已记扣减 - 正确扣减
      const deltaH = isBuy ? (correctShares - recordedShares) : (recordedShares - correctShares);
      let newS = +(oldS + deltaH).toFixed(4);
      if (Math.abs(newS) < EPS_SHARES) newS = 0;
      if (newS < 0) newS = 0; // 历史数据矛盾（超卖已被写入端拦截）→ 收敛清仓

      let newP = oldP;
      if (isBuy && newS > 0) {
        // 加权成本：拆出该笔旧贡献（tx.shares×tx.price），换入正确贡献（correctShares×navD）
        const oldCost = oldP * oldS;
        const removed = recordedShares * (parseFloat(tx.price) || oldP);
        const added = correctShares * navD;
        newP = oldS > 0 ? +((oldCost - removed + added) / newS).toFixed(4) : +navD.toFixed(4);
      }

      const tiny = Math.abs(deltaH) < EPS_SHARES && (!isBuy || Math.abs((parseFloat(tx.price) || 0) - navD) < 0.0001);
      if (tiny) {
        // 份额与价差都在容差内：仅标记，不动账
        if (!dryRun) await markConfirmed(tx._id, correctShares, navD, 0, "");
        stat.tinyDelta++;
        continue;
      }

      const latestNav = navInfo.latest || navD;
      const finalMV = +(newS * latestNav).toFixed(2);
      const finalHR = +(finalMV - newS * newP).toFixed(2);
      const patch = { shares: newS, marketValue: finalMV, holdingReturn: finalHR };
      if (newP > 0) { patch.buyPrice = newP; patch.buyAmount = +(newS * newP).toFixed(2); }

      if (!dryRun) {
        // 竞态终防（2026-11-09 D-02）：holdings 快照可能已过期（并发写入/用户操作）——
        // 校验 shares 仍等于扫描时的值才 patch；不匹配则本轮放弃（confirmed 也不标，下轮重扫）
        const recheck = await db.collection("holdings").doc(hold._id).get().catch(() => null);
        const curShares = recheck && recheck.data ? (parseFloat(recheck.data.shares || recheck.data.amount) || 0) : -1;
        if (Math.abs(curShares - oldS) > EPS_SHARES) {
          notes.push(`${tx.fundCode}@${tx.date} 持仓并发变更，跳过本轮`);
          continue;
        }
        await db.collection("holdings").doc(hold._id).update({ data: patch });
        await markConfirmed(tx._id, correctShares, navD, deltaH, "");
      }
      stat.calibrated++;
      notes.push(`${tx.fundCode}@${tx.date} ${tx.type} Δ份额=${deltaH.toFixed(2)} 价${tx.price}→${navD}`);
    }

    console.log(`[confirmTransactions] ${JSON.stringify(stat)}`);
    return { code: 0, today, since, ...stat, notes: notes.slice(0, 20) };
  } catch (e) {
    console.error("[confirmTransactions] 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// 交易置已确认：记录确认净值/份额差额（时间线可追溯），幂等（重跑时 confirmed 已 true 不会再进扫描）
async function markConfirmed(txId, correctShares, navD, deltaH, note) {
  await db.collection("transactions").doc(txId).update({
    data: {
      shares: correctShares,
      price: navD,
      confirmed: true,
      confirmedAt: Date.now(),
      confirmedDeltaShares: +deltaH.toFixed(4),
      confirmedNote: note || "",
    },
  }).catch(() => {});
}
