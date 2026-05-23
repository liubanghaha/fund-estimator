const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, fundCode, fundName } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };

  const col = db.collection("watchlist");

  try {
    if (action === "add") {
      if (!fundCode || !fundName) return { code: 400, msg: "缺少基金信息" };
      const exist = await col.where({ _openid: OPENID, fundCode }).count();
      if (exist.total > 0) return { code: 0, msg: "已关注" };
      await col.add({ data: { _openid: OPENID, fundCode, fundName, createTime: new Date() } });
      return { code: 0, msg: "关注成功" };
    }

    if (action === "remove") {
      if (!fundCode) return { code: 400, msg: "缺少基金代码" };
      await col.where({ _openid: OPENID, fundCode }).remove();
      return { code: 0, msg: "取消关注" };
    }

    if (action === "list") {
      const res = await col.where({ _openid: OPENID }).orderBy("createTime", "desc").get();
      return { code: 0, data: res.data };
    }

    if (action === "check") {
      if (!fundCode) return { code: 400, msg: "缺少基金代码" };
      const exist = await col.where({ _openid: OPENID, fundCode }).count();
      return { code: 0, data: { followed: exist.total > 0 } };
    }

    return { code: 400, msg: "无效操作" };
  } catch (e) {
    return { code: 500, msg: "操作失败" };
  }
};
