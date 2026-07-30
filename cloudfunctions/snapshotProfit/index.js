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

    // 北京时间交易时段判断（云函数服务器使用 UTC）
    const now = new Date();
    const bjHours = (now.getUTCHours() + 8) % 24;
    const bjDay = (now.getUTCDay() + (now.getUTCHours() + 8 >= 24 ? 1 : 0)) % 7;
    const totalMin = bjHours * 60 + now.getUTCMinutes();
    const inTrading = bjDay >= 1 && bjDay <= 5 && ((totalMin >= 570 && totalMin < 690) || (totalMin >= 780 && totalMin <= 900));
    if (!inTrading) return { code: 0, msg: "非交易时段跳过" };
    if (totalMin > 690 && totalMin < 780) return { code: 0, msg: "午休跳过" }; // 11:30~13:00
    const today = formatDate(now);
    const time = `${String(bjHours).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    for (const [openid, userHoldings] of Object.entries(userMap)) {
      const codes = userHoldings.map(h => h.fundCode);
      const tiantianMap = await batchFetchTiantian(codes);

      let totalWeightedRate = 0, totalBase = 0;
      for (const h of userHoldings) {
        const t = tiantianMap[h.fundCode] || {};
        const shares = h.shares || h.amount || 0;
        const yesterdayNav = t.nav || h.nav || 0;
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

// ---- 自主计算估值（取代已下线的天天基金 API） ----

async function batchFetchTiantian(codes) {
  const map = {};
  if (!codes || codes.length === 0) return map;

  try {
    // 1. 并发拉取持仓
    const fundHoldingsMap = {};
    const CONCURRENT = 10;
    for (let i = 0; i < codes.length; i += CONCURRENT) {
      const batch = codes.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const holdings = await fetchTempHoldings(code);
          return { code, holdings, ok: holdings && holdings.length > 0 };
        } catch (e) { return { code, holdings: [], ok: false }; }
      }));
      results.forEach(r => { if (r.ok) fundHoldingsMap[r.code] = r.holdings; });
      if (i + CONCURRENT < codes.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 2. 收集所有股票代码 & 批量查腾讯行情
    const stockSet = new Set();
    for (const holdings of Object.values(fundHoldingsMap)) {
      holdings.forEach(h => { if (h.stockCode) stockSet.add(h.stockCode); });
    }
    const stockPriceMap = [...stockSet].length > 0 ? await fetchStockPricesTencent([...stockSet]) : {};

    // 3. 逐基金计算加权涨跌
    const timeStr = `${String(new Date().getUTCHours() + 8).padStart(2, '0')}:${String(new Date().getUTCMinutes()).padStart(2, '0')}`;
    for (const code of codes) {
      const holdings = fundHoldingsMap[code];
      if (!holdings || holdings.length === 0) continue;
      let totalRatio = 0, weightedChange = 0;
      for (const h of holdings) {
        const price = stockPriceMap[h.stockCode];
        if (!price || price.changeRate == null) continue;
        totalRatio += h.navRatio;
        weightedChange += price.changeRate * h.navRatio;
      }
      if (totalRatio > 0) {
        map[code] = {
          fundCode: code,
          fundName: "",
          nav: null,
          estimatedChangeRate: +(weightedChange / totalRatio).toFixed(2),
          estimateTime: timeStr,
        };
      }
    }
  } catch (e) {
    console.error("snapshotProfit自主估算失败:", e.message);
  }

  return map;
}

// 腾讯全球行情
function fetchStockPricesTencent(codes) {
  const http = require("http");
  const map = {};
  const BATCH = 50;

  const toQtCode = (code) => {
    const c = String(code).trim().toUpperCase();
    if (c.length === 5) return `hk${c}`;
    if (c.length <= 5 && /^[A-Z]/.test(c)) return `us${c}`;
    if (c.startsWith("6") || c.startsWith("5") || c.startsWith("688")) return `sh${c}`;
    return `sz${c}`;
  };

  const fetchBatch = (batchCodes) => new Promise((resolve) => {
    const qtCodes = batchCodes.map(toQtCode).join(",");
    const req = http.get(`http://qt.gtimg.cn/q=${qtCodes}`, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          for (const code of batchCodes) {
            const qtCode = toQtCode(code);
            const re = new RegExp(`v_${qtCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`);
            const match = body.match(re);
            if (!match) continue;
            const fields = match[1].split("~");
            if (fields.length < 5) continue;
            const curr = parseFloat(fields[3]);
            const prev = parseFloat(fields[4]);
            if (!isNaN(prev) && !isNaN(curr) && prev > 0) {
              map[code] = { changeRate: +(((curr - prev) / prev) * 100).toFixed(2) };
            }
          }
        } catch (e) { /* ignore */ }
        resolve();
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });

  return (async () => {
    for (let i = 0; i < codes.length; i += BATCH) {
      await fetchBatch(codes.slice(i, i + BATCH));
    }
    return map;
  })();
}

// 基金持仓抓取（复用 getPortfolio 逻辑）
function fetchTempHoldings(fundCode) {
  const https = require("https");
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3, curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
    if (i === 0) { curY = year - 1; curM = 12; }
  }

  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=100&year=${curY}&month=${curM}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const html = match[1].replace(/\\"/g, '"');
          const rows = [];
          const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
          let trMatch;
          while ((trMatch = trRegex.exec(html)) !== null) {
            const tds = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
              tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            if (tds.length >= 7 && !tds[0].includes("*")) {
              const n = tds.length;
              const ratio = parseFloat(tds[n - 3]) || 0;
              if (ratio > 0) {
                rows.push({
                  stockCode: tds[1],
                  stockName: tds[2],
                  navRatio: ratio,
                });
              }
            }
          }
          resolve(rows);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
