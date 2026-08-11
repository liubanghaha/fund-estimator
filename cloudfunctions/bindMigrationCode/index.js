const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 迁移数据集合（不含 profit_snapshots 历史快照，盘中自动重算）
const MIGRATE_COLLECTIONS = ["holdings", "watchlist", "transactions"];

// 迁移码认领：老数据以 h5_uid 为键导入新环境，
// 用户在新小程序输入迁移码后，把 h5_uid 名下的数据复制到当前 OPENID 名下。
exports.main = async (event) => {
  const { code } = event;
  const uid = event.testOpenid || cloud.getWXContext().OPENID;
  if (!uid) return { code: 401, msg: "请先登录" };
  if (!code || !/^[a-z0-9]{6}$/i.test(code)) return { code: 400, msg: "迁移码格式不正确" };

  try {
    // 1. 校验迁移码
    const codeRes = await db.collection("migration_codes")
      .where({ code: code.toLowerCase(), used: false }).limit(1).get();
    if (!codeRes.data.length) return { code: 404, msg: "迁移码无效或已被使用" };
    const rec = codeRes.data[0];
    // 认领期间占用标记：防止两个账号同时使用同一迁移码
    if (rec.uid && rec.uid !== uid) return { code: 400, msg: "迁移码已被他人使用" };
    await db.collection("migration_codes").doc(rec._id).update({ data: { uid } });
    const { h5Uid } = rec;

    // 2. 防重复绑定
    const existBind = await db.collection("h5_bindings").where({ openid: uid }).limit(1).get();
    if (existBind.data.length) return { code: 400, msg: "该账号已完成过数据迁移" };

    // 3. 复制 h5_uid 数据到当前账号（认领）
    // 幂等设计：先复制（按 fundCode / _migratedFrom 跳过已复制文档），全部复制成功后再清理旧数据。
    // 中途失败可安全重试，不会产生重复数据或「搬了一半」的状态。
    const summary = {};
    for (const col of MIGRATE_COLLECTIONS) {
      summary[col] = await copyCollection(col, h5Uid, uid);
    }
    // 全部复制成功后再清理旧数据
    for (const col of MIGRATE_COLLECTIONS) {
      await cleanupCollection(col, h5Uid);
    }

    // 4. 记录绑定 + 迁移码标记已用
    await db.collection("h5_bindings").add({
      data: { openid: uid, h5Uid, createTime: new Date() },
    });
    await db.collection("migration_codes").doc(rec._id)
      .update({ data: { used: true } });

    return { code: 0, msg: "迁移成功", data: summary };
  } catch (e) {
    console.error("迁移失败:", e);
    return { code: 500, msg: "迁移失败，请稍后重试" };
  }
};

// ---- 幂等迁移助手 ----

async function copyCollection(col, h5Uid, uid) {
  let moved = 0;
  let docs = await db.collection(col).where({ _openid: h5Uid }).limit(1000).get();
  while (docs.data.length) {
    for (const doc of docs.data) {
      const { _id, _openid, ...rest } = doc;
      // 已复制过的文档跳过（断点续传去重）
      if (col === "transactions") {
        const dup = await db.collection(col).where({ _openid: uid, _migratedFrom: _id }).count();
        if (dup.total > 0) continue;
      } else {
        const dup = await db.collection(col).where({ _openid: uid, fundCode: doc.fundCode }).count();
        if (dup.total > 0) continue;
      }
      const payload = col === "transactions"
        ? { ...rest, _migratedFrom: _id, _openid: uid }
        : { ...rest, _openid: uid };
      await db.collection(col).add({ data: payload });
      moved++;
    }
    if (docs.data.length < 1000) break;
    docs = await db.collection(col).where({ _openid: h5Uid }).limit(1000).get();
  }
  return moved;
}

async function cleanupCollection(col, h5Uid) {
  let docs = await db.collection(col).where({ _openid: h5Uid }).limit(1000).get();
  while (docs.data.length) {
    for (const doc of docs.data) {
      await db.collection(col).doc(doc._id).remove();
    }
    if (docs.data.length < 1000) break;
    docs = await db.collection(col).where({ _openid: h5Uid }).limit(1000).get();
  }
}
