const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async () => {
  const out = {};
  // 验证 _.in 对字符串 kind 的语义（recallReport 依赖）
  const r1 = await db.collection("push_logs").where({ kind: "recall_7d" }).limit(2).get();
  out.eq_7d = (r1.data || []).map(l => ({ kind: l.kind, status: l.status, date: l.date }));
  const r2 = await db.collection("push_logs").where({ kind: _.in(["recall_7d", "recall_14d", "recall_30d"]) }).limit(3).get();
  out.in_recall = (r2.data || []).map(l => l.kind);
  // push_logs 里 kind 分布抽样
  // 构造一条 recall_7d 测试记录，验证 _.in 能否命中单值字符串
  const testId = "zztest_" + Date.now();
  await db.collection("push_logs").add({ data: { _openid: "zz_test", scene: "closing_brief", date: "2026-09-06", status: "sent", errMsg: "", sentAt: Date.now(), openedAt: null, fundCode: "", kind: "recall_7d", _id: testId } });
  const r3 = await db.collection("push_logs").where({}).limit(20).get();
  const kinds = {};
  (r3.data || []).forEach(l => { kinds[l.kind] = (kinds[l.kind] || 0) + 1; });
  out.kindDist = kinds;
  // 用真实写入验证 _.in
  const r4 = await db.collection("push_logs").where({ kind: _.in(["recall_7d", "recall_14d", "recall_30d"]) }).limit(5).get();
  out.in_hits = (r4.data || []).map(l => l.kind);
  const r5 = await db.collection("push_logs").where({ kind: "recall_7d" }).limit(5).get();
  out.eq_hits = (r5.data || []).map(l => l.kind);
  // 清理测试记录
  await db.collection("push_logs").where({ kind: "recall_7d", _openid: "zz_test" }).remove();
  return out;
};
