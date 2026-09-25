const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const td = require("./_shared/trading-day");
const fd = require("./_shared/fund-data");

// 云调用（cloud.openapi）在本环境返回 -501001（INVALID_WX_ACCESS_TOKEN，云调用权限链路历史遗留），
// 发送改走 HTTP API：stable_token 免 IP 白名单校验，SECRET 放云函数环境变量 WX_APP_SECRET（不入库）。
const WX_APPID = "wxb95098fe432ed765";

// ===== 配置 =====
// 模板「温度数据通知」（信息查询类目，模板编号 38431）：
// thing1=测量账号 thing2=被测量用户 thing3=测量数据 time4=测量时间
const TEMPLATE_ID = "A7Sc6sngopPiROImJeqfi5K6ciJKTRrNzE1gug2tzuk";
const SCENE = "closing_brief";          // 场景标识：收盘小结（subscriptions 按多场景设计，后续净值播报/定投提醒共用本集合）
const PAGE_PORTFOLIO = "subpackages/analysis/pages/profit-detail/index"; // 收益类推送落地：收益走势页
const PAGE_FUND = "subpackages/analysis/pages/fund-detail/index";        // 单基金提醒落地：基金详情页
const MINI_STATE = "formal";            // formal | trial | developer，开发验证期改 trial
const BATCH_SIZE = 50;                  // 分批发送，规避 subscribeMessage 接口频控
const DRY_RUN_LIMIT = 5;                // dryRun 只跑前 5 人，够验证文案即可
const SIGNAL_CN = { low: "偏低", mid: "适中", high: "偏高" };
const SIGNAL_ORDER = { low: 0, mid: 1, high: 2 };

exports.main = async (event = {}) => {
  try {
    // 定时触发器分流：三个 timer 共用本函数
    if (event.Type === "Timer") {
      // ⚠️ 线上触发器以 cloudbaserc.json 为部署源（函数目录 config.json 不生效）：
      //    confirmBriefTimer = 20:00-23:40 每 20 分钟 → 收盘小结（自带"净值确认门"：
      //    等官方净值全部公布后才发，23:00 档兜底按估算，见 runBriefing 第 4.5 步）；
      //    peAlertTimer = 15:35 → 温度变化提醒（独立一轮，不再等净值确认，见 runPeAlerts）；
      //    weeklyBriefTimer = 周六 10:00 周报。
      // 15:30 收盘小结 / 21:30 净值播报两个触发器在 51fbf65 被有意删除（收盘播报改"净值确认后发"），
      // 别再加回来；navBriefTimer 分支保留给手动 action=navBrief，线上没有这个触发器
      if (event.TriggerName === "navBriefTimer") return await runNavBrief(false, false);
      if (event.TriggerName === "peAlertTimer") return await runPeAlerts(false, false);
      if (event.TriggerName === "weeklyBriefTimer") return await runWeeklyBrief(false);
      return await runBriefing(false, false);
    }
    if (event.action === "auth") return await handleAuth(event);
    if (event.action === "trackOpen") return await handleTrackOpen(event.logId);
    if (event.action === "recallPush") return await handleRecallPush(event);
    if (event.action === "recallOptOut") return await handleRecallOptOut();
    if (event.action === "logInfo") return await handleLogInfo(event.logId);
    if (event.action === "alertGet") return await handleAlertGet();
    if (event.action === "alertSet") return await handleAlertSet(event);
    if (event.action === "alertSrc") return await handleAlertSrc(event);
    if (event.action === "alertPush") return await handleAlertPush(event);
    if (event.action === "navBrief") return await runNavBrief(!!event.force, !!event.dryRun);
    if (event.action === "peAlerts") return await runPeAlerts(!!event.force, !!event.dryRun);
    if (event.action === "weeklyBrief") return await runWeeklyBrief(!!event.force, !!event.dryRun);
    return await runBriefing(!!event.dryRun, !!event.force);
  } catch (e) {
    console.error("[dailyBriefing] 失败:", e.message);
    return { code: -1, msg: e.message };
  }
};

// ---- action: alertGet / alertSet ----
// 提醒设置上云（换设备同步）。settings 结构同客户端 storage.alertSettings：
// { [fundCode]: { upper, lower, peAlert } }，peCache 为云端 PE 提醒基线（服务端维护）
async function handleAlertGet() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: "无用户身份" };
  const r = await db.collection("alert_settings").where({ _openid: OPENID }).get();
  const doc = r.data[0];
  // 推送额度一并返回：提醒能否送达只取决于额度，客户端要把状态显式告诉用户
  const sub = await db.collection("subscriptions").where({ _openid: OPENID, scene: SCENE }).get().catch(() => ({ data: [] }));
  const quota = (sub.data || []).reduce((a, x) => a + Math.max(0, x.quota || 0), 0);
  // data=settings 保持向后兼容，globalOn 顶层返回（全局涨跌提醒开关）
  return { code: 0, data: (doc && doc.settings) || {}, globalOn: !!(doc && doc.globalOn), quota, peCache: (doc && doc.peCache) || {} };
}

async function handleAlertSet({ settings, globalOn }) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: "无用户身份" };
  const hasSettings = settings && typeof settings === "object";
  if (!hasSettings && typeof globalOn !== "boolean") {
    return { code: -1, msg: `参数错误 settings=${typeof settings} globalOn=${typeof globalOn} keys=${Object.keys(arguments[0] || {}).join("|")}` };
  }
  const found = await db.collection("alert_settings").where({ _openid: OPENID }).get();
  const now = Date.now();
  if (found.data.length > 0) {
    const patch = { updatedAt: now };
    if (hasSettings) patch.settings = settings;
    if (typeof globalOn === "boolean") patch.globalOn = globalOn;
    await db.collection("alert_settings").doc(found.data[0]._id).update({ data: patch });
  } else {
    await db.collection("alert_settings").add({
      data: { _openid: OPENID, settings: hasSettings ? settings : {}, globalOn: !!globalOn, peCache: {}, createdAt: now, updatedAt: now }
    });
  }
  return { code: 0 };
}

// 有"启用中"提醒规则的用户集合（播报给提醒留额度的判断依据；量级千级，整表读）
async function alertUserOpenids() {
  try {
    const docs = await readAll("alert_settings", {}, ["_openid", "settings", "globalOn"]);
    const set = new Set();
    docs.forEach((d) => {
      if (d.globalOn) { set.add(d._openid); return; }
      const st = d.settings || {};
      if (Object.keys(st).some((k) => st[k] && st[k].enabled !== false)) set.add(d._openid);
    });
    return set;
  } catch (e) {
    return new Set();
  }
}

// ---- action: alertSrc ----
// 数据源偏好同步到云端（snapshotProfit 涨跌提醒按用户所选源触发）
async function handleAlertSrc({ src }) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: "无用户身份" };
  if (src !== "sina" && src !== "self" && src !== "em") return { code: -1, msg: "src 非法" };
  // 老版本客户端仍可能上报 em（原东财官方源，已停供）→ 归一为当前的数据源一
  const norm = src === "self" ? "self" : "sina";
  const found = await db.collection("alert_settings").where({ _openid: OPENID }).get();
  const now = Date.now();
  if (found.data.length > 0) {
    await db.collection("alert_settings").doc(found.data[0]._id).update({ data: { src: norm, updatedAt: now } });
  } else {
    await db.collection("alert_settings").add({
      data: { _openid: OPENID, settings: {}, globalOn: false, src: norm, createdAt: now, updatedAt: now }
    });
  }
  return { code: 0 };
}

