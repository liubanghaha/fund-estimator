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
      default:
        return { code: 400, msg: "未知操作" };
    }
  } catch (e) {
    console.error("manageTransaction error:", e);
    return { code: 500, msg: "操作失败" };
  }
};
