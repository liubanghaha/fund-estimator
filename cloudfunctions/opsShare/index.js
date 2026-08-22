const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 运营增长 — 分享链路闭环
 *
 *  action:
 *    createToken  分享者生成分享令牌（含持仓收益摘要，7 天有效，旧令牌自动清理）
 *    getCard      被分享者凭令牌读取分享者持仓摘要（无需登录）
 *    trackVisit   渠道小程序码扫码上报（同用户同渠道每天只记一次）
 */

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randToken(len = 16) {
  let s = "";
  for (let i = 0; i < len; i++) s += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  return s;
}

function bjDate() {
  const d = new Date(Date.now() + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (e) { /* 已存在 */ }
}

exports.main = async (event) => {
  const { action } = event || {};
  const { OPENID } = cloud.getWXContext();

  try {
    // ===== 分享令牌生成 =====
    if (action === "createToken") {
      if (!OPENID) return { code: 401, msg: "请先登录" };
      const { todayProfit, todayProfitRate, totalReturn, totalReturnRate, fundCount, fundNames, nickName } = event;
      const token = randToken();
      await ensureCollection("share_tokens");
      // 清理该用户旧令牌，只保留最新一条
      try {
        const old = await db.collection("share_tokens").where({ openid: OPENID }).get();
        await Promise.all((old.data || []).map((d) => db.collection("share_tokens").doc(d._id).remove()));
      } catch (e) { /* 清理失败不影响主流程 */ }
      await db.collection("share_tokens").add({
        data: {
          token,
          openid: OPENID,
          nickName: String(nickName || "").slice(0, 20),
          data: {
            todayProfit: String(todayProfit || "0"),
            todayProfitRate: String(todayProfitRate || "0"),
            totalReturn: String(totalReturn || "0"),
            totalReturnRate: String(totalReturnRate || "0"),
            fundCount: parseInt(fundCount, 10) || 0,
            fundNames: Array.isArray(fundNames)
              ? fundNames.slice(0, 20).map((f) => ({ code: String(f.code || ""), name: String(f.name || "") }))
              : [],
          },
          createTime: new Date(),
          expireAt: new Date(Date.now() + TOKEN_TTL_MS),
        },
      });
      return { code: 0, data: { token } };
    }

    // ===== 被分享者读取摘要 =====
    if (action === "getCard") {
      const { token } = event;
      if (!token || typeof token !== "string" || token.length > 32) return { code: 400, msg: "参数错误" };
      await ensureCollection("share_tokens");
      const res = await db.collection("share_tokens").where({ token }).get();
      const doc = res.data && res.data[0];
      if (!doc) return { code: 404, msg: "链接已失效" };
      if (new Date(doc.expireAt).getTime() < Date.now()) return { code: 404, msg: "链接已失效" };
      return { code: 0, data: { nickName: doc.nickName, ...doc.data } };
    }

    // ===== 渠道扫码上报 =====
    if (action === "trackVisit") {
      const { channelId } = event;
      if (!channelId || typeof channelId !== "string" || channelId.length > 32) return { code: 400, msg: "参数错误" };
      await ensureCollection("promo_visits");
      // 已登录用户：同渠道每天只记一次；匿名用户不计数（避免空 openid 只留 1 条）
      const today = bjDate();
      if (OPENID) {
        const exist = await db.collection("promo_visits").where({ channelId, openid: OPENID, date: today }).count();
        if (exist.total === 0) {
          await db.collection("promo_visits").add({
            data: { channelId, openid: OPENID, date: today, createTime: new Date() },
          });
        }
      }
      return { code: 0 };
    }

    return { code: 400, msg: "未知操作: " + action };
  } catch (e) {
    console.error("[opsShare]", e);
    return { code: 500, msg: e.message };
  }
};
