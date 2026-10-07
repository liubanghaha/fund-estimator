const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fd = require("./_shared/fund-data");

// 操作归因枚举（可选单选，纯记录无建议）：白名单校验，非法值存空串防脏数据
const REASONS = ["跌怕了", "涨急了", "要用钱", "按计划", "没忍住"];

exports.main = async (event) => {
  const { action, data, fundCode } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };

  try {
    switch (action) {
      case "add": {
        if (!data || !data.fundCode) return { code: 400, msg: "缺少参数" };
        await db.collection("transactions").add({
          data: { ...data, reason: REASONS.includes(data.reason) ? data.reason : "", _openid: OPENID, createTime: new Date() },
        });
        return { code: 0, msg: "success" };
      }
      case "list": {
        const { skip = 0, limit = 100 } = event;
        const w = { _openid: OPENID };
        if (fundCode) w.fundCode = fundCode;
        const res = await db.collection("transactions")
          .where(w).orderBy("createTime", "desc").skip(skip).limit(Math.min(limit, 100)).get();
        return { code: 0, data: res.data || [] };
      }
      case "shadow": {
        // 影子账户（产品规划 A2 最小版）：卖出记录 × 最新官方净值 → "如果没卖"演算。
        // 口径：卖出份额 × (最新单位净值 − 卖出时单位净值)，不含分红再投影响；纯事实演算无建议
        const res = await db.collection("transactions")
          .where({ _openid: OPENID, type: "sell" })
          .orderBy("createTime", "desc").limit(50).get();
        const sells = res.data || [];
        if (!sells.length) return { code: 0, data: { items: [], total: null, hasData: false } };
        const codes = [...new Set(sells.map((s) => s.fundCode).filter(Boolean))];
        const navMap = {};
        await Promise.all(codes.map(async (code) => {
          try {
            const r = await fd.fetchLatestNavEastMoney(code);
            if (r && r.actualNav > 0) navMap[code] = r.actualNav;
          } catch (e) { /* 单基金失败留空，前端显示 -- */ }
        }));
        const items = sells.map((s) => {
          const shares = parseFloat(s.shares) || 0;
          const price = parseFloat(s.price) || 0;
          const nav = navMap[s.fundCode] || null;
          return {
            fundCode: s.fundCode, fundName: s.fundName || s.fundCode, date: s.date || "",
            shares, price, nav,
            shadow: nav != null ? +(shares * (nav - price)).toFixed(2) : null,
          };
        });
        const withVal = items.filter((i) => i.shadow != null);
        return { code: 0, data: {
          items,
          total: withVal.length ? +withVal.reduce((sum, i) => sum + i.shadow, 0).toFixed(2) : null,
          hasData: withVal.length > 0,
        } };
      }
      case "xirr": {
        // 真实年化（货币加权 XIRR，信任线/行为线交叉）：全部买卖流水为现金流，
        // 有流水品种的最新市值为终值。口径：品种粒度覆盖——有流水记录的品种才计入，
        // 未记流水的持仓不计入（前端披露只数）；净值暂缺的品种整体剔除（其流水一并剔除，
        // 否则"投了钱没终值"会严重歪曲年化）。
        const trades = [];
        for (let skip = 0; skip < 5000; skip += 1000) {
          const res = await db.collection("transactions")
            .where({ _openid: OPENID })
            .orderBy("date", "asc")
            .skip(skip).limit(1000).get();
          trades.push(...(res.data || []));
          if ((res.data || []).length < 1000) break;
        }
        const valid = trades.filter((t) => t && t.date && t.fundCode);
        if (!valid.length) return { code: 0, data: { hasData: false } };

        // 持仓 → 每品种当前份额（shares 新 schema / amount÷nav 旧 schema，与复盘中心同式）
        const holdRes = await db.collection("holdings")
          .where({ _openid: OPENID })
          .field({ fundCode: true, shares: true, buyPrice: true, nav: true, amount: true })
          .limit(1000).get();
        const sharesByFund = {};
        (holdRes.data || []).forEach((h) => {
          if (!h || !h.fundCode) return;
          let s = parseFloat(h.shares) || 0;
          const bp = parseFloat(h.buyPrice) || parseFloat(h.nav) || 0;
          if (!s && h.amount && bp > 0) s = parseFloat(h.amount) / bp;
          if (s > 0) sharesByFund[h.fundCode] = (sharesByFund[h.fundCode] || 0) + s;
        });

        const codes = [...new Set(valid.map((t) => t.fundCode))];
        const navMap = {};
        await Promise.all(codes.map(async (code) => {
          try {
            const r = await fd.fetchLatestNavEastMoney(code);
            if (r && r.actualNav > 0) navMap[code] = r.actualNav;
          } catch (e) { /* 单只失败走剔除口径 */ }
        }));
        const excluded = codes.filter((c) => (sharesByFund[c] || 0) > 0 && !navMap[c]);
        const usable = codes.filter((c) => excluded.indexOf(c) < 0);
        const usableSet = {};
        usable.forEach((c) => { usableSet[c] = true; });

        // 现金流：买入为负、卖出为正，同日合并；终值 = 有流水品种 Σ 份额×最新净值
        const byDay = {};
        let buyCount = 0, sellCount = 0, buyAmount = 0, sellAmount = 0;
        valid.forEach((t) => {
          if (!usableSet[t.fundCode]) return;
          const shares = parseFloat(t.shares) || 0;
          const price = parseFloat(t.price) || 0;
          const amount = parseFloat(t.amount) || +(shares * price).toFixed(2);
          if (!(amount > 0)) return;
          const type = t.type === "sell" ? "sell" : t.type === "buy" ? "buy" : null;
          if (!type) return;
          byDay[t.date] = (byDay[t.date] || 0) + (type === "buy" ? -amount : amount);
          if (type === "buy") { buyCount++; buyAmount += amount; }
          else { sellCount++; sellAmount += amount; }
        });
        const days = Object.keys(byDay).sort();
        let terminal = 0;
        usable.forEach((c) => { terminal += (sharesByFund[c] || 0) * (navMap[c] || 0); });
        const flows = days.map((d) => ({ date: d, amount: +byDay[d].toFixed(2) }));
        if (terminal > 0.005) {
          const bjNow = new Date(Date.now() + 8 * 3600000);
          flows.push({ date: bjNow.toISOString().slice(0, 10), amount: +terminal.toFixed(2) });
        }

        const hasNeg = flows.some((f) => f.amount < 0);
        const hasPos = flows.some((f) => f.amount > 0);
        // 短流水期（<90 天）的年化是复利外推的天文数字，无参考价值 → 不解，
        // 前端只展示同口径不折时累计（periodDays 供前端文案）
        const periodDays = days.length
          ? Math.round((Date.now() + 8 * 3600000 - Date.parse(days[0] + "T00:00:00+08:00")) / 86400000)
          : 0;
        const xirr = hasNeg && hasPos && flows.length >= 2 && periodDays >= 90 ? solveXIRR(flows) : null;
        const netProfit = terminal + sellAmount - buyAmount;
        return { code: 0, data: {
          hasData: true,
          funds: usable.length,
          uncovered: Object.keys(sharesByFund).filter((c) => !codes.includes(c)).length,
          excludedCount: excluded.length,
          buyCount, sellCount,
          buyAmount: +buyAmount.toFixed(2), sellAmount: +sellAmount.toFixed(2),
          terminalValue: +terminal.toFixed(2),
          firstDate: days[0] || "", lastDate: days[days.length - 1] || "",
          periodDays,
          xirr,
          simple: buyAmount > 0 ? { profit: +netProfit.toFixed(2), rate: +(netProfit / buyAmount * 100).toFixed(2) } : null,
        } };
      }
      default:
        return { code: 400, msg: "未知操作" };
    }
  } catch (e) {
    console.error("manageTransaction error:", e);
    return { code: 500, msg: "操作失败" };
  }
};

