const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 组合目标（2026-11-06 全球调研 Top3：目标进度条，V1 单用户单金额目标）
 *
 * goals 集合：{ _openid, type: "amount", targetAmount, note, createTime, updateTime }
 * 进度由客户端用 getPortfolio 的 totalAmount（与首页资产卡同口径）现算，服务端只存目标本身。
 */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };
  const { action, targetAmount, note } = event || {};

  try {
    try { await db.createCollection("goals"); } catch (e) { /* 已存在 */ }

    if (action === "set") {
      const amt = parseFloat(targetAmount);
      if (!isFinite(amt) || amt <= 0) return { code: 400, msg: "目标金额无效" };
      const doc = {
        _openid: OPENID, type: "amount", targetAmount: +amt.toFixed(2),
        note: String(note || "").slice(0, 30),
        updateTime: Date.now(),
      };
      // 单用户单目标：_id = openid（覆盖式更新）
      await db.collection("goals").doc(OPENID).set({ data: doc });
      return { code: 0, data: doc };
    }

    if (action === "remove") {
      await db.collection("goals").doc(OPENID).remove().catch(() => {});
      return { code: 0 };
    }

    // 默认 get
    try {
      const r = await db.collection("goals").doc(OPENID).get();
      return { code: 0, data: r.data || null };
    } catch (e) {
      return { code: 0, data: null }; // 未设置过目标
    }
  } catch (e) {
    console.error("[manageGoal] 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};
