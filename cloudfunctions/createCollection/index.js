const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  try {
    await db.createCollection("holdings");
    return { code: 0, msg: "集合创建成功" };
  } catch (e) {
    if (e.errCode === -502005) {
      return { code: 0, msg: "集合已存在" };
    }
    return { code: 500, msg: e.message || "创建失败" };
  }
};