// ---- action: alertPush ----
// snapshotProfit 盘中检测命中后批量委托发送（发送逻辑单点在本函数：额度/日志/43101 归零）
// pushes: [{ openid, scene, fundCode, kind, fundName, text }]
async function handleAlertPush({ pushes }) {
  // 安全：仅允许服务端调用（snapshotProfit 检测后委托）。客户端调用带 OPENID，直接拒绝，
  // 防止伪造 openid 给任意用户发送推送/消耗其额度
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  if (!Array.isArray(pushes) || pushes.length === 0) return { code: 0, msg: "空" };
  if (!TEMPLATE_ID) return { code: -1, msg: "TEMPLATE_ID 未配置" };
  const token = await getAccessToken();
  const today = td.bjDateStr();
  let sent = 0, failed = 0, noQuota = 0;
  // 发送前先查额度（原来不查：没额度也照发，微信 43101 拒绝 → 每小时重试、日志刷屏，
  // 用户侧看不到任何东西）。额度够才发，不够就等下一次检查——授权到位后自然补发
  const subRows = await readAll("subscriptions", { scene: SCENE }, ["_openid", "quota"]);
  const quotaLeft = {};
  subRows.forEach((x) => { quotaLeft[x._openid] = (quotaLeft[x._openid] || 0) + Math.max(0, x.quota || 0); });
  // 全量分页处理：命中数超过单轮上限时不截断（截断会静默漏发且无日志）
  for (let start = 0; start < pushes.length; start += 200) {
  for (const p of pushes.slice(start, start + 200)) {
    if (!(quotaLeft[p.openid] > 0)) { noQuota++; continue; }
    const brief = {
      thing1: { value: "韭菜估值宝" },
      thing2: { value: String(p.fundName || "持仓基金").slice(0, 20) },
      thing3: { value: String(p.text || "").slice(0, 20) },
      time4: { value: _bjTimeStr() },
    };
    const logId = await createLog(p.openid, today, p.scene || "rate_alert", p.fundCode, p.kind);
    try {
      const errcode = await sendSubscribe(token, p.openid, `${PAGE_FUND}?fundCode=${p.fundCode || ""}&src=push&lid=${logId}`, brief);
      if (errcode !== 0) throw Object.assign(new Error("subscribe/send errcode=" + errcode), { errCode: errcode });
      await finishLog(logId, "sent", "");
      await db.collection("subscriptions").where({ _openid: p.openid, scene: SCENE, quota: _.gt(0) }).update({
        data: { quota: _.inc(-1), updatedAt: Date.now() }
      });
      quotaLeft[p.openid] = Math.max(0, (quotaLeft[p.openid] || 0) - 1);
      sent++;
    } catch (e) {
      const errCode = e.errCode || (String(e.message).match(/43101/) ? 43101 : null);
      if (errCode === 43101) {
        await db.collection("subscriptions").where({ _openid: p.openid, scene: SCENE }).update({
          data: { quota: 0, updatedAt: Date.now() }
        });
      }
      await finishLog(logId, "failed", `${e.errCode || "ERR"} ${e.errMsg || e.message}`);
      failed++;
    }
  }
  }
  return { code: 0, sent, failed, noQuota };
}

// 基于日期串的纯日期偏移（UTC 计算，北京日期串无时区歧义）
function addDays(dateStr, n) {
  const t = new Date(dateStr + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

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

// ---- action: recallPush ----
// P0-1 老用户召回发送：opsTool.recallSend（管理员校验）服务端委托，同 alertPush 安全模型。
// targets: [{ openid, bucket }]，bucket ∈ 7d|14d|30d（决定 push_logs kind=recall_{bucket} 供频控与报表）
// variant: 'a'=通用文案（默认）| 'b'=个性化文案（最早买入基金+最新温度，构造失败自动回退 a）
// 文案走模板「温度数据通知」，纯数据陈述（合规红线 #2/#6：不含投资/收益/建议字样）
async function handleRecallPush({ targets, variant }) {
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  if (!Array.isArray(targets) || targets.length === 0) return { code: 0, sent: 0, failed: 0 };
  const token = await getAccessToken();
  const today = td.bjDateStr();
  // 召回与用户主动订阅的播报/提醒共用模板额度池：只对本地 quota>=2 的用户发，
  // 避免运营召回挤掉用户主动订阅的收盘播报/涨跌提醒（微信额度不足时 43101 静默漏发）
  const subRows = await readAll("subscriptions", {}, ["_openid", "scene", "quota"]);
  const quotaMap = {};
  subRows.forEach(s => { quotaMap[s._openid] = (quotaMap[s._openid] || 0) + Math.max(0, s.quota || 0); });
  const eligible = targets.filter(t => !t.recallOptOut && (quotaMap[t.openid] || 0) >= 2);
  let skipped = targets.length - eligible.length;
  let sent = 0, failed = 0;
  const useB = variant === "b";
  const tempCache = new Map(); // fundCode → normPE|null：B 文案同基金温度只查一次
  for (const t of eligible.slice(0, 200)) {
    // B 变体逐人构造个性化 thing3（≤20 字符由构造函数保证）；查不到买入/温度或异常统一回退 A 文案
    const thing3 = (useB && await buildRecallTextB(t.openid, tempCache)) || RECALL_TEXT_A;
    const brief = {
      thing1: { value: "韭菜估值宝" },
      thing2: { value: "你的持仓组合" },
      thing3: { value: thing3 },
      time4: { value: _bjTimeStr() },
    };
    const kind = "recall_" + (["7d", "14d", "30d"].indexOf(t.bucket) !== -1 ? t.bucket : "7d");
    const logId = await createLog(t.openid, today, SCENE, "", kind);
    try {
      const errcode = await sendSubscribe(token, t.openid, `${PAGE_PORTFOLIO}?src=push&lid=${logId}`, brief);
      if (errcode !== 0) throw Object.assign(new Error("subscribe/send errcode=" + errcode), { errCode: errcode });
      await finishLog(logId, "sent", "");
      await db.collection("subscriptions").where({ _openid: t.openid, scene: SCENE, quota: _.gt(0) }).update({
        data: { quota: _.inc(-1), updatedAt: Date.now() }
      });
      sent++;
    } catch (e) {
      const errCode = e.errCode || (String(e.message).match(/43101/) ? 43101 : null);
      if (errCode === 43101) {
        await db.collection("subscriptions").where({ _openid: t.openid, scene: SCENE }).update({
          data: { quota: 0, updatedAt: Date.now() }
        });
      }
      await finishLog(logId, "failed", `${e.errCode || "ERR"} ${e.errMsg || e.message}`);
      failed++;
    }
  }
  return { code: 0, sent, failed, skipped };
}

// 召回 A 文案（通用，默认）：纯数据陈述（合规红线 #2/#6）
const RECALL_TEXT_A = "持仓温度有更新，来看看最新数据";

// 召回 B 文案（个性化）构造：取该用户最早一笔买入（transactions type=buy 按 date 升序，date 为
// YYYY-MM-DD 串，多取 5 条兜底缺 date 的脏数据），查该基金最新温度（fund_temperatures 按 date
// 降序第一条，normPE 归一化估值温度），拼「你M月买入的XX温度0.62」。
// 微信 thing 上限 20 字符：全拼超长先截 fundName 保留前 4 字+"…"再拼，仍超限返回 ""。
// 查不到买入/月份非法/无温度/任何异常都返回 ""（调用方回退 A 文案）。内部全兜底不 reject。
async function buildRecallTextB(openid, tempCache) {
  try {
    const bought = await db.collection("transactions")
      .where({ _openid: openid, type: "buy" })
      .orderBy("date", "asc").limit(5).get();
    const tx = (bought.data || []).find(x => x && x.fundCode && x.date);
    if (!tx) return "";
    const month = parseInt(String(tx.date).slice(5, 7), 10);
    if (!(month >= 1 && month <= 12)) return "";
    // 温度按 fundCode 查最新一条（写侧 _id=fundCode_date 幂等 upsert，date 降序即最新）
    let normPE;
    if (tempCache && tempCache.has(tx.fundCode)) {
      normPE = tempCache.get(tx.fundCode);
    } else {
      const temps = await db.collection("fund_temperatures")
        .where({ fundCode: tx.fundCode }).orderBy("date", "desc").limit(1).get();
      const row = temps.data && temps.data[0];
      normPE = row && isFinite(parseFloat(row.normPE)) ? parseFloat(row.normPE) : null;
      if (tempCache) tempCache.set(tx.fundCode, normPE); // 含 null 负缓存，同基金不再重查
    }
    if (normPE == null) return "";
    const prefix = `你${month}月买入的`;       // 6-7 字
    const suffix = `温度${normPE.toFixed(2)}`; // 通常 6-7 字
    const name = String(tx.fundName || tx.fundCode || "").trim();
    if (!name) return "";
    const full = prefix + name + suffix;
    if (full.length <= 20) return full;
    const short = prefix + name.slice(0, 4) + "…" + suffix; // 截名后上限 7+5+7=19 字
    return short.length <= 20 ? short : ""; // 仍超限（极端数值）→ 回退 A
  } catch (e) {
    console.warn("[dailyBriefing] 召回 B 文案构造失败，回退通用文案:", e.message);
    return "";
  }
}

// ---- action: recallOptOut ----
// 一键退订召回（召回落地页横幅入口）：只停召回，收盘小结/净值播报双条照常
async function handleRecallOptOut() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, msg: "无用户身份" };
  const r = await db.collection("subscriptions").where({ _openid: OPENID, scene: SCENE }).update({
    data: { recallOptOut: true, updatedAt: Date.now() }
  });
  return { code: 0, updated: r.stats.updated };
}

