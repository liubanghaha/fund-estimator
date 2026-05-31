const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, data, id } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };

  try {
    switch (action) {
      case "add": {
        if (!data || !data.fundCode) return { code: 400, msg: "缺少参数" };
        const exist = await db.collection("holdings")
          .where({ _openid: OPENID, fundCode: data.fundCode }).count();
        if (exist.total > 0) return { code: 409, msg: "已存在" };
        const res = await db.collection("holdings").add({
          data: { ...data, _openid: OPENID, createTime: new Date() },
        });
        return { code: 0, msg: "success", id: res._id };
      }
      case "update": {
        if (!id) return { code: 400, msg: "缺少id" };
        await db.collection("holdings")
          .where({ _id: id, _openid: OPENID }).update({ data });
        return { code: 0, msg: "success" };
      }
      case "remove": {
        if (!id) return { code: 400, msg: "缺少id" };
        // 先查出基金代码，用于清理关联交易记录
        const h = await db.collection("holdings")
          .where({ _id: id, _openid: OPENID }).get();
        const fundCode = (h.data && h.data[0]) ? h.data[0].fundCode : null;
        await db.collection("holdings")
          .where({ _id: id, _openid: OPENID }).remove();
        if (fundCode) {
          await db.collection("transactions")
            .where({ _openid: OPENID, fundCode }).remove();
        }
        return { code: 0, msg: "success" };
      }
      case "get": {
        if (!id) return { code: 400, msg: "缺少id" };
        const res = await db.collection("holdings")
          .where({ _id: id, _openid: OPENID }).get();
        return { code: 0, data: res.data[0] || null };
      }
      case "list": {
        const res = await db.collection("holdings")
          .where({ _openid: OPENID }).get();
        return { code: 0, data: res.data || [] };
      }
      case "check": {
        if (!data || !data.fundCode) return { code: 400, msg: "缺少fundCode" };
        const res = await db.collection("holdings")
          .where({ _openid: OPENID, fundCode: data.fundCode }).get();
        return { code: 0, data: res.data[0] || null };
      }
      default:
        return { code: 400, msg: "未知操作" };
    }
  } catch (e) {
    console.error("manageHolding error:", e);
    return { code: 500, msg: "操作失败" };
  }
};
