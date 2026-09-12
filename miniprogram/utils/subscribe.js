/**
 * 订阅消息「收盘播报」：授权引导 + 额度记录 + 推送落地追踪。
 * 模板「温度数据通知」与云函数 dailyBriefing 同源（一次性订阅：一次授权 = 一条发送额度）。
 * 攒额度机制：用户勾选「总是保持以上选择」后，后续调用静默 accept——
 * 所以对已授权用户在用户手势回调里（首页下拉刷新）每天静默调一次补充额度。
 */
const TEMPLATE_ID = "A7Sc6sngopPiROImJeqfi5K6ciJKTRrNzE1gug2tzuk";
const SCENE = "closing_brief";
const KEY_DECLINED = "brief_declined_at"; // 最近一次拒绝/关闭时间（7 天频控）
const KEY_AUTHED = "brief_authed";        // 是否主动授权过
const KEY_SILENT_DAY = "brief_silent_day"; // 最近一次静默授权日期（每天最多一次）
const KEY_SILENT_POPUP = "brief_silent_popup_at"; // 最近一次弹窗式静默授权时间（未勾「总是允许」会弹窗，7 天降频）
const KEY_ALWAYS_ALLOW = "brief_always_allow";    // 「总是保持以上选择」勾选状态探测缓存（getSetting withSubscriptions）
const KEY_ALERT_DAY = "alert_auth_day";   // 提醒类授权的请求日期（每天最多弹一次授权窗）
const DECLINE_COOLDOWN = 7 * 24 * 3600 * 1000;
const track = require("./track.js"); // P0-0 sub_authorize 事件

function canPrompt() {
  try {
    const t = wx.getStorageSync(KEY_DECLINED);
    return !(t && Date.now() - t < DECLINE_COOLDOWN);
  } catch (e) {
    return true;
  }
}

function hasAuthed() {
  try {
    return !!wx.getStorageSync(KEY_AUTHED);
  } catch (e) {
    return false;
  }
}

function _markDeclined() {
  try {
    wx.setStorageSync(KEY_DECLINED, Date.now());
  } catch (e) { /* ignore */ }
}

// 引导条被手动关闭：按拒绝处理走 7 天频控
function dismissPrompt(src) {
  _markDeclined();
  // 关闭引导条 = 明确拒绝信号（区别于弹窗 reject），单独立项供引导位效果分析
  try { track.subAuthorize({ src: src || "", mode: "prompt", result: "dismiss_banner" }); } catch (e) { /* ignore */ }
}

// 拉起授权弹窗：accept → 云函数 auth 记额度；reject/关闭 → 记 7 天频控。
// 须在用户点击回调中调用（微信限制 requestSubscribeMessage 的触发时机）。
// src：授权来源（index_pull|user_center|profit_calendar|scene_alert），供 sub_authorize 归因
function requestAuth(src) {
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [TEMPLATE_ID],
      success(res) {
        if (res[TEMPLATE_ID] === "accept") {
          try {
            wx.setStorageSync(KEY_AUTHED, Date.now());
          } catch (e) { /* ignore */ }
          // 额度已由微信侧授予；云函数记录失败不影响授权状态
          wx.cloud.callFunction({
            name: "dailyBriefing",
            data: { action: "auth", scene: SCENE, templateId: TEMPLATE_ID },
          }).catch(() => {});
          try { track.subAuthorize({ src: src || "", mode: "prompt", result: "accept" }); } catch (e) { /* ignore */ }
          resolve({ ok: true });
        } else {
          _markDeclined();
          try { track.subAuthorize({ src: src || "", mode: "prompt", result: "reject" }); } catch (e) { /* ignore */ }
          resolve({ ok: false, reason: "reject" });
        }
      },
      fail(err) {
        const msg = (err && err.errMsg) || "";
        if (msg.indexOf("cancel") !== -1) _markDeclined();
        try { track.subAuthorize({ src: src || "", mode: "prompt", result: "fail" }); } catch (e) { /* ignore */ }
        resolve({ ok: false, reason: msg || "fail" });
      },
    });
  });
}

