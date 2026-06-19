const cloud = require("wx-server-sdk");
cloud.init({ env: "cloudbase-d0gug00io7bfedd97" });
const db = cloud.database();

// ======== Server酱 推送配置 ========
// 1. 打开 https://sct.ftqq.com/ 用微信扫码登录
// 2. 复制 SendKey 填入 cloudfunctions/submitFeedback/env.json
// 3. 关注「方糖」公众号即可收到微信推送
// （env.json 已在 .gitignore，不会提交到仓库）
// ==================================
let SERVER_CHAN_KEY = process.env.SERVER_CHAN_KEY || "";
try {
  const env = require("./env.json");
  SERVER_CHAN_KEY = env.SERVER_CHAN_KEY || SERVER_CHAN_KEY;
} catch (e) { /* env.json 不存在则使用环境变量 */ }

const TYPE_LABELS = { suggestion: "💡 功能建议", bug: "🐛 问题反馈", other: "💬 其他" };

exports.main = async (event) => {
  const { content, type, contact, images } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };
  if (!content || !content.trim()) return { code: 400, msg: "请输入反馈内容" };
  if (content.length > 500) return { code: 400, msg: "反馈内容不能超过500字" };

  const validTypes = ["suggestion", "bug", "other"];
  const feedbackType = validTypes.includes(type) ? type : "other";
  const trimmedContact = (contact || "").trim().slice(0, 50);
  const imageList = Array.isArray(images) ? images.slice(0, 3) : [];

  try {
    await db.collection("feedback").add({
      data: {
        _openid: OPENID,
        type: feedbackType,
        content: content.trim(),
        contact: trimmedContact,
        images: imageList,
        createTime: new Date(),
      },
    });
  } catch (e) {
    console.error("提交反馈失败:", e);
    if (e.errCode === -502005) {
      try {
        await db.createCollection("feedback");
        await db.collection("feedback").add({
          data: {
            _openid: OPENID,
            type: feedbackType,
            content: content.trim(),
            contact: trimmedContact,
            images: imageList,
            createTime: new Date(),
          },
        });
      } catch (e2) {
        console.error("自动创建feedback集合后重试仍失败:", e2);
        return { code: 500, msg: "提交失败，请重试" };
      }
    } else {
      return { code: 500, msg: "提交失败，请重试" };
    }
  }

  // 推送通知到管理员微信
  if (SERVER_CHAN_KEY) {
    sendNotification(feedbackType, content.trim(), trimmedContact, imageList.length).catch(err => {
      console.error("推送通知失败:", err.message || err);
    });
  }

  return { code: 0, msg: "感谢反馈" };
};

/**
 * 通过 Server酱 推送反馈通知到管理员微信
 */
function sendNotification(type, content, contact, imageCount) {
  const https = require("https");
  const label = TYPE_LABELS[type] || type;
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const body = new URLSearchParams({
    title: `涨跌有数 · 新反馈`,
    desp: [
      `**类型：** ${label}`,
      `**时间：** ${timeStr}`,
      `**内容：** ${content}`,
      contact ? `**联系方式：** ${contact}` : "",
      imageCount > 0 ? `**截图：** ${imageCount} 张` : "",
      "",
      `> 打开云开发控制台 → feedback 集合查看详情`,
    ].filter(Boolean).join("\n\n"),
  }).toString();

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "sctapi.ftqq.com",
      path: `/${SERVER_CHAN_KEY}.send`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.code === 0) {
            console.log("推送通知成功");
          } else {
            console.error("推送通知失败:", result.message || data);
          }
        } catch (e) {
          console.error("推送通知响应解析失败:", data);
        }
        resolve();
      });
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.on("error", (e) => { console.error("推送通知请求失败:", e.message); resolve(); });
    req.write(body);
    req.end();
  });
}
