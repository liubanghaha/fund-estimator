"use strict";
/**
 * 运维告警（生产级补课 #2，2026-11-07）：定时任务失败 → ops_admins 全员订阅消息。
 *
 * 使用方式（各云函数入口已 cloud.init，db 由调用方注入，本模块零 wx-server-sdk 依赖）：
 *   const { sendAdminAlert } = require("./_shared/admin-alert");
 *   await sendAdminAlert(db, { title: "温度任务失败", detail: "超时", date: "2026-11-07" });
 *
 * 通道：stable_token HTTP 直发（与 dailyBriefing 同源——secret 优先环境变量 WX_APP_SECRET，
 * 兜底 app_config/wx_app_secret，不入代码库）；模板「收益到账通知」（BRIEF）；
 * thing3 ≤20 字、thing5 ≤20 字；43101（用户未授权/拒收）降级静默——尽力而为。
 * ops_admins 白名单由 opsTool registerAdmin 维护（密钥注册制，见 opsTool/env.json）。
 */
const https = require("https");

const WX_APPID = "wxb95098fe432ed765";
const TEMPLATE_ID_BRIEF = "xmA8hb_yaI2AWl1Ulhh4J8pE1eBn09udmAvu68beu8s";

function httpPost(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: "api.weixin.qq.com", path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("JSON 解析失败")); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("超时")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken(db) {
  let secret = process.env.WX_APP_SECRET || "";
  if (!secret) {
    const cfg = await db.collection("app_config").doc("wx_app_secret").get().catch(() => null);
    secret = (cfg && cfg.data && cfg.data.value) || "";
  }
  if (!secret) throw new Error("WX_APP_SECRET 未配置（环境变量或 app_config/wx_app_secret）");
  const r = await httpPost("/cgi-bin/stable_token", { grant_type: "client_credential", appid: WX_APPID, secret });
  if (!r.access_token) throw new Error("stable_token 获取失败: " + JSON.stringify(r).slice(0, 150));
  return r.access_token;
}

async function listAdmins(db) {
  try {
    const r = await db.collection("ops_admins").limit(20).get();
    return (r.data || []).map((d) => d.openid).filter(Boolean);
  } catch (e) { return []; }
}

/**
 * 发运维告警给全部管理员。
 * @param {object} db 调用方注入的数据库句柄
 * @param {object} opts { title ≤20 字, detail ≤20 字, date YYYY-MM-DD, page 落地页(可选) }
 * @returns { sent, skipped } 实发数与未授权跳过数
 */
async function sendAdminAlert(db, opts) {
  const out = { sent: 0, skipped: 0 };
  try {
    const token = await getAccessToken(db);
    const admins = await listAdmins(db);
    const date = opts.date || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    await Promise.all(admins.map(async (openid) => {
      try {
        const r = await httpPost(`/cgi-bin/message/subscribe/send?access_token=${token}`, {
          touser: openid,
          template_id: TEMPLATE_ID_BRIEF,
          page: opts.page || "pages/user-center/index",
          data: {
            thing3: { value: String(opts.title || "任务告警").slice(0, 20) },
            thing5: { value: String(opts.detail || "请查云函数日志").slice(0, 20) },
            date2: { value: date },
          },
        });
        if (r.errcode === 0) out.sent++;
        else out.skipped++; // 43101 未授权等：静默降级
      } catch (e) { out.skipped++; }
    }));
  } catch (e) {
    console.error("[admin-alert] 发送失败:", e.message);
  }
  return out;
}

module.exports = { sendAdminAlert, listAdmins, getAccessToken };
