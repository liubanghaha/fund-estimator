#!/usr/bin/env node
/**
 * 云数据库索引创建（2026-11-08）：通过 TCB RunCommands 的 MongoDB createIndexes 命令。
 * 用法：node scripts/create-indexes.js（密钥读 ~/.zcode/cli/config.json 的 CloudBase MCP env；
 *       注意该密钥归属的账号需包含目标环境 cloud1-d7gu9zv3i796839b8）。
 * 命令格式（与 Mongo 原生的差异）：{ createIndexes: "集合名", indexes: [{ key: {...}, name: "..." }] }
 * —— MongoDB 原生是 index 字段，TCB flexdb 只认 indexes；幂等（同名同 key 重复建为 no-op）。
 * 新增索引在 TARGETS 数组追加即可。
 */
const CloudBase = require("@cloudbase/manager-node/lib/index.js");
const config = require("/Users/liubangwe/.zcode/cli/config.json");

// 从 MCP 配置取 TCB 密钥（账号级，可操作任意环境）
let secretId, secretKey;
(function dig(o) {
  if (o && typeof o === "object") {
    if (o.TENCENTCLOUD_SECRETID) { secretId = o.TENCENTCLOUD_SECRETID; secretKey = o.TENCENTCLOUD_SECRETKEY; }
    Object.values(o).forEach(v => dig(v));
  }
})(config);
if (!secretId) { console.error("未找到 TCB 密钥"); process.exit(1); }
console.log("密钥 OK:", secretId.slice(0, 8) + "...", "| env: cloud1-d7gu9zv3i796839b8");

const app = new CloudBase({ secretId, secretKey, envId: "cloud1-d7gu9zv3i796839b8" });
const db = app.database;

// 目标索引（2026-11-08 性能审查清单）
const TARGETS = [
  { coll: "fund_temperatures", name: "fundCode_1_date_-1", keys: [{ FieldName: "fundCode", Direction: "1" }, { FieldName: "date", Direction: "-1" }] },
  { coll: "fund_temperatures", name: "date_1_signal_1", keys: [{ FieldName: "date", Direction: "1" }, { FieldName: "signal", Direction: "1" }] },
  { coll: "fund_estimate_deviations", name: "fundCode_1_date_1", keys: [{ FieldName: "fundCode", Direction: "1" }, { FieldName: "date", Direction: "1" }] },
  { coll: "profit_snapshots", name: "_openid_1_date_-1", keys: [{ FieldName: "_openid", Direction: "1" }, { FieldName: "date", Direction: "-1" }] },
  { coll: "transactions", name: "_openid_1_date_-1", keys: [{ FieldName: "_openid", Direction: "1" }, { FieldName: "date", Direction: "-1" }] },
  { coll: "events", name: "ts_-1", keys: [{ FieldName: "ts", Direction: "-1" }] },
  { coll: "push_logs", name: "sentAt_-1", keys: [{ FieldName: "sentAt", Direction: "-1" }] },
  { coll: "subscriptions", name: "_openid_1_scene_1", keys: [{ FieldName: "_openid", Direction: "1" }, { FieldName: "scene", Direction: "1" }] },
];

async function main() {
  // 先看一个现有集合的索引格式参考
  const desc = await db.describeCollection("fund_temperatures");
  console.log("现有 Indexes 格式参考:", JSON.stringify((desc.Indexes || []).slice(0, 2)));
  const existing = {};
  (desc.Indexes || []).forEach(i => { existing[i.Name] = true; });
  console.log("fund_temperatures 现有索引:", Object.keys(existing).join(", ") || "（无）");

  for (const t of TARGETS) {
    try {
      const exists = await db.checkIndexExists(t.coll, t.name).catch(() => ({ Exists: null }));
      if (exists.Exists) { console.log(`✓ 已存在跳过 ${t.coll}.${t.name}`); continue; }
      const res = await db.updateCollection(t.coll, {
        TableIndexes: [{ IndexName: t.name, MgoKeySchema: t.keys, MgoIsUnique: false, MgoIsSparse: false }],
      });
      console.log(`✓ 建成 ${t.coll}.${t.name}`, res.RequestId ? "" : JSON.stringify(res).slice(0, 80));
    } catch (e) {
      console.error(`✗ ${t.coll}.${t.name}:`, String(e.message || e).slice(0, 150));
    }
  }
  console.log("完成");
}
main().catch(e => { console.error("致命:", e.message); process.exit(1); });
