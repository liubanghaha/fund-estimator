const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { sendAdminAlert } = require("./_shared/admin-alert");

/**
 * 每日任务健康巡检（生产级补课 #2：告警统一入口，2026-11-07）
 *
 * 每日 06:00 检查各定时任务昨夜/前日的产出状态，异常汇总成**一条**告警（不刷屏）：
 *   1. temp_task_status      —— 03:00 温度任务：date==今天 且 done
 *   2. rank_distribution     —— 04:30 排名分布：date==今天
 *   3. backup_status         —— 02:30 备份：date==今天 且 ok
 *   4. fund_estimate_deviations —— 15:30 误差台账：今天 date 的 estRate 行数>0
 *      （06:00 检查的是"昨天"的行数，昨天为交易日时应>0）
 *   5. quarterly_snapshot_status —— 04:00 季报快照（仅工作日检查）
 *   6. confirmTransactions 残留 —— date < 今天-2 且 confirmed:false 的交易数>0 = 校准失败
 *   7. profit_snapshots      —— 昨天为交易日时应有当日快照
 *
 * 自身结果写 app_config/daily_health_status（供观测）；异常 → admin-alert 一条订阅消息。
 * 非交易日快照/台账类天然无产出 → 对应检查自动跳过。
 */

const bjToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