// ---- action: logInfo ----
// 落地页按 lid 查推送类型（召回落地显示退订横幅的判定依据），带 _openid 校验只暴露自己的日志
async function handleLogInfo(logId) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID || !logId) return { code: -1, msg: "缺参数" };
  const r = await db.collection("push_logs").where({ _id: String(logId).slice(0, 40), _openid: OPENID }).get();
  const log = r.data[0];
  if (!log) return { code: 0, data: null };
  return { code: 0, data: { kind: log.kind || "", scene: log.scene || "" } };
}

// ---- 定时主流程：收盘小结 ----
async function runBriefing(dryRun, force) {
  const today = td.bjDateStr();
  if (!dryRun && !force && !td.isTradingDay(today)) {
    return { code: 0, msg: `非交易日 ${today} 跳过` };
  }
  if (!dryRun && !TEMPLATE_ID) {
    return { code: -1, msg: "TEMPLATE_ID 未配置，请在 index.js 顶部填入" };
  }
  // 数据所属交易日：force 补发（周末验证/漏发补发）时自动回退到最近交易日
  const dataDay = td.isTradingDay(today) ? today : td.lastTradingDay();
  const prevDay = td.lastTradingDay(addDays(dataDay, -1));

  // 1. 订阅读者（quota>0；dryRun 不发送不扣额度，不过滤额度便于文案验证）
  const subs = await readAll("subscriptions", dryRun ? { scene: SCENE } : { scene: SCENE, quota: _.gt(0) }, ["_openid", "quota"]);
  if (subs.length === 0) return { code: 0, msg: "无有效订阅" };
  // 1b. 配了提醒规则的用户：播报给提醒留 1 条额度（一次性订阅共用额度池，
  //     播报吃干后盘中提醒全部 43101——2026-09-09 实测就是这么丢的）
  const alertUserSet = await alertUserOpenids();

  // 2. 全量持仓按 openid 分组（同 snapshotProfit 模式：一次读全量，内存分组）
  const holdings = await readAll("holdings", {}, ["_openid", "fundCode", "fundName", "marketValue", "shares"]);
  const byUser = {};
  const totalMarket = {};
  holdings.forEach(h => {
    if (!h._openid || !h.fundCode) return;
    (byUser[h._openid] = byUser[h._openid] || []).push(h);
    totalMarket[h._openid] = (totalMarket[h._openid] || 0) + (h.marketValue || 0);
  });
  const targets = subs.filter(s => byUser[s._openid]);

  // 3. 温度变化：数据交易日 vs 上一交易日的全市场 signal
  const [todaySigs, prevSigs] = await Promise.all([loadSignals(dataDay), loadSignals(prevDay)]);

  // 4. 收益快照：每人 points 最后一条 rate（收盘后必然存在，仅作未确认时的估算兜底）
  const rateMap = {};
  const snaps = await readAll("profit_snapshots", { date: dataDay }, ["_openid", "points"]);
  snaps.forEach(s => {
    if (s.points && s.points.length > 0) rateMap[s._openid] = s.points[s.points.length - 1].rate;
  });

  // 4.5 确认门：不固定发送时刻——官方净值（actualDate=当日）全部公布后本档即发；
  // 968 互认基金 T+1 公布不参与确认；23:00 最后一档兜底（已发布按实际、未发布按估算混合，文案标"估"）
  const confirmation = await collectConfirmation(targets, byUser, dataDay);
  if (!dryRun && !force && !confirmation.allConfirmed && !confirmation.isLastSlot) {
    return { code: 0, msg: `等待净值确认 ${confirmation.publishedCount}/${confirmation.totalCount}` };
  }

  // 5. 分批发送（防重发：当天已成功发送过的用户跳过，覆盖 force 补发场景）
  const sentLogs = await readAll("push_logs", { scene: SCENE, date: dataDay, status: "sent" }, ["_openid"]);
  const sentSet = new Set(sentLogs.map(l => l._openid));
  const runList = dryRun ? targets.slice(0, DRY_RUN_LIMIT) : targets;
  // stable_token 官方建议每次业务调用时获取（未过期时接口自动复用同一 token）
  let accessToken = null;
  if (!dryRun) accessToken = await getAccessToken();
  let sent = 0, failed = 0, skipped = 0, heldForAlert = 0;
  for (let i = 0; i < runList.length; i += BATCH_SIZE) {
    const batch = runList.slice(i, i + BATCH_SIZE);
    for (const sub of batch) {
      if (!dryRun && sentSet.has(sub._openid)) { skipped++; continue; }
      // 给提醒留额度：有提醒规则的用户至少留 1 条，quota<2 时本次播报不发（不报错、不写失败日志）
      if (!dryRun && alertUserSet.has(sub._openid) && (sub.quota || 0) < 2) { heldForAlert++; continue; }
      // 官方净值口径：全确认按实际；未确认（23:00 兜底档）按"已发布实际+未发布估算"混合，
      // estimated 标志让文案区分估算部分，避免把兜底值误读为确认值
      const rateInfo = resolveRate(byUser[sub._openid], confirmation, rateMap[sub._openid], totalMarket[sub._openid]);
      const brief = buildBrief(sub._openid, byUser[sub._openid], rateInfo ? rateInfo.base : totalMarket[sub._openid], rateInfo ? rateInfo.rate : rateMap[sub._openid], todaySigs, prevSigs, !rateInfo || !rateInfo.confirmed);
      if (!brief) { skipped++; continue; } // 无快照且温度无变化，不发不扣额度
      if (dryRun) {
        await db.collection("push_logs").add({
          data: { _openid: sub._openid, scene: SCENE, date: dataDay, status: "dry_run", content: brief, sentAt: Date.now(), openedAt: null }
        });
        sent++;
        continue;
      }
      const logId = await createLog(sub._openid, dataDay);
      try {
        const errcode = await sendSubscribe(accessToken, sub._openid, `${PAGE_PORTFOLIO}?src=push&lid=${logId}`, brief);
        if (errcode !== 0) throw Object.assign(new Error("subscribe/send errcode=" + errcode), { errCode: errcode });
        await finishLog(logId, "sent", "");
        await db.collection("subscriptions").doc(sub._id).update({
          data: { quota: _.inc(-1), updatedAt: Date.now() }
        });
        sent++;
      } catch (e) {
        const errCode = e.errCode || (String(e.message).match(/43101/) ? 43101 : null);
        // 43101 = 用户已取消订阅：微信侧额度无法查询，用错误码把本地 quota 归零校准漂移
        if (errCode === 43101) {
          await db.collection("subscriptions").doc(sub._id).update({
            data: { quota: 0, updatedAt: Date.now() }
          });
        }
        await finishLog(logId, "failed", `${e.errCode || "ERR"} ${e.errMsg || e.message}`);
        failed++;
      }
    }
  }
  console.log(`[dailyBriefing] subs=${subs.length} targets=${targets.length} sent=${sent} failed=${failed} skipped=${skipped} dryRun=${dryRun}`);

  // 6. 温度变化提醒已独立成一轮（peAlertTimer 15:35 → runPeAlerts）：
  //    原来挂在这里，会被上面第 4.5 步的"净值确认门"挡住 —— 净值没全公布的那几轮直接 return，
  //    实际要等到净值确认档或 23:00 兜底档才发（用户实测"深夜才到"）。
  //    别把 checkPeAlerts 加回来（会重复检测；虽然 push_logs 会查重，但两处发送点没意义）
  return { code: 0, msg: `发送 ${sent}，失败 ${failed}，跳过 ${skipped}${dryRun ? "（dryRun）" : ""}` };
}

