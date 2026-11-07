const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const https = require("https");
const { sendAdminAlert } = require("./_shared/admin-alert");

/**
 * 用户财务数据每日备份（2026-11-07 生产级补课 #3：数据安全）
 *
 * 备什么：holdings / transactions / goals / feedback（P0——用户的钱和账本 + 用户声音，
 *   无法重建）；温度/快照/误差台账等可由定时任务重建，不备。
 * 备到哪：本环境云存储 backup/<日期>/<集合>.jsonl——云存储底层 COS，与数据库不同故障域；
 *   保持默认私有权限（仅云函数可读）。
 * 流程：每日 02:30 全量导出（分页 1000、保留 _id）→ JSONL → uploadFile → 维护
 *   app_config/backup_index（fileID 清单）→ 清理 30 天前 → 状态写 app_config/backup_status。
 * 恢复：action=restore（管理员专用，ops_admins 白名单）→ 先把当前状态再备一份（防误恢复）
 *   → 下载 JSONL → 批量 upsert（只补不删：灾难后新增条目保留，语义更安全）。
 * 告警：备份失败 → ops_admins 全员订阅消息（复用「收益到账」模板，secret 走
 *   app_config/wx_app_secret 兜底，43101 未授权降级静默——尽力而为）。
 * 边界：这是灾备（环境库损坏/误删集合），不是版本管理；restore 的日期字段会字符串化
 *   （JSONL 序列化），ISO 格式字典序=时间序，消费方 new Date() 兼容。
 */

const P0_COLLECTIONS = ["holdings", "transactions", "goals", "feedback"];
const RETAIN_DAYS = 30;
const PAGE = 1000;
const BATCH_ADD = 500;
const WX_APPID = "wxb95098fe432ed765";
const TEMPLATE_ID_BRIEF = "xmA8hb_yaI2AWl1Ulhh4J8pE1eBn09udmAvu68beu8s";

