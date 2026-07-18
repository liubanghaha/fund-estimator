const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { action, data, fundCode } = event;
  const { OPENID } = cloud.getWXContext();
  const uid = event.testOpenid || OPENID;
  if (!uid) return { code: 401, msg: "未登录" };

  try {
    switch (action) {
      case "add": {
        if (!data || !data.fundCode) return { code: 400, msg: "缺少参数" };
        await db.collection("transactions").add({
          data: { ...data, _openid: uid, createTime: new Date() },
        });
        return { code: 0, msg: "success" };
      }
      case "list": {
        const { skip = 0, limit = 100 } = event;
        const w = { _openid: uid };
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
