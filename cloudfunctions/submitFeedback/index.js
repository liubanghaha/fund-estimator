const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { content } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };
  if (!content || !content.trim()) return { code: 400, msg: "请输入反馈内容" };
  if (content.length > 500) return { code: 400, msg: "反馈内容不能超过500字" };

  try {
    await db.collection("feedback").add({
      data: {
        _openid: OPENID,
        content: content.trim(),
        createTime: new Date(),
      },
    });
    return { code: 0, msg: "感谢反馈" };
  } catch (e) {
    console.error("提交反馈失败:", e);
    return { code: 500, msg: "提交失败，请重试" };
  }
};
