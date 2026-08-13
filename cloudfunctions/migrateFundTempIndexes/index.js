const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 一次性迁移：把 fund_temperatures 旧随机 _id 文档归一化为 `fundCode_date` 确定性 _id。
// computeFundTemperature 从「remove+add 随机 _id」改为「doc(fundCode_date).set() upsert」后，
// 存量旧文档与新增确定性文档并存。本函数把旧格式文档内容 upsert 到确定性 _id 再删旧文档。
// - set() 幂等覆盖：同 (fundCode,date) 已有确定性文档时内容一致，覆盖无害
// - 支持 offset 分批续跑（预算内处理尽可能多，返回 nextOffset；调用方循环直到 done）
// 幂等可重复运行，保留全部数据。
exports.main = async (event) => {
  const startOffset = (event && event.offset) || 0;
  const COLL = "fund_temperatures";
  const NEW_ID_RE = /^\d{6}_\d{4}-\d{2}-\d{2}$/;
  const _start = Date.now();
  const stats = { scanned: 0, migrated: 0, deleted: 0, nextOffset: startOffset, done: false };

  try {
    const MAX_LIMIT = 100;
    let offset = startOffset;
    while (true) {
      if (Date.now() - _start > 105000) {
        stats.done = false;
        console.log(`[migrate] 时间预算用尽，处理到 offset=${offset}`);
        break;
      }
      const res = await db.collection(COLL).skip(offset).limit(MAX_LIMIT).get();
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

      if (docs.length < MAX_LIMIT) { stats.done = true; break; }
      offset += MAX_LIMIT;
      stats.nextOffset = offset;
    }

    const msg = stats.done ? "迁移完成" : `预算用尽，继续调用 offset=${stats.nextOffset}`;
    console.log(`[migrate] ${msg}: ${JSON.stringify(stats)} cost=${Date.now() - _start}ms`);
    return { code: 0, data: stats };
  } catch (e) {
    console.error("[migrate] 异常:", e.message);
    return { code: 500, msg: e.message, data: stats };
  }
};