/**
 * XIRR 年化收益率（二分法，dcaBacktest.calcXIRR 的任意现金流版）
 * flows: [{ date: "YYYY-MM-DD", amount }]，投入为负、回款为正；年化按 365.25 天折算。
 * 无符号变化（全同日/单边现金流）时无解，返回 null 由前端显示 "--"。
 */
function solveXIRR(flows) {
  const t0 = Date.parse(flows[0].date + "T00:00:00+08:00");
  const yrs = (d) => Math.max(0, (Date.parse(d + "T00:00:00+08:00") - t0) / (365.25 * 86400000));
  const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, yrs(f.date)), 0);
  let lo = -0.9999, hi = 100;
  let fLo = npv(lo), fHi = npv(hi);
  // 真实存在的极端解（钱大部分近期进、短期大涨，货币加权年化远超 100 倍）：逐级放宽上界找变号
  for (let k = 0; k < 4 && isFinite(fLo) && isFinite(fHi) && fLo * fHi > 0; k++) {
    hi *= 10;
    fHi = npv(hi);
  }
  if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = npv(mid);
    if (Math.abs(v) < 0.005) return +(mid * 100).toFixed(2);
    if (fLo * v < 0) hi = mid; else lo = mid;
  }
  return +(((lo + hi) / 2) * 100).toFixed(2);
}
