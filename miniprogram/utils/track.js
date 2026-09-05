/**
 * 统一埋点（产品规划 P0-0 埋点地基）：队列 + 批量直连写 events 集合。
 * 模式沿用 app.js _trackLaunch 的直连写库：不经云函数（不增加冷启动）、失败静默、不引第三方 SDK。
 *
 * 6 事件口径（产品规划 P0-0）：
 *   app_launch    存量直连保留（analytics_launches，不经本模块）
 *   record_trade  加减仓/记一笔成功（source/direction/amount/amountBand/fundCode）
 *   sub_authorize 订阅授权（四来源 src + mode + result）
 *   share         分享确认（onShareAppMessage 触发即用户确认转发）
 *   push_open     存量保留（push_logs.openedAt，服务端记录）
 *   search_fund   搜索执行（kw/hit/n）
 *
 * 每条自动附带通用上下文（调用方只传业务属性）：
 *   ts 客户端毫秒时间戳 / date 北京日期 / phase 盘中三态(trading|afterClose|closed) /
 *   v 线上版本号 / env 发布环境(develop|trial|release) / sid 本次启动会话 ID /
 *   scene 启动场景值 / page 当前页面路由
 * 客户端匿名不含 openid；直连写库时微信自动补 _openid，云端可关联到用户。
 */

const COLLECTION = "events";
const KEY_QUEUE = "track_queue_v1";
const FLUSH_SIZE = 8;       // 攒够即发
const FLUSH_DELAY = 15000;  // 不足一批 15s 后发
const FLUSH_BATCH = 20;     // 单次并发写入上限
const MAX_QUEUE = 120;      // 极端离线防膨胀（丢最旧）

const mt = require("./market-time.js");

let _sid = "";
let _scene = null;
let _queue = [];
let _timer = null;
let _flushing = false;

function _account() {
  try { return wx.getAccountInfoSync().miniProgram || {}; } catch (e) { return {}; }
}

// 启动会话 ID：冷启动生成一次，串起一次使用内的行为漏斗
function _newSid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function _page() {
  try {
    const pages = getCurrentPages();
    return (pages[pages.length - 1] && pages[pages.length - 1].route) || "";
  } catch (e) { return ""; }
}

// 冷启动调用（app.js onLaunch，须在 wx.cloud.init 之后）。幂等，热启动不重建会话。
function init() {
  if (_sid) return;
  _sid = _newSid();
  try { _scene = (wx.getLaunchOptionsSync() || {}).scene; } catch (e) { /* ignore */ }
  // 上次未发完的队列接回来（进程被杀不丢事件；属性在入队时已定格）
  try {
    const saved = wx.getStorageSync(KEY_QUEUE);
    if (Array.isArray(saved) && saved.length) _queue = saved.slice(-MAX_QUEUE);
  } catch (e) { /* ignore */ }
  if (_queue.length) _schedule(2000); // 启动后 2s 补发，避开冷启动关键路径
}

// 通用入口。props 只放业务属性；通用上下文在此统一补齐。
function track(event, props) {
  if (!event) return;
  const mp = _account();
  const e = Object.assign({ event }, props || {}, {
    ts: Date.now(),
    date: mt.bjDateStr(),
    phase: mt.marketPhase(),
    v: mp.version || "0.0.0",
    env: mp.envVersion || "release",
    sid: _sid,
    scene: _scene,
    page: _page(),
  });
  _queue.push(e);
  if (_queue.length > MAX_QUEUE) _queue.splice(0, _queue.length - MAX_QUEUE);
  _persist();
  if (_queue.length >= FLUSH_SIZE) _flush();
  else _schedule(FLUSH_DELAY);
}

// app onHide 调用：退后台立刻落库，避免进程被杀丢批
function flush() { _flush(); }

function _persist() {
  try { wx.setStorageSync(KEY_QUEUE, _queue); } catch (e) { /* ignore */ }
}

function _schedule(delay) {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; _flush(); }, delay);
}

function _flush() {
  if (_flushing || !_queue.length) return;
  if (!wx.cloud || !wx.cloud.database) { _schedule(FLUSH_DELAY); return; }
  _flushing = true;
  const batch = _queue.splice(0, FLUSH_BATCH);
  const db = wx.cloud.database();
  Promise.all(batch.map((e) =>
    db.collection(COLLECTION).add({ data: e }).catch(() => { _queue.push(e); }) // 单条失败回队尾
  )).then(() => {
    _flushing = false;
    _persist();
    if (_queue.length >= FLUSH_SIZE) _flush();
    else if (_queue.length) _schedule(FLUSH_DELAY);
  }).catch(() => {
    _flushing = false;
    _schedule(FLUSH_DELAY);
  });
}

// —— 业务事件封装（调用点一行可读，属性口径见产品规划 P0-0 事件表）——

// 记一笔：加减仓成功。props: { source, direction, amount, amountBand, fundCode, fundName }
function recordTrade(props) { track("record_trade", props); }

// 订阅授权。props: { src, mode, result }  src: index_pull|user_center|profit_calendar|scene_alert
//                                            mode: prompt|silent   result: accept|reject|fail|dismiss_banner
function subAuthorize(props) { track("sub_authorize", props); }

// 分享确认。props: { sharePage, hasToken, hasProfit }
function share(props) { track("share", props); }

// 搜索。props: { kw, hit, n, err }
function searchFund(props) { track("search_fund", props); }

// 分享/渠道落地（漏斗第一环：分享卡 → 横幅 → 记一笔）。props: { src, token?, channelId? }
//   src: share_token（分享卡 ?share= 落地）| promo_channel（渠道码 scene 落地，服务端 trackVisit 保留，此条补客户端上下文）
//   卡片拉取失败补埋一条同事件 { src, token, err: "card_fail" }：到达口径=不带 err 的 count，失败率=带 err / 不带 err
function shareLanding(props) { track("share_landing", props); }

// 落地转化（漏斗第二环）：分享落地横幅 CTA 点击。props: { cta, isLoggedIn }
function landingConvert(props) { track("landing_convert", props); }

// 推送落地上下文（push_open 客户端补埋；服务端 push_logs.openedAt 仍是打开率权威口径，勿双算）。
// props: { lid, entry: cold|warm, path } —— 用于召回实验"召回批 7 日回访"的落地归因
function pushOpen(props) { track("push_open", props); }

// 金额档位（record_trade 用）：统一口径单点维护
function amountBand(amount) {
  const n = Math.abs(parseFloat(amount) || 0);
  if (n >= 100000) return "10w+";
  if (n >= 10000) return "1w-10w";
  if (n >= 1000) return "1k-1w";
  return "<1k";
}

module.exports = { init, track, flush, recordTrade, subAuthorize, share, searchFund, shareLanding, landingConvert, pushOpen, amountBand };
