const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 生成 6 位随机码
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉容易混淆的字符
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 根据基金代码去重
function dedupeByCode(list) {
  const seen = new Set();
  return list.filter(item => {
    if (seen.has(item.fundCode)) return false;
    seen.add(item.fundCode);
    return true;
  });
}

exports.main = async (event) => {
  const { action, code } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    // === 小程序端：导出数据，生成迁移码 ===
    if (action === "export") {
      if (!OPENID) return { code: 401, msg: "请先登录" };

      // 读取该用户的持仓、自选、交易记录
      const [holdingsRes, watchlistRes, transactionsRes] = await Promise.all([
        db.collection("holdings").where({ _openid: OPENID }).get(),
        db.collection("watchlist").where({ _openid: OPENID }).get(),
        db.collection("transactions").where({ _openid: OPENID }).get(),
      ]);

      const holdings = (holdingsRes.data || []).map(h => ({
        fundCode: h.fundCode,
        fundName: h.fundName,
        shares: h.shares,
        buyPrice: h.buyPrice,
        totalCost: h.marketValue || h.totalCost,
        group: h.group || "",
      }));

      const watchlist = dedupeByCode((watchlistRes.data || []).map(w => ({
        fundCode: w.fundCode,
        fundName: w.fundName,
        group: w.group || "",
      })));

      const transactions = (transactionsRes.data || []).map(t => ({
        fundCode: t.fundCode,
        fundName: t.fundName,
        type: t.type,
        amount: t.amount,
        price: t.price,
        shares: t.shares,
        date: t.date,
      }));

      if (holdings.length === 0 && watchlist.length === 0) {
        return { code: 404, msg: "没有可迁移的数据" };
      }

      // 生成唯一迁移码
      let transferCode;
      let attempts = 0;
      while (attempts < 10) {
        transferCode = generateCode();
        const existing = await db.collection("migration_codes")
          .where({ code: transferCode, status: "pending" }).get();
        if (!existing.data || existing.data.length === 0) break;
        attempts++;
      }

      // 保存迁移数据
      await db.collection("migration_codes").add({
        data: {
          code: transferCode,
          openid: OPENID,
          status: "pending",
          data: { holdings, watchlist, transactions },
          createTime: new Date(),
        },
      });

      return {
        code: 0,
        data: {
          code: transferCode,
          counts: {
            holdings: holdings.length,
            watchlist: watchlist.length,
            transactions: transactions.length,
          },
        },
      };
    }

    // === H5端：导入数据 ===
    if (action === "import") {
      if (!code) return { code: 400, msg: "请输入迁移码" };

      const res = await db.collection("migration_codes")
        .where({ code: code.toUpperCase().trim(), status: "pending" })
        .get();

      if (!res.data || res.data.length === 0) {
        return { code: 404, msg: "迁移码无效或已使用" };
      }

      const record = res.data[0];

      // 检查是否 10 分钟内有效
      if (Date.now() - record.createTime > 600000) {
        await db.collection("migration_codes").doc(record._id)
          .update({ data: { status: "expired" } });
        return { code: 410, msg: "迁移码已过期（10分钟有效）" };
      }

      // 标记为已使用
      await db.collection("migration_codes").doc(record._id)
        .update({ data: { status: "imported", importTime: new Date() } });

      return {
        code: 0,
        data: record.data,
        msg: "导入成功",
      };
    }

    return { code: 400, msg: "未知操作" };
  } catch (e) {
    console.error("transferData error:", e);
    return { code: 500, msg: e.message };
  }
};