// ---- 独立一轮：温度变化提醒（peAlertTimer 15:35）----
// 为什么独立：PE 温度基于"上一交易日收盘"的估值，凌晨 03:00 的定时任务就算好了，不需要等
// 当天净值公布。原来它挂在 runBriefing 里（净值确认门之后），净值没全公布的那几轮直接 return
// → 实际要等到确认档或 23:00 兜底档才发得出去（用户实测"深夜才到"）。
async function runPeAlerts(force, dryRun) {
  const today = td.bjDateStr();
  if (!dryRun && !force && !td.isTradingDay(today)) {
    return { code: 0, msg: `非交易日 ${today} 跳过` };
  }
  const dataDay = td.isTradingDay(today) ? today : td.lastTradingDay();
  const subs = await readAll("subscriptions", dryRun ? { scene: SCENE } : { scene: SCENE, quota: _.gt(0) }, ["_openid", "quota"]);
  if (subs.length === 0) return { code: 0, msg: "无有效订阅" };
  const holdings = await readAll("holdings", {}, ["_openid", "fundCode", "fundName"]);
  const byUser = {};
  holdings.forEach(h => {
    if (!h._openid || !h.fundCode) return;
    (byUser[h._openid] = byUser[h._openid] || []).push(h);
  });
  // 给当天的收盘小结留 1 条额度（与播报侧「quota<2 不发」同一条规则）：温度提醒先跑，
  // 不能把额度吃干让用户晚上收不到收盘小结。额度不足这轮不发，且**不更新基线**（peCache），
  // 所以信号变化不会丢 —— 额度补上后（或次日）仍按原基线比对并发出
  let heldForBrief = 0;
  const targets = subs.filter(s => byUser[s._openid]).filter(s => {
    if (dryRun || (s.quota || 0) >= 2) return true;
    heldForBrief++;
    return false;
  });
  if (targets.length === 0) return { code: 0, msg: `无目标用户（给收盘小结留额度 ${heldForBrief}）` };
  const todaySigs = await loadSignals(dataDay);
  const accessToken = dryRun ? null : await getAccessToken();
  let sent = 0;
  try {
    sent = await checkPeAlerts(targets, byUser, todaySigs, dataDay, accessToken, dryRun);
  } catch (e) {
    console.warn("[dailyBriefing] PE 提醒检测失败:", e.message);
  }
  console.log(`[dailyBriefing][peAlerts] subs=${subs.length} targets=${targets.length} heldForBrief=${heldForBrief} sent=${sent} dataDay=${dataDay} dryRun=${dryRun}`);
  return { code: 0, msg: `温度提醒：发送 ${sent}，留额度 ${heldForBrief}${dryRun ? "（dryRun）" : ""}` };
}

