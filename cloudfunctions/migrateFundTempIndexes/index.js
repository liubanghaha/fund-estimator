const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 一次性迁移：把 fund_temperatures 旧随机 _id 文档归一化为 `fundCode_date` 确定性 _id。
// computeFundTemperature 从「remove+add 随机 _id」改为「doc(fundCode_date).set() upsert」后，
// 存量旧文档与新增确定性文档并存。本函数把旧格式文档内容 upsert 到确定性 _id 再删旧文档。
// - set() 幂等覆盖：同 (fundCode,date) 已有确定性文档时内容一致，覆盖无害
// - 支持 lastId 游标分批续跑（预算内处理尽可能多，返回 nextId；调用方循环直到 done）。
//   原 skip 分页在页内删除文档后会前移漂移（漏掉未处理的旧文档、假完成）
// 幂等可重复运行，保留全部数据。
exports.main = async (event) => {
  // 一次性迁移任务（2026-11-08 P0 加守卫）：可 upsert+删除 fund_temperatures 文档，
  // 仅限定时器或服务端 CLI 调用——客户端 OPENID 一律拒绝
  const { OPENID: _mgOpenid } = cloud.getWXContext();
  if (_mgOpenid) return { code: -1, msg: "迁移任务仅限服务端调用" };
  const cloudDb = cloud.database();
  const _cmd = cloudDb.command;
  const startId = (event && event.lastId) || "";
  const COLL = "fund_temperatures";
  const NEW_ID_RE = /^\d{6}_\d{4}-\d{2}-\d{2}$/;
  const _start = Date.now();
  const stats = { scanned: 0, migrated: 0, deleted: 0, nextId: startId, done: false };

  try {
    const MAX_LIMIT = 100;
    let lastId = startId;
    while (true) {
      if (Date.now() - _start > 105000) {
        stats.done = false;
        console.log(`[migrate] 时间预算用尽，处理到 lastId=${lastId}`);
        break;
      }
      // _id 游标分页：删除文档不影响游标推进（skip 分页会漂移）
      const q = db.collection(COLL).limit(MAX_LIMIT).orderBy("_id", "asc");
      const res = lastId ? await q.where({ _id: _cmd.gt(lastId) }).get() : await q.get();
      const docs = res.data || [];
      if (!docs.length) { stats.done = true; break; }

      for (const doc of docs) {
        if (NEW_ID_RE.test(doc._id)) { stats.scanned++; continue; } // 已是新格式（skip 分页含新文档）
        stats.scanned++;
        const { _id, fundCode, date } = doc;
        if (!fundCode || !date) { continue; }
        try {
          const { _id: _oid, ...rest } = doc;
          delete rest._openid;
          // 幂等 upsert（同 fundCode_date 已存在则覆盖，内容一致）
          await db.collection(COLL).doc(`${fundCode}_${date}`).set({ data: rest });
          await db.collection(COLL).doc(_id).remove();
          stats.migrated++;
          stats.deleted++;
        } catch (e) {
          console.error(`[migrate] 处理 ${_id} 失败:`, e.message);
        }
      }

      lastId = docs[docs.length - 1]._id;
      stats.nextId = lastId;
      if (docs.length < MAX_LIMIT) { stats.done = true; break; }
    }

    const msg = stats.done ? "迁移完成" : `预算用尽，继续调用 lastId=${stats.nextId}`;
    console.log(`[migrate] ${msg}: ${JSON.stringify(stats)} cost=${Date.now() - _start}ms`);
    return { code: 0, data: stats };
  } catch (e) {
    console.error("[migrate] 异常:", e.message);
    return { code: 500, msg: e.message, data: stats };
  }
};