async function isTradingDay(dateStr) {
  try {
    const td = require("./_shared/trading-day");
    return td.isTradingDay(dateStr);
  } catch (e) { return true; } // 节假日表不可用时按交易日从严检查
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  const today = bjToday();
  const yesterday = addDays(today, -1);
  const problems = [];
  const checks = {};

  const docOf = async (id) => {
    const r = await db.collection("app_config").doc(id).get().catch(() => null);
    return (r && r.data) || null;
  };

  // 1) 温度任务（今天 03:00）
  try {
    const t = await docOf("temp_task_status");
    // temp_task_status 的日期字段叫 today（computeFundTemperature 写入口径）。
    // 温度任务有非交易日守卫（周六/节假日 03:00 不跑）→ 非交易日预期"最近交易日"的状态
    const td = require("./_shared/trading-day");
    const expectTempDay = (await isTradingDay(today)) ? today : td.lastTradingDay(today);
    checks.temp = t && t.today === expectTempDay && t.status === "done";
    if (!checks.temp) problems.push(`温度任务未完成(${t ? (t.today || t.date) + "/" + t.status : "无状态"}，预期 ${expectTempDay})`);
    // 分布健康度（2026-11-09 加）：全市场一个档位占满 = 历史分位全缺失的兜底症状
    //（11-06/11-09 各发生一次，用户看到"估值全是 1/温度全适中"才发现——巡检要能当天发现）
    const sd = t && t.signalDist;
    if (checks.temp && sd && (sd.low + sd.mid + sd.high) > 100) {
      const total = sd.low + sd.mid + sd.high;
      const maxShare = Math.max(sd.low, sd.mid, sd.high) / total;
      checks.tempDist = +maxShare.toFixed(2);
      if (maxShare > 0.95) {
        // 自愈（2026-11-09）：6:00 接口通常已正常——直接触发一次强制重跑，
        // 不用等用户发现"估值全是 1"（03:00 失败时历史 PE 拉不到会导致全兜底）
        problems.push(`温度分布异常(单档占 ${Math.round(maxShare * 100)}%，已触发自动重跑)`);
        checks.tempAutoFix = true;
        cloud.callFunction({ name: "computeFundTemperature", data: { force: true } })
          .then((r) => console.log("[dailyHealthCheck] 温度自愈触发完成:", JSON.stringify(r.result && r.result.data).slice(0, 120)))
          .catch((e) => console.error("[dailyHealthCheck] 温度自愈触发失败:", e.message));
      }
    }
  } catch (e) { problems.push("温度状态读取失败"); }

  // 2) 排名分布（今天 04:30）
  try {
    const r = await docOf("rank_distribution");
    checks.rank = r && r.date === today;
    if (!checks.rank) problems.push(`排名分布未更新(${r ? r.date : "无"})`);
  } catch (e) { problems.push("排名状态读取失败"); }

  // 3) 备份（今天 02:30）
  try {
    const b = await docOf("backup_status");
    checks.backup = b && b.date === today && b.ok === true;
    if (!checks.backup) problems.push(`数据备份异常(${b ? b.date + "/ok=" + b.ok : "无"})`);
  } catch (e) { problems.push("备份状态读取失败"); }

  // 4) 误差台账（昨天为交易日时应有昨日估算档）
  try {
    const yIsTrading = await isTradingDay(yesterday);
    if (yIsTrading) {
      const c = await db.collection("fund_estimate_deviations")
        .where({ date: yesterday }).limit(1).count();
      checks.deviation = (c.total || 0) > 0;
      if (!checks.deviation) problems.push(`误差台账昨日(${yesterday})无数据`);
    } else { checks.deviation = "skip"; }
  } catch (e) { problems.push("误差台账读取失败"); }

  // 5) 季报快照（工作日 04:00）
  try {
    const tIsTrading = await isTradingDay(today);
    if (tIsTrading) {
      const q = await docOf("quarterly_snapshot_status");
      checks.quarterly = q && (q.date === today || q.lastDate === today || q.finishedAt >= Date.now() - 26 * 3600000);
      if (!checks.quarterly) problems.push(`季报快照未更新(${q ? JSON.stringify(q).slice(0, 60) : "无"})`);
    } else { checks.quarterly = "skip"; }
  } catch (e) { problems.push("季报快照读取失败"); }

  // 6) 交易校准残留（>2 天未确认 = 校准任务连续失败）
  try {
    const stale = await db.collection("transactions")
      .where({ confirmed: false, date: db.command.lt(addDays(today, -2)) })
      .count();
    checks.confirmResidue = (stale.total || 0);
    if (checks.confirmResidue > 0) problems.push(`交易校准残留 ${checks.confirmResidue} 笔`);
  } catch (e) { problems.push("校准残留读取失败"); }

  // 7) 盘中快照（昨天为交易日时应有）
  try {
    const yIsTrading = await isTradingDay(yesterday);
    if (yIsTrading) {
      const c = await db.collection("profit_snapshots").where({ date: yesterday }).count();
      checks.snapshots = (c.total || 0) > 0;
      if (!checks.snapshots) problems.push(`昨日(${yesterday})无盘中快照`);
    } else { checks.snapshots = "skip"; }
  } catch (e) { problems.push("快照读取失败"); }

  // ===== 无界集合清理（2026-11-08 P0）：events/push_logs/analytics_launches 保留 90 天 =====
  // 三集合只增不减（trackReport 每会话 3-10 条），opsTool 看板的 ts count 随体量线性恶化。
  // 每日清一批（预算 50s，删不完明天继续）；events.ts 无索引时分批删除仍慢——清理同时是索引止血前的兜底
  try {
    const cutoffTs = Date.now() - 90 * 86400000;
    const t0 = Date.now();
    let cleaned = 0;
    const TS_FIELD = { events: "ts", push_logs: "sentAt", analytics_launches: "ts" }; // 字段名按集合区分（push_logs 用 sentAt）
    for (const coll of ["events", "push_logs", "analytics_launches"]) {
      for (let round = 0; round < 30; round++) {
        if (Date.now() - t0 > 50000) break; // 50s 预算，剩余明天继续
        const q = await db.collection(coll).where({ [TS_FIELD[coll]]: db.command.lt(cutoffTs) }).limit(500).get();
        if ((q.data || []).length === 0) break;
        const ids = q.data.map((d) => d._id);
        const r = await db.collection(coll).where({ _id: db.command.in(ids) }).remove();
        cleaned += (r.deleted || ids.length);
        if ((q.data || []).length < 500) break;
      }
    }
    checks.retention = cleaned;
    if (cleaned > 0) console.log(`[dailyHealthCheck] 过期数据清理 ${cleaned} 条（90 天前）`);
  } catch (e) { checks.retention = "fail:" + String(e.message || e).slice(0, 50); }

  const ok = problems.length === 0;
  const health = { date: today, ok, problems, checks, finishedAt: Date.now() };
  await db.collection("app_config").doc("daily_health_status").set({ data: health }).catch(() => {});

  if (!ok) {
    const out = await sendAdminAlert(db, {
      title: `健康巡检：${problems.length} 项异常`,
      detail: problems.join("；").slice(0, 20),
      date: today,
    });
    console.error(`[dailyHealthCheck] ${problems.length} 项异常:`, problems.join("；"), "告警:", JSON.stringify(out));
  } else {
    console.log(`[dailyHealthCheck] ${today} 全部正常`);
  }
  return { code: 0, today, ok, problems, checks };
};
