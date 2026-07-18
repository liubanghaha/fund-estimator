const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { action, bindCode, h5Uid } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    if (action === "generate") {
      // H5 端请求生成绑定码
      if (!h5Uid) return { code: 400, msg: "缺少用户标识" };
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      await db.collection("h5_bindings").add({
        data: { bindCode: code, h5Uid, status: "pending", createTime: new Date() }
      });
      return { code: 0, data: { bindCode: code } };
    }

    if (action === "bind") {
      // 小程序端输入绑定码完成绑定
      if (!bindCode || !OPENID) return { code: 400, msg: "缺少参数" };
      const res = await db.collection("h5_bindings")
        .where({ bindCode: bindCode.toUpperCase(), status: "pending" }).get();
      if (!res.data || res.data.length === 0) return { code: 404, msg: "绑定码无效或已过期" };

      const record = res.data[0];
      // 检查是否 10 分钟内有效
      if (Date.now() - record.createTime > 600000) {
        await db.collection("h5_bindings").doc(record._id).update({ data: { status: "expired" } });
        return { code: 410, msg: "绑定码已过期（10分钟有效）" };
      }

      await db.collection("h5_bindings").doc(record._id).update({
        data: { status: "bound", openid: OPENID }
      });
      return { code: 0, msg: "绑定成功", data: { h5Uid: record.h5Uid } };
    }

    if (action === "check") {
      // H5 端轮询检查绑定状态
      if (!h5Uid) return { code: 400, msg: "缺少用户标识" };
      const res = await db.collection("h5_bindings")
        .where({ h5Uid, status: "bound" }).orderBy("createTime", "desc").limit(1).get();
      if (res.data && res.data.length > 0) {
        return { code: 0, data: { bound: true, openid: res.data[0].openid } };
      }
      return { code: 0, data: { bound: false } };
    }

    return { code: 400, msg: "未知操作" };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
};
