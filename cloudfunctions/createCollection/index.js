const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const results = [];
  const collections = ["holdings", "watchlist", "transactions"];

  for (const name of collections) {
    try {
      await db.createCollection(name);
      results.push(`${name}: 创建成功`);
    } catch (e) {
      if (e.errCode === -502005) {
        results.push(`${name}: 已存在`);
      } else {
        results.push(`${name}: ${e.message || "创建失败"}`);
      }
    }
  }

  return { code: 0, msg: results.join("; ") };
};
