const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { action, fundCode, fundName, fundCodes, group } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };

  const col = db.collection("watchlist");

  try {
    if (action === "add") {
      if (!fundCode || !fundName) return { code: 400, msg: "缺少基金信息" };
      if (fundCode.length !== 6 || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "基金代码格式错误" };
      if (fundName.length > 50) return { code: 400, msg: "基金名称过长" };
      const exist = await col.where({ _openid: OPENID, fundCode }).count();
      if (exist.total > 0) return { code: 0, msg: "已加自选" };
      await col.add({ data: { _openid: OPENID, fundCode, fundName, group: "", createTime: new Date() } });
      return { code: 0, msg: "加自选成功" };
    }

    if (action === "remove") {
      if (!fundCode) return { code: 400, msg: "缺少基金代码" };
      await col.where({ _openid: OPENID, fundCode }).remove();
      return { code: 0, msg: "取消自选" };
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

    if (action === "setGroup") {
      if (!fundCodes || !Array.isArray(fundCodes) || fundCodes.length === 0) return { code: 400, msg: "缺少基金代码" };
      if (typeof group !== "string") return { code: 400, msg: "缺少分组名称" };
      const name = group.trim().slice(0, 20);
      await col.where({ _openid: OPENID, fundCode: _.in(fundCodes) }).update({ data: { group: name } });
      return { code: 0, msg: "已更新分组" };
    }

    if (action === "getGroups") {
      const res = await col.where({ _openid: OPENID }).field({ group: true }).get();
      const groups = [...new Set(res.data.map(d => d.group || "").filter(g => g !== ""))].sort();
      return { code: 0, data: groups };
    }

    if (action === "renameGroup") {
      if (!group || typeof group !== "string") return { code: 400, msg: "缺少原分组名" };
      const newName = (event.newGroup || "").trim().slice(0, 20);
      if (!newName) return { code: 400, msg: "新分组名不能为空" };
      const oldName = group.trim();
      await col.where({ _openid: OPENID, group: oldName }).update({ data: { group: newName } });
      return { code: 0, msg: "已重命名" };
    }

    if (action === "deleteGroup") {
      if (!group || typeof group !== "string") return { code: 400, msg: "缺少分组名" };
      const name = group.trim();
      await col.where({ _openid: OPENID, group: name }).update({ data: { group: "" } });
      return { code: 0, msg: "已删除分组" };
    }

    return { code: 400, msg: "无效操作" };
  } catch (e) {
    return { code: 500, msg: "操作失败" };
  }
};