// ---- 净值播报（交易日 21:30）：官方净值发布后的当日真实收益 ----
// 收益口径：已发布基金按官方涨幅 × 份额基准（前日净值×份额）真实计算，
// 未发布基金按组合估算率兜底并近似；偏差对比 15:30 收盘小结的估算口径。
async function runNavBrief(force, dryRun) {
  const today = td.bjDateStr();
  if (!dryRun && !force && !td.isTradingDay(today)) {
    return { code: 0, msg: `非交易日 ${today} 跳过` };
  }
  const dataDay = td.isTradingDay(today) ? today : td.lastTradingDay();

  const subs = await readAll("subscriptions", dryRun ? { scene: SCENE } : { scene: SCENE, quota: _.gt(0) }, ["_openid", "quota"]);
  if (subs.length === 0) return { code: 0, msg: "无有效订阅" };
  // 有提醒规则的用户：净值播报同样给提醒留 1 条额度（否则 21:30 吃干、次日上午提醒全部发不出）
  const alertUserSet = await alertUserOpenids();

  const holdings = await readAll("holdings", {}, ["_openid", "fundCode", "shares"]);
  const byUser = {};
  holdings.forEach(h => {
    if (!h._openid || !h.fundCode) return;
    (byUser[h._openid] = byUser[h._openid] || []).push(h);
  });
  const targets = subs.filter(s => byUser[s._openid]);
  if (targets.length === 0) return { code: 0, msg: "无目标用户" };

  // 目标用户持仓基金去重，逐基金拉官方净值（actualDate=dataDay 即当日已发布）
  const codeSet = new Set();
  targets.forEach(t => (byUser[t._openid] || []).forEach(h => codeSet.add(h.fundCode)));
  const codes = [...codeSet];
  const navStart = Date.now();
  const navInfo = {};
  const CONCURRENT = 16;
  for (let i = 0; i < codes.length && Date.now() - navStart < 90000; i += CONCURRENT) {
    const batch = codes.slice(i, i + CONCURRENT);
    const results = await Promise.all(batch.map(async (code) => {
      try {
        return { code, r: await fd.fetchLatestNavEastMoney(code) };
      } catch (e) { return { code, r: {} }; }
    }));
    results.forEach(({ code, r }) => {
      if (r && r.actualDate === dataDay && r.actualChangeRate != null) {
        // nav 一并留着：算金额要用「今日净值 − 昨日净值」，不能用「涨幅 × 昨日市值」
        //（官方涨幅只保留 2 位小数，乘上几十万市值后单只可偏 3 元 → 播报与页面对不上）
        navInfo[code] = { published: true, changeRate: r.actualChangeRate, nav: r.actualNav || null };
      }
    });
  }
  console.log(`[dailyBriefing][navBrief] codes=${codes.length} published=${Object.keys(navInfo).length} t=${Date.now() - navStart}ms`);

  // 前日净值基准：fund_navs 的 dataDay 记录即前日净值（snapshotProfit 盘中写入）
  const prevNav = {};
  const prevRows = await readAll("fund_navs", { date: dataDay }, ["fundCode", "yesterdayNav"]);
  prevRows.forEach(r => { if (r.yesterdayNav > 0) prevNav[r.fundCode] = r.yesterdayNav; });

  // 组合估算率（未发布部分兜底 + 偏差对比，与收盘小结同口径）
  const rateMap = {};
  const snaps = await readAll("profit_snapshots", { date: dataDay }, ["_openid", "points"]);
  snaps.forEach(s => {
    if (s.points && s.points.length > 0) rateMap[s._openid] = s.points[s.points.length - 1].rate;
  });

  const sentLogs = await readAll("push_logs", { scene: "nav_brief", date: dataDay, status: "sent" }, ["_openid"]);
  const sentSet = new Set(sentLogs.map(l => l._openid));

  const runList = dryRun ? targets.slice(0, DRY_RUN_LIMIT) : targets;
  let accessToken = null;
  if (!dryRun) accessToken = await getAccessToken();
  let sent = 0, failed = 0, skipped = 0, heldForAlert = 0, pubCount = 0;
  const devSamples = []; // 估算偏差样本（P1-6）：循环内收集，结束后 saveEstimateDeviation 汇总落库
  for (const sub of runList) {
    if (!dryRun && sentSet.has(sub._openid)) { skipped++; continue; }
    // 给提醒留额度：有提醒规则的用户至少留 1 条（quota<2 时本条播报不发）
    if (!dryRun && alertUserSet.has(sub._openid) && (sub.quota || 0) < 2) { heldForAlert++; continue; }
    const list = byUser[sub._openid] || [];
    let totalBase = 0, pubBase = 0, real = 0;
    list.forEach(h => {
      const prev = prevNav[h.fundCode];
      const shares = parseFloat(h.shares);
      if (!prev || !(shares > 0)) return;
      const fundBase = shares * prev; // 该基金昨日市值
      totalBase += fundBase;
      const info = navInfo[h.fundCode];
      if (info && info.published) {
        pubBase += fundBase;
        // 同 resolveRate：金额用净值差算，别用「官方涨幅(2 位) × 昨日市值」，否则与页面差几元
        real += info.nav > 0 ? (info.nav - prev) * shares : fundBase * info.changeRate / 100;
        pubCount++;
      }
    });
    if (totalBase <= 0) { skipped++; continue; }
    const estRate = rateMap[sub._openid];
    // 最终收益 = 已发布真实 + 未发布部分按组合估算兜底
    const finalProfit = real + (estRate != null ? (totalBase - pubBase) * estRate / 100 : 0);
    if (isNaN(finalProfit)) { skipped++; continue; }
    // 估算偏差样本（P1-6）：仅收「全部可计算基金官方净值均已发布」（pubBase==totalBase>0）的用户，
    // 此时官方加权实际率 real/pubBase 与组合估算率 estRate 同为组合级、可同口径对比；
    // 968 互认基金 T+1 不发布 → pubBase<totalBase 自然不入样；未全发布时官方组合率不可知，不硬比
    const estNum = Number(estRate);
    if (estRate != null && isFinite(estNum) && pubBase > 0 && pubBase === totalBase && isFinite(real)) {
      devSamples.push({ est: estNum, actual: real / pubBase * 100 });
    }
    let text = `最终${finalProfit >= 0 ? "+" : ""}${finalProfit.toFixed(0)}元`;
    if (estRate != null) {
      const estProfit = totalBase * estRate / 100;
      text += `(估${estProfit >= 0 ? "+" : ""}${estProfit.toFixed(0)})`;
    }
    const brief = {
      thing1: { value: "韭菜估值宝" },
      thing2: { value: `我的持仓(${list.length}只)`.slice(0, 20) },
      thing3: { value: text.slice(0, 20) },
      time4: { value: _bjTimeStr() },
    };
    if (dryRun) {
      await db.collection("push_logs").add({
        data: { _openid: sub._openid, scene: "nav_brief", date: dataDay, status: "dry_run", content: brief, sentAt: Date.now(), openedAt: null }
      });
      sent++;
      continue;
    }
    const logId = await createLog(sub._openid, dataDay, "nav_brief");
    try {
      const errcode = await sendSubscribe(accessToken, sub._openid, `${PAGE_PORTFOLIO}?src=push&lid=${logId}`, brief);
      if (errcode !== 0) throw Object.assign(new Error("subscribe/send errcode=" + errcode), { errCode: errcode });
      await finishLog(logId, "sent", "");
      await db.collection("subscriptions").where({ _id: sub._id, quota: _.gt(0) }).update({
        data: { quota: _.inc(-1), updatedAt: Date.now() }
      });
      sent++;
    } catch (e) {
      const errCode = e.errCode || (String(e.message).match(/43101/) ? 43101 : null);
      if (errCode === 43101) {
        await db.collection("subscriptions").doc(sub._id).update({
          data: { quota: 0, updatedAt: Date.now() }
        });
      }
      await finishLog(logId, "failed", `${e.errCode || "ERR"} ${e.errMsg || e.message}`);
      failed++;
    }
  }
  // 估算偏差落库（P1-6 信任线底座）：dryRun 不落库。
  // 用 await 而非 fire-and-forget——云函数 main 返回后实例可能被冻结，未完成的异步写不保证执行
  // （表现：偏差样本随机丢失且无感知），单文档 upsert 仅毫秒级不阻塞可接受的返回时机
  if (!dryRun) {
    try { await saveEstimateDeviation(dataDay, devSamples); }
    catch (e) { console.error("[dailyBriefing][navBrief] estimate_deviation 异常:", e.message); }
  }
  console.log(`[dailyBriefing][navBrief] targets=${targets.length} sent=${sent} failed=${failed} skipped=${skipped} heldForAlert=${heldForAlert} publishedFunds=${pubCount} dryRun=${dryRun}`);
  return { code: 0, msg: `净值播报：发送 ${sent}，失败 ${failed}，跳过 ${skipped}，留额度 ${heldForAlert}${dryRun ? "（dryRun）" : ""}` };
}

