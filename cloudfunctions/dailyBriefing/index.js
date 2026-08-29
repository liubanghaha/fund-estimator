const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const td = require("./_shared/trading-day");

// ===== 配置 =====
// 订阅消息模板 ID：mp 后台「功能 → 订阅消息」复制，模板字段 key 定稿后同步调整 buildBrief
const TEMPLATE_ID = "";
const SCENE = "closing_brief";          // 场景标识：收盘小结（subscriptions 按多场景设计，后续净值播报/定投提醒共用本集合）
const PAGE_BASE = "pages/index/index";  // 推送落地页；lid 参数由前端上报打开
const MINI_STATE = "formal";            // formal | trial | developer，开发验证期改 trial
const BATCH_SIZE = 50;                  // 分批发送，规避 subscribeMessage 接口频控
const DRY_RUN_LIMIT = 5;                // dryRun 只跑前 5 人，够验证文案即可
const SIGNAL_CN = { low: "偏低", mid: "适中", high: "偏高" };
const SIGNAL_ORDER = { low: 0, mid: 1, high: 2 };

exports.main = async (event = {}) => {
  try {
    if (event.action === "auth") return await handleAuth(event);
    if (event.action === "trackOpen") return await handleTrackOpen(event.logId);
    return await runBriefing(!!event.dryRun);
  } catch (e) {
    console.error("[dailyBriefing] 失败:", e.message);
    return { code: -1, msg: e.message };
  }
};

// ---- action: auth ----
// 前端 requestSubscribeMessage accept 后调用。一次授权 = 一次发送额度（quota +1）。
async function handleAuth({ scene = SCENE, templateId = TEMPLATE_ID }) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: "无用户身份" };
  const found = await db.collection("subscriptions").where({ _openid: OPENID, scene }).get();
  const now = Date.now();
  if (found.data.length > 0) {
    await db.collection("subscriptions").doc(found.data[0]._id).update({
      data: { quota: _.inc(1), templateId, updatedAt: now }
    });
  } else {
    await db.collection("subscriptions").add({
      data: { _openid: OPENID, scene, templateId, quota: 1, createdAt: now, updatedAt: now }
    });
  }
  return { code: 0 };
}

// ---- action: trackOpen ----
// 用户点推送落地（首页 onLoad 检测 src=push&lid=xxx）后上报，补 openedAt 供打开率统计。
async function handleTrackOpen(logId) {
  const { OPENID } = cloud.getWXContext();
  if (!logId || !OPENID) return { code: -1, msg: "缺参数" };
  // where 带 _openid 校验，防止伪造 logId 改他人记录
  const r = await db.collection("push_logs").where({ _id: logId, _openid: OPENID }).update({
    data: { openedAt: Date.now() }
  });
  return { code: 0, updated: r.stats.updated };
}

