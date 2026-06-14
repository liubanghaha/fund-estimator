const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  try {
    const res = await db.collection("holdings").get();
    const holdings = res.data || [];
    if (holdings.length === 0) return { code: 0, msg: "无持仓" };

    // 按用户分组
    const userMap = {};
    holdings.forEach(h => {
      if (!userMap[h._openid]) userMap[h._openid] = [];
      userMap[h._openid].push(h);
    });

    const now = new Date();
    const totalMin = now.getHours() * 60 + now.getMinutes();
    if (totalMin > 690 && totalMin < 780) return { code: 0, msg: "午休跳过" }; // 11:30~13:00
    const today = formatDate(now);
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const [openid, userHoldings] of Object.entries(userMap)) {
      const codes = userHoldings.map(h => h.fundCode);
      const tiantianMap = await batchFetchTiantian(codes);

      let totalWeightedRate = 0, totalBase = 0;
      for (const h of userHoldings) {
        const t = tiantianMap[h.fundCode] || {};
        const shares = h.shares || h.amount || 0;
        const yesterdayNav = t.nav || h.buyPrice || h.nav || 0;
        const rate = t.estimatedChangeRate || 0;
        const weight = shares * yesterdayNav;
        if (weight > 0) {
          totalWeightedRate += rate * weight;
          totalBase += weight;
        }
      }
      const rate = totalBase > 0 ? +((totalWeightedRate / totalBase)).toFixed(2) : 0;

      // 去重：不写同分钟已有数据
      const exist = await db.collection("profit_snapshots")
        .where({ _openid: openid, date: today, "points.time": time }).count();
      if (exist.total > 0) continue;

      // upsert
      const doc = await db.collection("profit_snapshots")
        .where({ _openid: openid, date: today }).get();
      if (doc.data && doc.data.length > 0) {
        await db.collection("profit_snapshots").doc(doc.data[0]._id).update({
          data: { points: db.command.push({ time, rate }) }
        });
      } else {
        await db.collection("profit_snapshots").add({
          data: { _openid: openid, date: today, points: [{ time, rate }] }
        });
      }
    }

    return { code: 0, msg: "ok", time };
  } catch (e) {
    console.error("snapshotProfit 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

// ---- 复用 getPortfolio 的基金估值逻辑 ----

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function batchFetchTiantian(codes) {
  const https = require("https");
  const map = {};
  if (!codes || codes.length === 0) return map;

  const batchCode = codes.join(",");
  const batchResult = await new Promise((resolve) => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${batchCode}.js`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const clean = body.replace(/^jsonpgzs\(/, "").replace(/\)\;?$/, "").trim();
          const obj = JSON.parse(clean);
          resolve(typeof obj === "object" && !Array.isArray(obj) ? obj : {});
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });

  for (const [code, data] of Object.entries(batchResult)) {
    if (data && typeof data === "object") {
      map[code] = {
        fundCode: data.fundcode || code,
        fundName: data.name || "",
        nav: parseFloat(data.dwjz) || null,
        estimatedNav: parseFloat(data.gsz) || null,
        estimatedChangeRate: parseFloat(data.gszzl) || null,
        estimateTime: data.gztime || "",
      };
    }
  }

  const missing = codes.filter((c) => !map[c]);
  if (missing.length > 0) {
    const fallbacks = await Promise.all(missing.map((c) => fetchTiantian(c)));
    missing.forEach((c, i) => { map[c] = fallbacks[i]; });
  }
  return map;
}

function fetchTiantian(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, ""));
          resolve({
            fundCode: json.fundcode,
            fundName: json.name,
            nav: parseFloat(json.dwjz) || null,
            estimatedNav: parseFloat(json.gsz) || null,
            estimatedChangeRate: parseFloat(json.gszzl) || null,
            estimateTime: json.gztime || "",
          });
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}
