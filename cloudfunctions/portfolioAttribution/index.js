const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 今日归因（R7）：我的持仓为什么涨/跌。
 * 口径：基金当日涨跌 × 仓位权重 求和（粗粒度，不拆个股——数据精度撑不住）。
 * 涨跌取最新可用值：净值已公布用官方涨跌，否则用盘中估算（卡片由客户端按时段门控展示）。
 * 单只基金行情失败跳过该基金继续算；预算 40s，超预算只返回已算部分。
 * 非交易日客户端不展示该卡片（无当日涨跌就没有归因）。
 * 只讲已发生的事实，无前瞻无建议（合规红线 #2）。
 */
const CONCURRENT = 10;
const BUDGET = 40000;

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };
  const started = Date.now();
  try {
    const res = await db.collection("holdings")
      .where({ _openid: OPENID })
      .field({ fundCode: true, fundName: true, marketValue: true })
      .limit(1000).get();
    const byCode = {};
    (res.data || []).forEach(h => {
      if (!h.fundCode || !(h.marketValue > 0)) return;
      const c = byCode[h.fundCode] || (byCode[h.fundCode] = { fundCode: h.fundCode, fundName: h.fundName || h.fundCode, mv: 0 });
      c.mv += h.marketValue || 0;
      if (!c.fundName && h.fundName) c.fundName = h.fundName;
    });
    const funds = Object.values(byCode);
    if (funds.length === 0) return { code: 0, data: { ok: false, reason: "无持仓" } };
    const totalMv = funds.reduce((s, f) => s + f.mv, 0);
    if (!(totalMv > 0)) return { code: 0, data: { ok: false, reason: "市值为 0" } };

    const items = [];
    for (let i = 0; i < funds.length; i += CONCURRENT) {
      if (i > 0 && Date.now() - started >= BUDGET) break; // 超预算只返回已算部分
      const batch = funds.slice(i, i + CONCURRENT);
      const rates = await Promise.all(batch.map(f =>
        fd.fetchLatestNavEastMoney(f.fundCode).then(r => {
          if (!r) return null;
          if (r.actualChangeRate != null) return { cr: r.actualChangeRate, confirmed: true };
          if (r.estimatedChangeRate != null) return { cr: r.estimatedChangeRate, confirmed: false };
          return null;
        }).catch(() => null)
      ));
      batch.forEach((f, j) => {
        const rate = rates[j];
        if (!rate) return;
        const weight = +(f.mv / totalMv * 100).toFixed(1);
        items.push({
          fundCode: f.fundCode, fundName: f.fundName,
          changeRate: rate.cr, confirmed: rate.confirmed,
          weight, contribution: +(rate.cr * weight / 100).toFixed(3),
        });
      });
    }
    if (!items.length) return { code: 0, data: { ok: false, reason: "涨跌数据不可用" } };
    items.sort((a, b) => a.contribution - b.contribution);
    return { code: 0, data: {
      ok: true,
      total: +items.reduce((s, i) => s + i.contribution, 0).toFixed(2),
      drag: items[0].contribution < 0 ? items[0] : null,
      pull: items[items.length - 1].contribution > 0 ? items[items.length - 1] : null,
      items: items.slice(0, 5),
    } };
  } catch (e) {
    console.error("[portfolioAttribution] 失败:", e.message);
    return { code: 500, msg: "归因计算失败" };
  }
};
