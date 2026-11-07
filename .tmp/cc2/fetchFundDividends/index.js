const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 基金分红记录（2026-11-06 全球调研 Top1：分红日历+收入演算）
 *
 * 数据源：东财移动接口 FundBonusList（白名单 fundmobapi，实测 000001 返回完整历史：
 * FSRQ=分红发放日 / FHFCZ=每份分红金额）。国内公募分红不定期（多数年度 1~2 次或常年不分），
 * "未来到账日历"对稀疏分红没有预测意义 → 本函数只做两件诚实的事：
 *   1) 历史分红记录（近 50 次）+ 按年累计
 *   2) 近 12 个月每份分红合计（last12mPerShare）——客户端据此 × 持有份额演算年收入，
 *      措辞固定"按近一年分红节奏演算，非承诺"
 * 缓存：fund_dividend_cache（_id=fundCode，TTL 7 天——分红是低频事件，足够新鲜）
 */

const CACHE_TTL = 7 * 86400000;

exports.main = async (event) => {
  const ev = event || {};

  // 每日预热（05:15）：全库持仓基金去重 → 未命中 7 天缓存的拉分红记录回填。
  // 让 getPortfolio 的分红科目对全部用户尽早生效（详情页浏览只按需填充，冷启动低估）
  if (ev.warmup) {
    const { OPENID: ctxOpenid } = cloud.getWXContext();
    if (ctxOpenid) return { code: -1, msg: "拒绝客户端调用" };
    try {
      const codes = new Set();
      for (let skip = 0; skip < 20000; skip += 1000) {
        const r = await db.collection("holdings").field({ fundCode: true }).skip(skip).limit(1000).get();
        (r.data || []).forEach((h) => { if (h.fundCode) codes.add(h.fundCode); });
        if ((r.data || []).length < 1000) break;
      }
      const all = [...codes];
      let fresh = 0, fetched = 0, fail = 0;
      // 先查缓存命中（收集后统一过滤，避免边遍历边 splice 漏删）
      const freshSet = new Set();
      for (let i = 0; i < all.length; i += 100) {
        const r = await db.collection("fund_dividend_cache")
          .where({ fundCode: db.command.in(all.slice(i, i + 100)) })
          .field({ fundCode: true, fetchedAt: true }).get();
        (r.data || []).forEach((d) => { if (d.fetchedAt) freshSet.add(d.fundCode); });
      }
      const pending = all.filter((c) => !freshSet.has(c));
      fresh = freshSet.size;
      console.log(`[fetchFundDividends] 预热: 总 ${codes.size} 缓存命中 ${fresh} 待拉 ${pending.length}`);
      for (let i = 0; i < pending.length; i += 5) {
        await Promise.all(pending.slice(i, i + 5).map(async (code) => {
          try {
            const r = await exports.main({ fundCode: code });
            if (r && r.code === 0) fetched++; else fail++;
          } catch (e) { fail++; }
        }));
      }
      return { code: 0, total: codes.size, fresh, fetched, fail };
    } catch (e) {
      console.error("[fetchFundDividends] 预热失败:", e.message);
      return { code: 500, msg: e.message };
    }
  }

  const { OPENID } = cloud.getWXContext();

  // 组合级分红演算： holdings 全量 → 各基金近 12 个月每份分红 × 份额。
  // 一次调用代替客户端 N 次（分红缓存 7 天，命中时接近零外部请求）
  if (ev.action === "portfolio") {
    if (!OPENID) return { code: 401, msg: "未登录" };
    try {
      const holds = await db.collection("holdings").where({ _openid: OPENID })
        .field({ fundCode: true, fundName: true, shares: true, amount: true }).limit(100).get();
      const rows = (holds.data || []).map((h) => ({
        fundCode: h.fundCode, fundName: h.fundName || h.fundCode,
        shares: parseFloat(h.shares || h.amount) || 0,
      })).filter((h) => h.fundCode && h.shares > 0);
      if (rows.length === 0) return { code: 0, data: { items: [], total: 0, hasData: false } };

      const byFund = {};
      for (let i = 0; i < rows.length; i += 10) {
        await Promise.all(rows.slice(i, i + 10).map(async (h) => {
          try {
            const r = await exports.main({ fundCode: h.fundCode });
            if (r && r.code === 0 && r.data) byFund[h.fundCode] = r.data;
          } catch (e) { /* 单基金失败留空 */ }
        }));
      }
      let total = 0, hasData = false;
      const items = rows.map((h) => {
        const d = byFund[h.fundCode];
        const perShare = d ? d.last12mPerShare : 0;
        const amount = +(perShare * h.shares).toFixed(2);
        if (perShare > 0) hasData = true;
        total += amount;
        return {
          fundCode: h.fundCode, fundName: h.fundName,
          shares: h.shares, last12mPerShare: perShare, annualAmount: amount,
          lastDate: d ? d.lastDate : "", count: d ? d.count : 0,
        };
      }).sort((a, b) => b.annualAmount - a.annualAmount);
      return { code: 0, data: { items, total: +total.toFixed(2), hasData } };
    } catch (e) {
      console.error("[fetchFundDividends] portfolio 失败:", e.message);
      return { code: 500, msg: e.message };
    }
  }

  const { fundCode } = ev;
  if (!fundCode || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "缺少基金代码" };

  try {
    try { await db.createCollection("fund_dividend_cache"); } catch (e) { /* 已存在 */ }
    try {
      const c = await db.collection("fund_dividend_cache").doc(fundCode).get();
      const doc = c.data;
      if (doc && doc.fetchedAt && Date.now() - doc.fetchedAt < CACHE_TTL && Array.isArray(doc.list)) {
        return { code: 0, data: doc.data, fromCache: true };
      }
    } catch (e) { /* 无缓存 → 现拉 */ }

    const https = require("https");
    const url = `https://fundmobapi.eastmoney.com/FundMApi/FundBonusList.ashx?FCODE=${fundCode}&pageIndex=1&pageSize=50&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8`;
    const body = await new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" }, timeout: 8000 }, (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; });
        res.on("end", () => resolve(buf));
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("超时")); });
      req.on("error", reject);
    });
    const j = JSON.parse(body);
    const raw = (j && j.Datas) || [];
    const list = raw
      .map((r) => ({ date: r.FSRQ || "", perShare: parseFloat(r.FHFCZ) || 0 }))
      .filter((r) => r.date && r.perShare > 0)
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // 最新在前

    // 按年累计 + 近 12 个月每份分红合计
    const yearMap = {};
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    let last12mPerShare = 0;
    list.forEach((r) => {
      const y = r.date.slice(0, 4);
      yearMap[y] = +((yearMap[y] || 0) + r.perShare).toFixed(4);
      if (r.date >= cutoff) last12mPerShare = +(last12mPerShare + r.perShare).toFixed(4);
    });
    const annual = Object.keys(yearMap).sort((a, b) => (a < b ? 1 : -1))
      .map((y) => ({ year: y, totalPerShare: yearMap[y] }));

    const data = {
      fundCode,
      list: list.slice(0, 30),
      annual,
      last12mPerShare,
      count: list.length,
      lastDate: list.length ? list[0].date : "",
      fetchedAt: Date.now(),
    };
    await db.collection("fund_dividend_cache").doc(fundCode)
      .set({ data: { fundCode, fetchedAt: data.fetchedAt, data } }).catch(() => {});
    return { code: 0, data };
  } catch (e) {
    console.error("[fetchFundDividends] 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};
