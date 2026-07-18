const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, data, id, fundCodes, group, newGroup } = event;
  const { OPENID } = cloud.getWXContext();
  const uid = event.testOpenid || OPENID;
  if (!uid) return { code: 401, msg: "未登录" };

  try {
    switch (action) {
      case "add": {
        if (!data || !data.fundCode) return { code: 400, msg: "缺少参数" };
        const exist = await db.collection("holdings")
          .where({ _openid: uid, fundCode: data.fundCode }).count();
        if (exist.total > 0) return { code: 409, msg: "已存在" };
        const res = await db.collection("holdings").add({
          data: { ...data, _openid: uid, createTime: new Date() },
        });
        return { code: 0, msg: "success", id: res._id };
      }
      case "update": {
        if (!id) return { code: 400, msg: "缺少id" };
        await db.collection("holdings")
          .where({ _id: id, _openid: uid }).update({ data });
        return { code: 0, msg: "success" };
      }
      case "remove": {
        if (!id) return { code: 400, msg: "缺少id" };
        // 先查出基金代码，用于清理关联交易记录
        const h = await db.collection("holdings")
          .where({ _id: id, _openid: uid }).get();
        const fundCode = (h.data && h.data[0]) ? h.data[0].fundCode : null;
        await db.collection("holdings")
          .where({ _id: id, _openid: uid }).remove();
        if (fundCode) {
          await db.collection("transactions")
            .where({ _openid: uid, fundCode }).remove();
        }
        return { code: 0, msg: "success" };
      }
      case "get": {
        if (!id) return { code: 400, msg: "缺少id" };
        const res = await db.collection("holdings")
          .where({ _id: id, _openid: uid }).get();
        return { code: 0, data: res.data[0] || null };
      }
      case "list": {
        const res = await db.collection("holdings")
          .where({ _openid: uid }).get();
        return { code: 0, data: res.data || [] };
      }
      case "check": {
        if (!data || !data.fundCode) return { code: 400, msg: "缺少fundCode" };
        const res = await db.collection("holdings")
          .where({ _openid: uid, fundCode: data.fundCode }).get();
        return { code: 0, data: res.data[0] || null };
      }
      // ---- 分组管理 ----
      case "setGroup": {
        if (!fundCodes || !Array.isArray(fundCodes) || fundCodes.length === 0) return { code: 400, msg: "缺少基金代码" };
        if (typeof group !== "string") return { code: 400, msg: "缺少分组名称" };
        const name = group.trim().slice(0, 20);
        await db.collection("holdings")
          .where({ _openid: uid, fundCode: _.in(fundCodes) }).update({ data: { group: name } });
        return { code: 0, msg: "已更新分组" };
      }
      case "getGroups": {
        const res = await db.collection("holdings")
          .where({ _openid: uid }).field({ group: true }).get();
        const groups = [...new Set((res.data || []).map(d => d.group || "").filter(g => g !== ""))].sort();
        return { code: 0, data: groups };
      }
      case "renameGroup": {
        if (!group || typeof group !== "string") return { code: 400, msg: "缺少原分组名" };
        const newName = (newGroup || "").trim().slice(0, 20);
        if (!newName) return { code: 400, msg: "新分组名不能为空" };
        const oldName = group.trim();
        await db.collection("holdings")
          .where({ _openid: uid, group: oldName }).update({ data: { group: newName } });
        return { code: 0, msg: "已重命名" };
      }
      case "deleteGroup": {
        if (!group || typeof group !== "string") return { code: 400, msg: "缺少分组名" };
        const name = group.trim();
        await db.collection("holdings")
          .where({ _openid: uid, group: name }).update({ data: { group: "" } });
        return { code: 0, msg: "已删除分组" };
      }
      default:
        return { code: 400, msg: "未知操作" };
    }
  } catch (e) {
    console.error("manageHolding error:", e);
    return { code: 500, msg: "操作失败" };
  }
};
