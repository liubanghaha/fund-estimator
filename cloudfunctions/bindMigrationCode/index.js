const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 迁移数据集合（不含 profit_snapshots 历史快照，盘中自动重算）
const MIGRATE_COLLECTIONS = ["holdings", "watchlist", "transactions"];

// 迁移码认领：老数据以 h5_uid 为键导入新环境，
// 用户在新小程序输入迁移码后，把 h5_uid 名下的数据复制到当前 OPENID 名下。
exports.main = async (event) => {
  const { code } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };
  if (!code || !/^[a-z0-9]{6}$/i.test(code)) return { code: 400, msg: "迁移码格式不正确" };

  try {
    // 1. 校验迁移码
    const codeRes = await db.collection("migration_codes")
      .where({ code: code.toLowerCase(), used: false }).limit(1).get();
    if (!codeRes.data.length) return { code: 404, msg: "迁移码无效或已被使用" };
    const { h5Uid } = codeRes.data[0];

    // 2. 防重复绑定
    const existBind = await db.collection("h5_bindings").where({ openid: OPENID }).limit(1).get();
    if (existBind.data.length) return { code: 400, msg: "该账号已完成过数据迁移" };

    // 3. 复制 h5_uid 数据到当前 OPENID（认领）
    const summary = {};
    for (const col of MIGRATE_COLLECTIONS) {
      let moved = 0;
      let docs = await db.collection(col).where({ _openid: h5Uid }).limit(1000).get();
      while (docs.data.length) {
        for (const doc of docs.data) {
          const { _id, _openid, ...rest } = doc;
          await db.collection(col).add({ data: { ...rest, _openid: OPENID } });
          await db.collection(col).doc(_id).remove();
          moved++;
        }
        if (docs.data.length < 1000) break;
        docs = await db.collection(col).where({ _openid: h5Uid }).limit(1000).get();
      }
      summary[col] = moved;
    }

    // 4. 记录绑定 + 迁移码标记已用
    await db.collection("h5_bindings").add({
      data: { openid: OPENID, h5Uid, createTime: new Date() },
    });
    await db.collection("migration_codes").doc(codeRes.data[0]._id)
      .update({ data: { used: true } });

    return { code: 0, msg: "迁移成功", data: summary };
  } catch (e) {
    console.error("迁移失败:", e);
    return { code: 500, msg: "迁移失败，请稍后重试" };
  }
};