// ---- 估算偏差落库（P1-6 信任线底座）----
// 组合级口径，每日一条：_id=dataDay（数据所属交易日）doc.set 幂等 upsert（存在覆盖/不存在创建）。
// estRate=profit_snapshots 末点组合估算率（与收盘小结同口径）；actualRate=该用户全部可计算基金
// 官方净值加权实际率；仅收全发布（pubBase==totalBase）用户样本等权平均。逐基金估算率当日流程
// 不可得（快照只存组合级 rate），故不做逐基金口径；968 互认基金 T+1 不发布自然不入样。
// 内部全兜底不 reject，失败仅记日志；调用方 fire-and-forget 不阻塞播报返回。
async function saveEstimateDeviation(dataDay, samples) {
  try {
    if (!Array.isArray(samples) || samples.length === 0) return;
    const n = samples.length;
    const sum = samples.reduce((a, s) => ({ est: a.est + s.est, act: a.act + s.actual }), { est: 0, act: 0 });
    const estRate = +(sum.est / n).toFixed(2);
    const actualRate = +(sum.act / n).toFixed(2);
    // 集合可能不存在：先建（仿 opsTool.ensureCollection，已存在时报错忽略）
    try { await db.createCollection("estimate_deviation"); } catch (e) { /* 已存在 */ }
    await db.collection("estimate_deviation").doc(dataDay).set({
      data: {
        date: dataDay,
        estRate,
        actualRate,
        deviation: +(estRate - actualRate).toFixed(2), // 估算 - 官方（百分点）
        sampleNote: `组合级口径：全持仓已发布官方净值加权实际率 vs 收盘组合估算率（profit_snapshots 末点，与收盘小结同口径），${n} 个全发布用户等权平均；逐基金估算率当日不可得`,
        ts: Date.now(),
      },
    });
    console.log(`[dailyBriefing][navBrief] estimate_deviation upsert ${dataDay} samples=${n} dev=${(estRate - actualRate).toFixed(2)}`);
  } catch (e) {
    console.error("[dailyBriefing][navBrief] estimate_deviation 写入失败:", e.message);
  }
}

// ---- 周度小结（周六 10:00）：本周收益（五日复利）+ 操作笔数，每周一条 ----
// 周收益率 = Π(1+当日rate/100) - 1（每日快照最后一点复利）；金额按当前市值反推周初基数近似。
// 已知近似：周内加减仓会让收益率口径失真（与日历口径同源问题，XIRR/TWR 改造时统一解决）。
async function runWeeklyBrief(force, dryRun) {
  const today = td.bjDateStr();
  if (!dryRun && !force && new Date(today + "T00:00:00Z").getUTCDay() !== 6) {
    return { code: 0, msg: "非周六跳过" };
  }
  // 本周交易日：从今天往前收集 5 个（周六跑 → 周一~周五）
  const days = [];
  let d = today;
  while (days.length < 5) {
    if (td.isTradingDay(d)) days.unshift(d);
    d = addDays(d, -1);
  }

  const subs = await readAll("subscriptions", dryRun ? { scene: SCENE } : { scene: SCENE, quota: _.gt(0) }, ["_openid", "quota"]);
  const alertUserSet = await alertUserOpenids();   // 同净值播报：给提醒留额度
  if (subs.length === 0) return { code: 0, msg: "无有效订阅" };

  const holdings = await readAll("holdings", {}, ["_openid", "fundCode", "marketValue"]);
  const marketMap = {};
  const fundCount = {};
  holdings.forEach(h => {
    if (!h._openid) return;
    marketMap[h._openid] = (marketMap[h._openid] || 0) + (h.marketValue || 0);
    fundCount[h._openid] = (fundCount[h._openid] || 0);
    if (h.fundCode) fundCount[h._openid]++;
  });

  const targets = subs.filter(s => marketMap[s._openid] > 0);
  if (targets.length === 0) return { code: 0, msg: "无目标用户" };

  // 每用户每日最后 rate → 五日复利
  const rows = await readAll("profit_snapshots", { date: _.in(days) }, ["_openid", "date", "points", "base"]);
  const dayRate = {};
  const dayTp = {};     // 每日金额（快照点 tp，与 rate 同源同口径；旧点没有该字段）
  const weekBaseMap = {}; // 周初基准市值（首日文档级 base = Σ 基准净值 × 份额，即上周五收盘市值）
  rows.forEach(r => {
    if (r.points && r.points.length > 0) {
      const last = r.points[r.points.length - 1];
      dayRate[r._openid] = dayRate[r._openid] || {};
      dayRate[r._openid][r.date] = last.rate;
      if (last.tp != null) {
        dayTp[r._openid] = dayTp[r._openid] || {};
        dayTp[r._openid][r.date] = last.tp;
      }
    }
    if (r.date === days[0] && r.base > 0) weekBaseMap[r._openid] = r.base;
  });

  // 本周操作笔数
  const txRows = await readAll("transactions", {}, ["_openid", "date"]);
  const weekStart = days[0];
  const opCount = {};
  txRows.forEach(t => {
    if (t._openid && t.date && t.date >= weekStart) {
      opCount[t._openid] = (opCount[t._openid] || 0) + 1;
    }
  });

  const sentLogs = await readAll("push_logs", { scene: "weekly_brief", date: today, status: "sent" }, ["_openid"]);
  const sentSet = new Set(sentLogs.map(l => l._openid));

  const runList = dryRun ? targets.slice(0, DRY_RUN_LIMIT) : targets;
  let accessToken = null;
  if (!dryRun) accessToken = await getAccessToken();
  let sent = 0, failed = 0, skipped = 0, heldForAlert = 0;
  for (const sub of runList) {
    if (!dryRun && sentSet.has(sub._openid)) { skipped++; continue; }
    if (!dryRun && alertUserSet.has(sub._openid) && (sub.quota || 0) < 2) { heldForAlert++; continue; }   // 给提醒留额度
    const rates = dayRate[sub._openid];
    if (!rates) { skipped++; continue; } // 本周无快照（新用户/无持仓日）不发
    let mult = 1;
    days.forEach(day => {
      const r = rates[day];
      if (r != null) mult *= 1 + r / 100;
    });
    const weekRate = (mult - 1) * 100;
    // 本周金额：金额按天可加 → 优先把本周各日的当日收益金额相加（精确）；
    // 旧点没有金额字段时退回「周初基准市值 × 周收益率」——周初值取首日快照文档里的 base
    // （= 当日 Σ 基准净值 × 份额 = 上周五收盘市值），不再用 DB 那个从不更新的 holdings.marketValue
    // 反推（旧实现「当前市值/(1+r)×r」，持仓越久偏得越多）；两者都拿不到时不报金额
    const tps = dayTp[sub._openid];
    const ratedDays = days.filter(day => rates[day] != null);
    const tpDays = ratedDays.filter(day => tps && tps[day] != null);
    const weekBase = weekBaseMap[sub._openid] || 0;
    let weekProfit = null;
    if (ratedDays.length > 0 && tpDays.length === ratedDays.length) {
      weekProfit = tpDays.reduce((s, day) => s + (tps[day] || 0), 0);
    } else if (weekBase > 0) {
      weekProfit = weekBase * (weekRate / 100);
    }
    const amtText = weekProfit == null ? "" : `(${weekProfit >= 0 ? "+" : ""}${weekProfit.toFixed(0)}元)`;
    let text = `本周${weekRate >= 0 ? "+" : ""}${weekRate.toFixed(1)}%${amtText}`;
    if (opCount[sub._openid]) text += ` ${opCount[sub._openid]}笔`;
    const brief = {
      thing1: { value: "韭菜估值宝" },
      thing2: { value: `我的持仓(${fundCount[sub._openid] || 0}只)`.slice(0, 20) },
      thing3: { value: text.slice(0, 20) },
      time4: { value: _bjTimeStr() },
    };
    if (dryRun) {
      await db.collection("push_logs").add({
        data: { _openid: sub._openid, scene: "weekly_brief", date: today, status: "dry_run", content: brief, sentAt: Date.now(), openedAt: null }
      });
      sent++;
      continue;
    }
    const logId = await createLog(sub._openid, today, "weekly_brief");
    try {
      const errcode = await sendSubscribe(accessToken, sub._openid, `${PAGE_PORTFOLIO}?src=push&lid=${logId}`, brief);
      if (errcode !== 0) throw Object.assign(new Error("subscribe/send errcode=" + errcode), { errCode: errcode });
      await finishLog(logId, "sent", "");
      await db.collection("subscriptions").where({ _id: sub._id, quota: _.gt(0) }).update({
        data: { quota: _.inc(-1), updatedAt: Date.now() }
      });
      sent++;
    } catch (e) {
      const errCode = e.errCode || (String(e.message).match(/43101/) ? 43101 : null);
      if (errCode === 43101) {
        await db.collection("subscriptions").doc(sub._id).update({
          data: { quota: 0, updatedAt: Date.now() }
        });
      }
      await finishLog(logId, "failed", `${e.errCode || "ERR"} ${e.errMsg || e.message}`);
      failed++;
    }
  }
  console.log(`[dailyBriefing][weeklyBrief] targets=${targets.length} sent=${sent} failed=${failed} skipped=${skipped} dryRun=${dryRun}`);
  return { code: 0, msg: `周度小结：发送 ${sent}，失败 ${failed}，跳过 ${skipped}${dryRun ? "（dryRun）" : ""}` };
}