// 提醒类授权的频控版 requestAuth：每天最多拉起一次弹窗——
// 当天首次保存提醒时弹（未勾「总是保持以上选择」的用户不再反复被问）；
// 当天已请求过的，仅对已授权用户静默调一次 requestSubscribeMessage 攒额度
// （勾了「总是保持以上选择」的用户微信侧无感通过，每次保存=每条提醒的推送额度）。
function requestAlertAuth(src) {
  const today = new Date().toDateString();
  try {
    if (wx.getStorageSync(KEY_ALERT_DAY) === today) {
      if (hasAuthed()) {
        wx.requestSubscribeMessage({
          tmplIds: [TEMPLATE_ID],
          success(res) {
            if (res[TEMPLATE_ID] === "accept") {
              wx.cloud.callFunction({
                name: "dailyBriefing",
                data: { action: "auth", scene: SCENE, templateId: TEMPLATE_ID },
              }).catch(() => {});
            }
          },
          fail() { /* 静默失败不影响保存 */ },
        });
      }
      return Promise.resolve({ ok: true, silent: true });
    }
    wx.setStorageSync(KEY_ALERT_DAY, today);
  } catch (e) { /* ignore */ }
  return requestAuth(src);
}

// 已授权用户的静默攒额度：必须挂在用户手势回调中（如首页下拉刷新 onScrollRefresh）。
// 勾了「总是保持以上选择」的用户无感 accept，保持每天一次；
// 未勾的用户调用会弹授权弹窗，降频为 7 天最多一次（避免每次下拉都被打扰）。
function silentDailyAuth(src) {
  if (!hasAuthed()) return;
  try {
    // 未勾「总是允许」时调用必弹窗：距上次弹窗不足 7 天则跳过
    if (!wx.getStorageSync(KEY_ALWAYS_ALLOW)) {
      const lastPopup = wx.getStorageSync(KEY_SILENT_POPUP) || 0;
      if (lastPopup && Date.now() - lastPopup < 7 * 24 * 3600 * 1000) return;
    }
  } catch (e) { /* ignore */ }
  try {
    const today = new Date().toDateString();
    if (wx.getStorageSync(KEY_SILENT_DAY) === today) return;
    wx.setStorageSync(KEY_SILENT_DAY, today);
  } catch (e) {
    return;
  }
  wx.requestSubscribeMessage({
    tmplIds: [TEMPLATE_ID],
    success(res) {
      if (res[TEMPLATE_ID] === "accept") {
        wx.cloud.callFunction({
          name: "dailyBriefing",
          data: { action: "auth", scene: SCENE, templateId: TEMPLATE_ID },
        }).catch(() => {});
        try { track.subAuthorize({ src: src || "", mode: "silent", result: "accept" }); } catch (e) { /* ignore */ }
      }
      _probeAlwaysAllow();
    },
    fail() {
      try { track.subAuthorize({ src: src || "", mode: "silent", result: "fail" }); } catch (e) { /* ignore */ }
      _probeAlwaysAllow();
    },
  });
}

// 探测「总是保持以上选择」勾选状态并缓存：itemSettings 仅在用户勾选后返回。
// 勾选了（accept）→ 静默场景保持每天；未勾选 → 记弹窗时间戳走 7 天降频。
function _probeAlwaysAllow() {
  wx.getSetting({
    withSubscriptions: true,
    success(res) {
      try {
        const itemSettings = (res.subscriptionsSetting && res.subscriptionsSetting.itemSettings) || {};
        const alwaysAllow = itemSettings[TEMPLATE_ID] === "accept";
        wx.setStorageSync(KEY_ALWAYS_ALLOW, alwaysAllow);
        if (!alwaysAllow) wx.setStorageSync(KEY_SILENT_POPUP, Date.now());
      } catch (e) { /* ignore */ }
    },
    fail() { /* 探测失败保持现状：下次仍按未勾选场景降频 */ },
  });
}

// 推送落地追踪：首页 _handleEntry 检测 src=push&lid=推送日志ID 后调用，补 openedAt
function bindTrackOpen(lid) {
  if (!lid) return;
  wx.cloud.callFunction({
    name: "dailyBriefing",
    data: { action: "trackOpen", logId: String(lid).slice(0, 40) },
  }).catch(() => {});
}

// 查推送日志类型（召回落地判定用；服务端带 _openid 校验只返回本人日志）
function getPushKind(lid) {
  if (!lid) return Promise.resolve("");
  return new Promise((resolve) => {
    wx.cloud.callFunction({
      name: "dailyBriefing",
      data: { action: "logInfo", logId: String(lid).slice(0, 40) },
    }).then((res) => {
      const d = res.result && res.result.data;
      resolve((d && d.kind) || "");
    }).catch(() => resolve(""));
  });
}

// 一键退订召回（只停召回，收盘小结/净值播报双条照常）
function optOutRecall() {
  return wx.cloud.callFunction({
    name: "dailyBriefing",
    data: { action: "recallOptOut" },
  }).catch(() => {});
}

module.exports = { TEMPLATE_ID, requestAuth, requestAlertAuth, canPrompt, hasAuthed, dismissPrompt, silentDailyAuth, bindTrackOpen, getPushKind, optOutRecall };
