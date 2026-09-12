const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
      default:
        return { code: 400, msg: "未知操作" };
    }
  } catch (e) {
    console.error("manageTransaction error:", e);
    return { code: 500, msg: "操作失败" };
  }
};