// PE 温度变化提醒：peAlert 用户的持仓基金 signal 相对云端基线变化 → 每日一条。
// 基线存 alert_settings.peCache：首次只记基线不推送（避免启用当天误报）。
async function checkPeAlerts(targets, byUser, todaySigs, dataDay, accessToken, dryRun) {
  const firedLogs = await readAll("push_logs", { scene: "pe_alert", date: dataDay, status: "sent" }, ["_openid"]);
  const firedSet = new Set(firedLogs.map(l => l._openid));
  const alertDocs = await readAll("alert_settings", {}, ["_openid", "settings", "peCache"]);
  const alertMap = {};
  alertDocs.forEach(d => { alertMap[d._openid] = d; });

  let sent = 0;
  for (const sub of targets) {
    if (firedSet.has(sub._openid)) continue;
    const doc = alertMap[sub._openid];
    if (!doc || !doc.settings) continue;
    const settings = doc.settings;
    const peCache = doc.peCache || {};
    let cacheChanged = false;
    const hits = [];
    (byUser[sub._openid] || []).forEach(h => {
      const s = settings[h.fundCode];
      if (!s || !s.peAlert) return;
      // 单条规则停用（提醒管理页开关）：不发推送并清基线（重开时避免拿旧基线误报）
      if (s.enabled === false) {
        if (peCache[h.fundCode] !== undefined) { delete peCache[h.fundCode]; cacheChanged = true; }
        return;
      }
      const cur = todaySigs.get(h.fundCode);
      if (!cur || cur === "nodata") return;
      const base = peCache[h.fundCode];
      if (!base) {
        peCache[h.fundCode] = cur;
        cacheChanged = true;
        return; // 首日只记基线
      }
      if (base !== cur) {
        const up = (base === "low" && cur !== "low") || (base === "mid" && cur === "high");
        hits.push({
          fundCode: h.fundCode,
          fundName: h.fundName || h.fundCode,
          text: `温度${SIGNAL_CN[base] || base}→${SIGNAL_CN[cur] || cur}`,
          up,
        });
        peCache[h.fundCode] = cur;
        cacheChanged = true;
      }
    });
    if (cacheChanged) {
      await db.collection("alert_settings").doc(doc._id).update({
        data: { peCache, updatedAt: Date.now() }
      }).catch(() => {});
    }
    if (hits.length === 0) continue;
    const first = hits[0];
    const text = hits.length > 1 ? `${first.text} 等${hits.length}只` : first.text;
    if (dryRun) {
      await db.collection("push_logs").add({
        data: { _openid: sub._openid, scene: "pe_alert", date: dataDay, status: "dry_run", content: { fundName: first.fundName, text }, sentAt: Date.now(), openedAt: null }
      });
      sent++;
      continue;
    }
    if (!accessToken) continue;
    const brief = {
      thing1: { value: "韭菜估值宝" },
      thing2: { value: String(first.fundName).slice(0, 20) },
      thing3: { value: text.slice(0, 20) },
      time4: { value: _bjTimeStr() },
    };
    const logId = await createLog(sub._openid, dataDay, "pe_alert", first.fundCode, first.up ? "up" : "down");
    try {
      const errcode = await sendSubscribe(accessToken, sub._openid, `${PAGE_FUND}?fundCode=${first.fundCode}&src=push&lid=${logId}`, brief);
      if (errcode !== 0) throw Object.assign(new Error("subscribe/send errcode=" + errcode), { errCode: errcode });
      await finishLog(logId, "sent", "");
      await db.collection("subscriptions").where({ _id: sub._id, quota: _.gt(0) }).update({
        data: { quota: _.inc(-1), updatedAt: Date.now() }
      });
      sent++;
    } catch (e) {
      const errCode = e.errCode || (String(e.message).match(/43101/) ? 43101 : null);
      if (errCode === 43101) {
        await db.collection("subscriptions").doc(sub._id).update({
          data: { quota: 0, updatedAt: Date.now() }
        });
      }
      await finishLog(logId, "failed", `${e.errCode || "ERR"} ${e.errMsg || e.message}`);
    }
  }
  return sent;
}

// ---- 文案装配 ----
// thing 字段限 20 字符。装配：账号位=品牌、用户位=持仓概览、数据位=涨跌+温度变化。
// 措辞红线：数据陈述（估算 X 元 / 温度转偏高），不出现"收益/建议/止盈"字样。
// ---- 确认门：拉今日官方净值，判定「最终收益已确定」----
// 返回 navInfo（已发布基金涨幅）、prevNav（前日净值基准）、确认状态；
// 968 互认基金 T+1 公布，不参与当日确认；isLastSlot=23:00 最后检查档（兜底发送）
async function collectConfirmation(targets, byUser, dataDay) {
  const codeSet = new Set();
  targets.forEach(t => (byUser[t._openid] || []).forEach(h => { if (h.fundCode) codeSet.add(h.fundCode); }));
  const codes = [...codeSet];
  const navInfo = {};
  const prevNav = {};
  const navStart = Date.now();
  const CONCURRENT = 16;
  for (let i = 0; i < codes.length && Date.now() - navStart < 90000; i += CONCURRENT) {
    const batch = codes.slice(i, i + CONCURRENT);
    const results = await Promise.all(batch.map(async (code) => {
      try { return { code, r: await fd.fetchLatestNavEastMoney(code) }; } catch (e) { return { code, r: {} }; }
    }));
    results.forEach(({ code, r }) => {
      if (r && r.actualDate === dataDay && r.actualChangeRate != null) {
        // nav 一并留着：算金额要用「今日净值 − 昨日净值」，不能用「涨幅 × 昨日市值」
        //（官方涨幅只保留 2 位小数，乘上几十万市值后单只可偏 3 元 → 播报与页面对不上）
        navInfo[code] = { published: true, changeRate: r.actualChangeRate, nav: r.actualNav || null };
      }
    });
  }
  // 前日净值基准：fund_navs 的 dataDay 记录即前日净值（snapshotProfit 盘中写入）
  const prevRows = await readAll("fund_navs", { date: dataDay }, ["fundCode", "yesterdayNav"]);
  prevRows.forEach(r => { if (r.yesterdayNav > 0) prevNav[r.fundCode] = r.yesterdayNav; });

  const t1Count = codes.filter(c => String(c).startsWith("968")).length;
  const publishedCount = Object.keys(navInfo).length;
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000);
  const isLastSlot = bjNow.getUTCHours() === 23 && bjNow.getUTCMinutes() === 0;
  return {
    navInfo,
    prevNav,
    publishedCount,
    totalCount: codes.length,
    allConfirmed: codes.length > 0 && publishedCount + t1Count >= codes.length,
    isLastSlot,
  };
}

