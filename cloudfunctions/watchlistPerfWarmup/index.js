const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 自选区间收益预热（每日 05:30，定时触发）
 *
 * 把 fund_perf_cache 的当日份额提前算好，用户当天首次打开自选页
 * 不再等 manageWatchlist perf 现场拉全量净值（那条路有 50s 预算，首开慢且可能出 "--"）。
 *
 * 池 = 小程序侧全部自选基金（排除 h5_ 遗留账号的行）。
 * 负缓存同样写入：无趋势文件（968/货币等）当日不再重试，perf 端点直接出 "--"。
 *
 * ⚠️ 区间算法与 manageWatchlist perf 同源（fetchNetWorthTrend / intervalPct），
 * 两处改动需同步。
 */
const DAY = 86400000;

exports.main = async () => {
  const started = Date.now();
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  try {
    try { await db.createCollection("fund_perf_cache"); } catch (e) { /* 已存在 */ }

    // 池：小程序侧全部自选基金
    const codes = new Set();
    let lastId = "";
    for (;;) {
      const q = db.collection("watchlist").field({ _openid: true, fundCode: true }).limit(1000);
      const res = lastId ? await q.where({ _id: _.gt(lastId) }).get() : await q.get();
      if (!res.data || res.data.length === 0) break;
      res.data.forEach(r => {
        if (String(r._openid || "").startsWith("h5_")) return;
        if (r.fundCode && /^\d{6}$/.test(r.fundCode)) codes.add(r.fundCode);
      });
      if (res.data.length < 1000) break;
      lastId = res.data[res.data.length - 1]._id;
    }
    const pool = [...codes];

    // 当日已缓存的跳过
    const cachedSet = new Set();
    for (let i = 0; i < pool.length; i += 100) {
      const res = await db.collection("fund_perf_cache")
        .where({ fundCode: _.in(pool.slice(i, i + 100)), date: today })
        .field({ fundCode: true })
        .get();
      (res.data || []).forEach(c => cachedSet.add(c.fundCode));
    }
    const missing = pool.filter(c => !cachedSet.has(c));
    console.log(`[watchlistPerfWarmup] ${today} 池 ${pool.length} 只，待预热 ${missing.length} 只`);

    const CONCURRENT = 10;
    const BUDGET = 100000;
    let ok = 0, dead = 0, fail = 0;
    for (let i = 0; i < missing.length; i += CONCURRENT) {
      if (i > 0 && Date.now() - started >= BUDGET) {
        console.log(`[watchlistPerfWarmup] 达预算，剩余 ${missing.length - i} 只未预热`);
        break;
      }
      const batch = missing.slice(i, i + CONCURRENT);
      const trends = await Promise.all(batch.map(fetchNetWorthTrend));
      await Promise.all(batch.map(async (code, j) => {
        const trend = trends[j];
        let doc;
        if (trend && trend.length >= 2) {
          const end = trend[trend.length - 1];
          doc = {
            fundCode: code,
            date: today,
            lastNav: end[1],
            w1: intervalPct(trend, end[0] - 7 * DAY),
            m1: intervalPct(trend, end[0] - 30 * DAY),
            m3: intervalPct(trend, end[0] - 91 * DAY),
            m6: intervalPct(trend, end[0] - 183 * DAY),
            y3: intervalPct(trend, end[0] - 3 * 365 * DAY),
            y5: intervalPct(trend, end[0] - 5 * 365 * DAY),
            incept: +(((end[1] / trend[0][1]) - 1) * 100).toFixed(2),
          };
          ok++;
        } else {
          doc = { fundCode: code, date: today, lastNav: 0, w1: null, m1: null, m3: null, m6: null, y3: null, y5: null, incept: null };
          dead++;
        }
        try {
          await db.collection("fund_perf_cache").doc(code).set({ data: doc });
        } catch (e) { fail++; }
      }));
      if (i + CONCURRENT < missing.length) await new Promise(r => setTimeout(r, 100));
    }
    // 详情页档案预热（2026-10-18 扩展）：调 fetchFundProfile 触发其自带拉取+14 天缓存回写。
    // 复用零拷贝——不复制任何算法；稳态每天仅约 1/14 池到期需要拉
    let pok = 0, pskip = 0, pfail = 0;
    try {
      try { await db.createCollection("fund_profile_cache"); } catch (e) { /* 已存在 */ }
      const pending = [];
      for (let i = 0; i < pool.length; i += 100) {
        const res = await db.collection("fund_profile_cache")
          .where({ fundCode: _.in(pool.slice(i, i + 100)) })
          .field({ fundCode: true, fetchedDate: true })
          .get();
        const fresh = new Set((res.data || []).filter(c => c.fetchedDate && Date.now() - Date.parse(c.fetchedDate + "T00:00:00+08:00") < 14 * DAY).map(c => c.fundCode));
        pool.slice(i, i + 100).forEach(c => { if (!fresh.has(c)) pending.push(c); });
      }
      console.log(`[watchlistPerfWarmup] profile 待预热 ${pending.length} 只`);
      const P_CONCURRENT = 5, P_BUDGET = 40000, pStarted = Date.now();
      for (let i = 0; i < pending.length; i += P_CONCURRENT) {
        if (i > 0 && Date.now() - pStarted >= P_BUDGET) {
          console.log(`[watchlistPerfWarmup] profile 达预算，剩余 ${pending.length - i} 只未预热（次日继续）`);
          break;
        }
        const batch = pending.slice(i, i + P_CONCURRENT);
        const results = await Promise.all(batch.map(code =>
          cloud.callFunction({ name: "fetchFundProfile", data: { fundCode: code } })
            .then(r => (r.result && r.result.code === 0 && !(r.result.data && r.result.data.fromCache)) ? "ok" : "skip")
            .catch(() => "fail")
        ));
        pok += results.filter(x => x === "ok").length;
        pskip += results.filter(x => x === "skip").length;
        pfail += results.filter(x => x === "fail").length;
        if (i + P_CONCURRENT < pending.length) await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) { console.error("[watchlistPerfWarmup] profile 预热异常:", e.message); }

    console.log(`[watchlistPerfWarmup] 完成 ${today}: 成功 ${ok} 无趋势 ${dead} 失败 ${fail}；profile 预热 ${pok} 跳过 ${pskip} 失败 ${pfail}`);
    return { code: 0, data: { date: today, pool: pool.length, missing: missing.length, ok, dead, fail } };
  } catch (e) {
    console.error("[watchlistPerfWarmup] 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// ---- 与 manageWatchlist perf 同源（两处需同步） ----

// pingzhongdata 一次返回成立以来的日频单位净值序列。
// 域名用 fund.eastmoney.com（f10.eastmoney.com 对非浏览器 UA 返回 403，2026-10-17 实测）。
function fetchNetWorthTrend(code) {
  return new Promise((resolve) => {
    const req = https.get(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      headers: { Referer: "https://fund.eastmoney.com/" },
    }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const m = body.match(/Data_netWorthTrend\s*=\s*(\[.*?\]);/s);
          if (!m) return resolve(null);
          const arr = JSON.parse(m[1]);
          resolve((arr || [])
            .map(p => [p.x, p.y])
            .filter(p => p[0] > 0 && p[1] > 0)
            .sort((a, b) => a[0] - b[0]));
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// 区间涨幅：起点 = 不晚于 startTs 的最后一个净值点；早于成立 → null
function intervalPct(trend, startTs) {
  if (!trend || trend.length < 2 || startTs <= trend[0][0]) return null;
  let start = trend[0];
  for (const p of trend) { if (p[0] <= startTs) start = p; else break; }
  const end = trend[trend.length - 1];
  return +(((end[1] / start[1]) - 1) * 100).toFixed(2);
}
