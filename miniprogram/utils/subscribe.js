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
const DECLINE_COOLDOWN = 7 * 24 * 3600 * 1000;

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
function dismissPrompt() {
  _markDeclined();
}

// 拉起授权弹窗：accept → 云函数 auth 记额度；reject/关闭 → 记 7 天频控。
// 须在用户点击回调中调用（微信限制 requestSubscribeMessage 的触发时机）。
function requestAuth() {
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
          resolve({ ok: true });
        } else {
          _markDeclined();
          resolve({ ok: false, reason: "reject" });
        }
      },
      fail(err) {
        const msg = (err && err.errMsg) || "";
        if (msg.indexOf("cancel") !== -1) _markDeclined();
        resolve({ ok: false, reason: msg || "fail" });
      },
    });
  });
}

// 已授权用户的静默攒额度：每天最多一次，必须挂在用户手势回调中
// （如首页下拉刷新 onScrollRefresh）。勾了「总是保持以上选择」的用户无感 accept；
// 未勾的用户会再弹一次授权弹窗，失败静默无副作用。
function silentDailyAuth() {
  if (!hasAuthed()) return;
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
      }
    },
    fail() { /* 静默失败无副作用 */ },
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

module.exports = { TEMPLATE_ID, requestAuth, canPrompt, hasAuthed, dismissPrompt, silentDailyAuth, bindTrackOpen };