// 组合收益率与金额基数（与页面 getPortfolio 混合口径对齐）：
// - 全确认：rate=官方净值加权实际涨幅，base=份额×前日净值（昨日市值），confirmed=true
// - 未全确认（仅 23:00 兜底档触达）：已发布基金按官方实际、未发布部分按组合估算率兜底，
//   confirmed=false 供文案标"估"区分
// - 完全无前日净值数据：rate=组合估算率、base=DB marketValue（旧兜底），confirmed=false
function resolveRate(funds, confirmation, estRate, dbMarket) {
  const { navInfo, prevNav } = confirmation;
  let totalBase = 0, real = 0, estBase = 0, computable = 0, published = 0;
  funds.forEach(f => {
    if (String(f.fundCode || "").startsWith("968")) return; // T+1 不计入当日口径
    const prev = prevNav[f.fundCode];
    const shares = parseFloat(f.shares);
    let base = shares > 0 && prev > 0 ? shares * prev : 0;
    const hasPrev = base > 0;
    if (hasPrev) computable++;
    if (base <= 0 && parseFloat(f.marketValue) > 0) base = parseFloat(f.marketValue); // 无前日净值做基数兜底
    if (base <= 0) return;
    totalBase += base;
    const info = navInfo[f.fundCode];
    if (info && info.published) {
      if (hasPrev) published++;
      // 金额与页面 getPortfolio 同口径：(今日净值 − 昨日净值) × 份额。
      // 不能用「昨日市值 × 官方涨幅」——官方涨幅只保留 2 位小数，乘上几十万市值后
      // 单只就能偏 3 元（实测 12 只累计 -5.4 元：播报 +15207 vs 页面 +15212.41）
      real += (hasPrev && info.nav > 0) ? (info.nav - prev) * shares : base * info.changeRate / 100;
    } else {
      estBase += base;
    }
  });
  if (computable === 0 || totalBase <= 0) {
    // 无任何可计算基金：完全回退估算口径（旧行为）
    if (estRate != null && dbMarket > 0) return { rate: estRate, base: dbMarket, confirmed: false };
    return null;
  }
  const rate = (real + (estRate != null ? estBase * estRate / 100 : 0)) / totalBase * 100;
  return { rate, base: totalBase, confirmed: published === computable };
}

function buildBrief(openid, funds, baseValue, rate, todaySigs, prevSigs, estimated) {
  let ups = 0, downs = 0;
  funds.forEach(f => {
    const t = todaySigs.get(f.fundCode), p = prevSigs.get(f.fundCode);
    if (!t || !p || t === "nodata" || p === "nodata" || t === p) return;
    if (SIGNAL_ORDER[t] > SIGNAL_ORDER[p]) ups++; else downs++;
  });
  if (rate == null && ups + downs === 0) return null;

  let data;
  if (rate != null && baseValue > 0) {
    const amount = baseValue * rate / 100;
    const amt = `${amount >= 0 ? "+" : ""}${amount.toFixed(0)}元`;
    if (ups + downs > 0) {
      const tempTxt = [
        ups > 0 ? `${ups}只转偏高` : "",
        downs > 0 ? `${downs}只转偏低` : ""
      ].filter(Boolean).join(",");
      data = `${amt},${tempTxt}`;
    } else {
      // 未确认时含估算兜底部分，文案标"估"与全确认实际口径区分
      const rateTxt = estimated
        ? `估${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`
        : `${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`;
      data = `${amt}(${rateTxt})`;
    }
  } else if (rate != null) {
    data = `今日估算${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`;
  } else {
    data = "温度" + [
      ups > 0 ? `${ups}只转偏高` : "",
      downs > 0 ? `${downs}只转偏低` : ""
    ].filter(Boolean).join(",");
  }
  return {
    thing1: { value: "韭菜估值宝" },
    thing2: { value: `我的持仓(${funds.length}只)`.slice(0, 20) },
    thing3: { value: data.slice(0, 20) },
    time4: { value: _bjTimeStr() },
  };
}

function loadSignals(date) {
  return readAll("fund_temperatures", { date }, ["fundCode", "signal"]).then(rows => {
    const map = new Map();
    rows.forEach(r => map.set(r.fundCode, r.signal));
    return map;
  });
}

async function createLog(openid, date, scene = SCENE, fundCode = "", kind = "") {
  const r = await db.collection("push_logs").add({
    data: { _openid: openid, scene, date, status: "sending", errMsg: "", sentAt: Date.now(), openedAt: null, fundCode: fundCode || "", kind: kind || "" }
  });
  return r._id;
}

async function finishLog(logId, status, errMsg) {
  await db.collection("push_logs").doc(logId).update({
    data: { status, errMsg: errMsg || "" }
  }).catch(e => console.warn("[dailyBriefing] log 更新失败:", e.message));
}

// ---- HTTP API：stable_token + subscribe/send ----
function httpPost(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.weixin.qq.com",
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 8000,
    }, (res) => {
      let buf = "";
      res.on("data", d => (buf += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error("响应解析失败: " + buf.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  // 密钥优先环境变量，兜底数据库 app_config 集合（secret 不入代码库）
  let secret = process.env.WX_APP_SECRET || "";
  if (!secret) {
    const cfg = await db.collection("app_config").doc("wx_app_secret").get().catch(() => null);
    secret = (cfg && cfg.data && cfg.data.value) || "";
  }
  if (!secret) throw new Error("WX_APP_SECRET 未配置（环境变量或 app_config 集合 wx_app_secret 文档）");
  const r = await httpPost("/cgi-bin/stable_token", {
    grant_type: "client_credential",
    appid: WX_APPID,
    secret,
  });
  if (!r.access_token) throw new Error("stable_token 获取失败: " + JSON.stringify(r).slice(0, 200));
  return r.access_token;
}

// 返回 errcode：0 = 成功；43101 = 用户已拒收
async function sendSubscribe(token, touser, page, data) {
  const r = await httpPost(`/cgi-bin/message/subscribe/send?access_token=${token}`, {
    touser,
    template_id: TEMPLATE_ID,
    page,
    miniprogram_state: MINI_STATE,
    lang: "zh_CN",
    data,
  });
  return r.errcode || 0;
}

// 北京时间 YYYY年M月D日 HH:mm（time 字段格式与模板示例一致）
function _bjTimeStr() {
  const bj = new Date(Date.now() + 8 * 3600000);
  const p2 = n => String(n).padStart(2, "0");
  return `${bj.getUTCFullYear()}年${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${p2(bj.getUTCHours())}:${p2(bj.getUTCMinutes())}`;
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
