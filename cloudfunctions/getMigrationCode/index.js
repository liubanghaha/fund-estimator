const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 查询当前用户的数据迁移码（新小程序同步数据用）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };

  try {
    const res = await db.collection("migration_codes")
      .where({ _openid: OPENID }).limit(1).get();
    if (!res.data.length) return { code: 404, msg: "未生成迁移码" };
    return { code: 0, data: { code: res.data[0].code } };
  } catch (e) {
    console.error("查询迁移码失败:", e);
    return { code: 500, msg: "查询失败，请重试" };
  }
};
