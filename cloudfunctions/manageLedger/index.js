const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 通用记账记录（与基金持仓 holdings 完全隔离，个人主体合规）
// 字段：{ _openid, amount, note, date, group, createTime }
exports.main = async (event) => {
  const { action, id, data, ids, group } = event;
  const { OPENID } = cloud.getWXContext();
  const uid = event.testOpenid || OPENID;
  if (!uid) return { code: 401, msg: "请先登录" };
  const col = db.collection("ledger_records");

  try {
    switch (action) {
      case "add": {
        if (!data) return { code: 400, msg: "缺少参数" };
        const amount = parseFloat(data.amount);
        if (!amount || amount <= 0) return { code: 400, msg: "请输入有效金额" };
        const res = await col.add({
          data: {
            _openid: uid,
            amount: +amount.toFixed(2),
            note: (data.note || "").trim().slice(0, 50),
            date: data.date || "",
            group: (data.group || "").trim(),
            createTime: Date.now(),
          },
        });
        return { code: 0, msg: "success", id: res._id };
      }
      case "update": {
        if (!id) return { code: 400, msg: "缺少id" };
        const patch = {};
        if (data.amount !== undefined) {
          const amount = parseFloat(data.amount);
          if (!amount || amount <= 0) return { code: 400, msg: "请输入有效金额" };
          patch.amount = +amount.toFixed(2);
        }
        if (data.note !== undefined) patch.note = (data.note || "").trim().slice(0, 50);
        if (data.date !== undefined) patch.date = data.date || "";
        if (data.group !== undefined) patch.group = (data.group || "").trim();
        await col.doc(id).update({ data: patch });
        return { code: 0, msg: "success" };
      }
      case "remove": {
        if (!id) return { code: 400, msg: "缺少id" };
        await col.doc(id).remove();
        return { code: 0, msg: "success" };
      }
      case "get": {
        if (!id) return { code: 400, msg: "缺少id" };
        const res = await col.doc(id).get();
        return { code: 0, data: res.data || null };
      }
      case "list": {
        const res = await col.where({ _openid: uid }).orderBy("createTime", "desc").limit(500).get();
        return { code: 0, data: res.data || [] };
      }
      case "setGroup": {
        if (!ids || !Array.isArray(ids) || ids.length === 0) return { code: 400, msg: "缺少记录" };
        if (typeof group !== "string") return { code: 400, msg: "缺少分组名称" };
        const name = group === "ungrouped" ? "" : group;
        await col.where({ _openid: uid, _id: _.in(ids) }).update({ data: { group: name } });
        return { code: 0, msg: "已更新分组" };
      }
      default:
        return { code: 400, msg: "未知操作" };
    }
  } catch (e) {
    console.error("manageLedger 失败:", e.message || e);
    return { code: 500, msg: e.message || "操作失败" };
  }
};