function bjDate(ts) {
  return new Date((ts || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function isAdmin(openid) {
  if (!openid) return false;
  try {
    const r = await db.collection("ops_admins").where({ openid }).count();
    return (r.total || 0) > 0;
  } catch (e) { return false; }
}

// 备份失败 → ops_admins 全员订阅消息（尽力而为：未授权 43101 静默）
// 导出单集合为 JSONL 行数组（保留 _id；分页遍历）
async function dumpCollection(name) {
  const lines = [];
  for (let skip = 0; skip < 200000; skip += PAGE) {
    const r = await db.collection(name).skip(skip).limit(PAGE).get();
    (r.data || []).forEach((doc) => lines.push(JSON.stringify(doc)));
    if ((r.data || []).length < PAGE) break;
  }
  return lines;
}

// 30 天前的备份文件清理（按 backup_index 清单）
async function cleanupOld(today) {
  try {
    const idxDoc = await db.collection("app_config").doc("backup_index").get().catch(() => null);
    const idx = (idxDoc && idxDoc.data) || { files: [] };
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
    const stale = (idx.files || []).filter((f) => f.date < cutoff);
    if (stale.length > 0) {
      await cloud.deleteFile({ fileList: stale.map((f) => f.fileID) }).catch(() => {});
      console.log(`[backupData] 清理 ${stale.length} 个过期备份文件（<${cutoff}）`);
    }
    await db.collection("app_config").doc("backup_index").set({
      data: { files: (idx.files || []).filter((f) => f.date >= cutoff), updatedAt: Date.now() },
    }).catch(() => {});
  } catch (e) { console.warn("[backupData] 清理失败（不影响备份本体）:", e.message); }
}

// 备份主流程
async function runBackup(today, opts = {}) {
  const t0 = Date.now();
  const result = { date: today, ok: false, files: [] };
  try {
    for (const coll of P0_COLLECTIONS) {
      const lines = await dumpCollection(coll);
      const content = lines.join("\n");
      const cloudPath = `backup/${today}/${coll}.jsonl`;
      const up = await cloud.uploadFile({ cloudPath, fileContent: Buffer.from(content, "utf8") });
      result.files.push({ coll, cloudPath, fileID: up.fileID, lines: lines.length, bytes: Buffer.byteLength(content) });
    }
    result.ok = true;
  } catch (e) {
    result.error = String(e.message || e).slice(0, 300);
  }
  result.costMs = Date.now() - t0;
  // skipStatus：restore 的 pre-restore 备份不覆盖正式备份状态（否则每日巡检把
  // "2026-11-07-pre-restore" 当成当日备份缺失误报——2026-11-07 巡检首跑实测踩到）
  if (!opts.skipStatus) {
    await db.collection("app_config").doc("backup_status").set({
      data: { ...result, finishedAt: Date.now() },
    }).catch(() => {});
    if (!result.ok) {
      console.error("[backupData] 备份失败:", result.error);
      await sendAdminAlert(db, { title: "数据备份失败", detail: String(result.error || "").slice(0, 20), date: today });
    }
  }
  await cleanupOld(today);
  return result;
}

exports.main = async (event) => {
  const ev = event || {};
  const { OPENID } = cloud.getWXContext();

  // ===== status：管理员查最近备份状态 =====
  if (ev.action === "status") {
    if (!(await isAdmin(OPENID))) return { code: 403, msg: "需要管理员权限" };
    const r = await db.collection("app_config").doc("backup_status").get().catch(() => null);
    return { code: 0, data: (r && r.data) || null };
  }

  // ===== restore：管理员专用——把某日 JSONL 批量 upsert 回库（只补不删） =====
  if (ev.action === "restore") {
    if (!(await isAdmin(OPENID))) return { code: 403, msg: "需要管理员权限" };
    const date = String(ev.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { code: 400, msg: "date 参数无效（YYYY-MM-DD）" };
    const t0 = Date.now();
    const out = { date, restored: {} };
    try {
      const idxDoc = await db.collection("app_config").doc("backup_index").get().catch(() => null);
      const files = ((idxDoc && idxDoc.data && idxDoc.data.files) || []).filter((f) => f.date === date);
      if (files.length === 0) return { code: 404, msg: "该日期无备份记录" };
      // 恢复前先把当前状态再备一份（防误恢复丢新数据）
      await runBackup(bjDate() + "-pre-restore", { skipStatus: true });
      for (const f of files) {
        const dl = await cloud.downloadFile({ fileID: f.fileID });
        const lines = dl.fileContent.toString("utf8").split("\n").filter((l) => l.trim());
        const coll = f.coll;
        try { await db.createCollection(coll); } catch (e) { /* 已存在 */ }
        let n = 0;
        for (let i = 0; i < lines.length; i += BATCH_ADD) {
          const batch = lines.slice(i, i + BATCH_ADD).map((l) => JSON.parse(l));
          await db.collection(coll).add({ data: batch }).catch(async (e) => {
            // 批量含重复 _id 时降级为逐条 upsert（set 支持 _id 不存在则建、存在则覆盖）
            for (const doc of batch) {
              const { _id, ...rest } = doc;
              await db.collection(coll).doc(_id).set({ data: { _id, ...rest } }).catch(() => {});
              n++;
            }
          });
          n += batch.length;
        }
        out.restored[coll] = n;
      }
      out.costMs = Date.now() - t0;
      console.log(`[backupData] 恢复完成 ${date}:`, JSON.stringify(out.restored));
      return { code: 0, ...out };
    } catch (e) {
      console.error("[backupData] 恢复失败:", e.message);
      return { code: 500, msg: String(e.message || e).slice(0, 300) };
    }
  }

  // ===== 定时备份主流程：拒绝客户端调用 =====
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  const today = bjDate();
  const result = await runBackup(today);
  // 维护索引
  try {
    const idxDoc = await db.collection("app_config").doc("backup_index").get().catch(() => null);
    const idx = (idxDoc && idxDoc.data) || { files: [] };
    const merged = [
      ...(idx.files || []).filter((f) => f.date !== today),
      ...result.files.map((f) => ({ date: today, fileID: f.fileID, coll: f.coll })),
    ];
    await db.collection("app_config").doc("backup_index").set({ data: { files: merged, updatedAt: Date.now() } }).catch(() => {});
  } catch (e) { /* 索引失败不影响备份本体 */ }
  console.log(`[backupData] ${today}: ok=${result.ok} files=${result.files.length} t=${result.costMs}ms`);
  return { code: result.ok ? 0 : 500, ...result };
};