// ---- 定时主流程：收盘小结 ----
async function runBriefing(dryRun) {
  const today = td.bjDateStr();
  if (!dryRun && !td.isTradingDay(today)) {
    return { code: 0, msg: `非交易日 ${today} 跳过` };
  }
  if (!dryRun && !TEMPLATE_ID) {
    return { code: -1, msg: "TEMPLATE_ID 未配置，请在 index.js 顶部填入" };
  }

  // 1. 有效订阅读者（quota>0）
  const subs = await readAll("subscriptions", { scene: SCENE, quota: _.gt(0) }, ["_openid", "quota"]);
  if (subs.length === 0) return { code: 0, msg: "无有效订阅" };

  // 2. 全量持仓按 openid 分组（同 snapshotProfit 模式：一次读全量，内存分组）
  const holdings = await readAll("holdings", {}, ["_openid", "fundCode", "marketValue"]);
  const byUser = {};
  const totalMarket = {};
  holdings.forEach(h => {
    if (!h._openid || !h.fundCode) return;
    (byUser[h._openid] = byUser[h._openid] || []).push(h);
    totalMarket[h._openid] = (totalMarket[h._openid] || 0) + (h.marketValue || 0);
  });
  const targets = subs.filter(s => byUser[s._openid]);

  // 3. 温度变化：今日 vs 上一交易日的全市场 signal
  const prevDay = td.lastTradingDay(td.bjDateStr(-1));
  const [todaySigs, prevSigs] = await Promise.all([loadSignals(today), loadSignals(prevDay)]);

  // 4. 今日收益快照：每人 points 最后一条 rate（15:00 后必然存在）
  const rateMap = {};
  const snaps = await readAll("profit_snapshots", { date: today }, ["_openid", "points"]);
  snaps.forEach(s => {
    if (s.points && s.points.length > 0) rateMap[s._openid] = s.points[s.points.length - 1].rate;
  });

  // 5. 分批发送
  const runList = dryRun ? targets.slice(0, DRY_RUN_LIMIT) : targets;
  let sent = 0, failed = 0, skipped = 0;
  for (let i = 0; i < runList.length; i += BATCH_SIZE) {
    const batch = runList.slice(i, i + BATCH_SIZE);
    for (const sub of batch) {
      const brief = buildBrief(sub._openid, byUser[sub._openid], totalMarket[sub._openid], rateMap[sub._openid], todaySigs, prevSigs);
      if (!brief) { skipped++; continue; } // 无快照且温度无变化，不发不扣额度
      if (dryRun) {
        await db.collection("push_logs").add({
          data: { _openid: sub._openid, scene: SCENE, date: today, status: "dry_run", content: brief, sentAt: Date.now(), openedAt: null }
        });
        sent++;
        continue;
      }
      const logId = await createLog(sub._openid, today);
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: sub._openid,
          templateId: TEMPLATE_ID,
          page: `${PAGE_BASE}?src=push&lid=${logId}`,
          miniprogramState: MINI_STATE,
          data: brief
        });
        await finishLog(logId, "sent", "");
        await db.collection("subscriptions").doc(sub._id).update({
          data: { quota: _.inc(-1), updatedAt: Date.now() }
        });
        sent++;
      } catch (e) {
        const errCode = e.errCode || (String(e.errMsg || "").match(/43101/) ? 43101 : null);
        // 43101 = 用户已取消订阅：微信侧额度无法查询，用错误码把本地 quota 归零校准漂移
        if (errCode === 43101) {
          await db.collection("subscriptions").doc(sub._id).update({
            data: { quota: 0, updatedAt: Date.now() }
          });
        }
        await finishLog(logId, "failed", e.errMsg || e.message);
        failed++;
      }
    }
  }
  console.log(`[dailyBriefing] subs=${subs.length} targets=${targets.length} sent=${sent} failed=${failed} skipped=${skipped} dryRun=${dryRun}`);
  return { code: 0, msg: `发送 ${sent}，失败 ${failed}，跳过 ${skipped}${dryRun ? "（dryRun）" : ""}` };
}

// ---- 文案装配 ----
// thing 字段限 20 字符。key（thing1/thing2）为占位，模板字段定稿后对齐。
// 措辞红线：数据陈述（估算 X 元 / 温度转为偏高），不出现"收益/建议/止盈"字样。
function buildBrief(openid, funds, marketValue, rate, todaySigs, prevSigs) {
  let ups = 0, downs = 0;
  funds.forEach(f => {
    const t = todaySigs.get(f.fundCode), p = prevSigs.get(f.fundCode);
    if (!t || !p || t === "nodata" || p === "nodata" || t === p) return;
    if (SIGNAL_ORDER[t] > SIGNAL_ORDER[p]) ups++; else downs++;
  });
  if (rate == null && ups + downs === 0) return null;

  let line1;
  if (rate != null) {
    if (marketValue > 0) {
      const amount = marketValue * rate / 100;
      line1 = `今日估算${amount >= 0 ? "+" : ""}${amount.toFixed(0)}元（${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%）`;
    } else {
      line1 = `今日估算${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`;
    }
  } else {
    line1 = "今日行情详见小程序";
  }
  let line2 = "持仓温度无变化";
  if (ups + downs > 0) {
    line2 = [
      ups > 0 ? `${ups}只转为偏高` : "",
      downs > 0 ? `${downs}只转为偏低` : ""
    ].filter(Boolean).join("，");
  }
  return {
    thing1: { value: line1.slice(0, 20) },
    thing2: { value: ("温度：" + line2).slice(0, 20) },
  };
}

function loadSignals(date) {
  return readAll("fund_temperatures", { date }, ["fundCode", "signal"]).then(rows => {
    const map = new Map();
    rows.forEach(r => map.set(r.fundCode, r.signal));
    return map;
  });
}

async function createLog(openid, date) {
  const r = await db.collection("push_logs").add({
    data: { _openid: openid, scene: SCENE, date, status: "sending", errMsg: "", sentAt: Date.now(), openedAt: null }
  });
  return r._id;
}

async function finishLog(logId, status, errMsg) {
  await db.collection("push_logs").doc(logId).update({
    data: { status, errMsg: errMsg || "" }
  }).catch(e => console.warn("[dailyBriefing] log 更新失败:", e.message));
}

// 游标分页读全量（云数据库单次 get 上限 100 条）
async function readAll(col, where, field) {
  const out = [];
  const projection = field ? field.reduce((o, f) => (o[f] = true, o), {}) : null;
  for (let skip = 0; skip < 20000; skip += 100) {
    let q = db.collection(col);
    if (where && Object.keys(where).length > 0) q = q.where(where);
    if (projection) q = q.field(projection);
    const res = await q.skip(skip).limit(100).get();
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}
