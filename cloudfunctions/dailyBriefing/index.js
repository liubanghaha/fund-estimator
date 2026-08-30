const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const td = require("./_shared/trading-day");

// 云调用（cloud.openapi）在本环境返回 -501001（INVALID_WX_ACCESS_TOKEN，云调用权限链路历史遗留），
// 发送改走 HTTP API：stable_token 免 IP 白名单校验，SECRET 放云函数环境变量 WX_APP_SECRET（不入库）。
const WX_APPID = "wxb95098fe432ed765";

// ===== 配置 =====
// 模板「温度数据通知」（信息查询类目，模板编号 38431）：
// thing1=测量账号 thing2=被测量用户 thing3=测量数据 time4=测量时间
const TEMPLATE_ID = "A7Sc6sngopPiROImJeqfi5K6ciJKTRrNzE1gug2tzuk";
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
    return await runBriefing(!!event.dryRun, !!event.force);
  } catch (e) {
    console.error("[dailyBriefing] 失败:", e.message);
    return { code: -1, msg: e.message };
  }
};

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

  // 3. 温度变化：数据交易日 vs 上一交易日的全市场 signal
  const [todaySigs, prevSigs] = await Promise.all([loadSignals(dataDay), loadSignals(prevDay)]);

  // 4. 收益快照：每人 points 最后一条 rate（收盘后必然存在）
  const rateMap = {};
  const snaps = await readAll("profit_snapshots", { date: dataDay }, ["_openid", "points"]);
  snaps.forEach(s => {
    if (s.points && s.points.length > 0) rateMap[s._openid] = s.points[s.points.length - 1].rate;
  });

  // 5. 分批发送（防重发：当天已成功发送过的用户跳过，覆盖 force 补发场景）
  const sentLogs = await readAll("push_logs", { scene: SCENE, date: dataDay, status: "sent" }, ["_openid"]);
  const sentSet = new Set(sentLogs.map(l => l._openid));
  const runList = dryRun ? targets.slice(0, DRY_RUN_LIMIT) : targets;
  // stable_token 官方建议每次业务调用时获取（未过期时接口自动复用同一 token）
  let accessToken = null;
  if (!dryRun) accessToken = await getAccessToken();
  let sent = 0, failed = 0, skipped = 0;
  for (let i = 0; i < runList.length; i += BATCH_SIZE) {
    const batch = runList.slice(i, i + BATCH_SIZE);
    for (const sub of batch) {
      if (!dryRun && sentSet.has(sub._openid)) { skipped++; continue; }
      const brief = buildBrief(sub._openid, byUser[sub._openid], totalMarket[sub._openid], rateMap[sub._openid], todaySigs, prevSigs);
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
        const errcode = await sendSubscribe(accessToken, sub._openid, `${PAGE_BASE}?src=push&lid=${logId}`, brief);
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
  return { code: 0, msg: `发送 ${sent}，失败 ${failed}，跳过 ${skipped}${dryRun ? "（dryRun）" : ""}` };
}

// ---- 文案装配 ----
// thing 字段限 20 字符。装配：账号位=品牌、用户位=持仓概览、数据位=涨跌+温度变化。
// 措辞红线：数据陈述（估算 X 元 / 温度转偏高），不出现"收益/建议/止盈"字样。
function buildBrief(openid, funds, marketValue, rate, todaySigs, prevSigs) {
  let ups = 0, downs = 0;
  funds.forEach(f => {
    const t = todaySigs.get(f.fundCode), p = prevSigs.get(f.fundCode);
    if (!t || !p || t === "nodata" || p === "nodata" || t === p) return;
    if (SIGNAL_ORDER[t] > SIGNAL_ORDER[p]) ups++; else downs++;
  });
  if (rate == null && ups + downs === 0) return null;

  let data;
  if (rate != null && marketValue > 0) {
    const amount = marketValue * rate / 100;
    const amt = `${amount >= 0 ? "+" : ""}${amount.toFixed(0)}元`;
    if (ups + downs > 0) {
      const tempTxt = [
        ups > 0 ? `${ups}只转偏高` : "",
        downs > 0 ? `${downs}只转偏低` : ""
      ].filter(Boolean).join(",");
      data = `${amt},${tempTxt}`;
    } else {
      data = `${amt}(${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%)`;
    }
  } else if (rate != null) {
    data = `今日估算${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`;
  } else {
    data = "温度" + [
      ups > 0 ? `${ups}只转偏高` : "",
      downs > 0 ? `${downs}只转偏低` : ""
    ].filter(Boolean).join(",");
  }
  // time4：北京时间 YYYY年M月D日 HH:mm（与模板示例格式一致）
  const bj = new Date(Date.now() + 8 * 3600000);
  const p2 = n => String(n).padStart(2, "0");
  const timeStr = `${bj.getUTCFullYear()}年${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${p2(bj.getUTCHours())}:${p2(bj.getUTCMinutes())}`;
  return {
    thing1: { value: "韭菜估值宝" },
    thing2: { value: `我的持仓(${funds.length}只)`.slice(0, 20) },
    thing3: { value: data.slice(0, 20) },
    time4: { value: timeStr },
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
