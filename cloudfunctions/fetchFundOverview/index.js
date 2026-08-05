const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "请提供有效的6位基金代码" };

  try {
    const [estimate, history, profileData, peTemp] = await Promise.all([
      fetchEstimate(fundCode),
      fetchHistory(fundCode, 260),
      fetchProfileData(fundCode),
      fetchPeTemp(fundCode),
    ]);
    return {
      code: 0, msg: "success",
      data: {
        ...estimate,
        fundName: (profileData.profile && profileData.profile.fundName) || "",
        history,
        profile: profileData.profile,
        manager: profileData.manager,
        peTemp,
      },
    };
  } catch (e) {
    console.error("获取基金概览失败:", e.message);
    return { code: 500, msg: "获取基金概览失败" };
  }
};

async function fetchEstimate(fundCode) {
  const https = require("https");

  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`,
      headers: { "Referer": "https://fundf10.eastmoney.com/" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
          const list = (json.Data && json.Data.LSJZList) || [];
          const today = list[0] || {};
          const yesterday = list[1] || {};
          resolve({
            actualNav: parseFloat(today.DWJZ) || null,
            actualDate: today.FSRQ || "",
            actualChangeRate: parseFloat(today.JZZZL) || null,
            yesterdayNav: parseFloat(yesterday.DWJZ) || null,
          });
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });

  // 2. 自主估算：持仓股涨跌加权
  const now = new Date();
  const bjDay = (now.getUTCDay() + (now.getUTCHours() + 8 >= 24 ? 1 : 0)) % 7;
  let selfEstimate = null;
  if (bjDay >= 1 && bjDay <= 5) {
    try {
      const holdings = await fetchTempHoldings(fundCode);
      if (holdings && holdings.length > 0) {
        const stockCodes = [...new Set(holdings.map(h => h.stockCode).filter(Boolean))];
        const prices = stockCodes.length > 0 ? await fetchStockPricesTencent(stockCodes) : {};
        let totalRatio = 0, weightedChange = 0;
        for (const h of holdings) {
          const p = prices[h.stockCode];
          if (!p || p.changeRate == null) continue;
          totalRatio += h.navRatio;
          weightedChange += p.changeRate * h.navRatio;
        }
        if (totalRatio > 0) {
          selfEstimate = +(weightedChange / totalRatio).toFixed(2);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 3. 组装返回：净值已公布用精确值，否则用自主估算
  const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-${String(now.getUTCDate()).padStart(2,"0")}`;
  const estimateUpdated = em.actualDate === todayStr;

  // nav 要与 actualNav 保持一致，避免前端 selectChangeRate 误判
  const baseNav = estimateUpdated ? (em.yesterdayNav || em.actualNav) : em.actualNav;

  return {
    nav: baseNav || null,
    estimatedNav: null,
    estimatedChangeRate: !estimateUpdated && selfEstimate != null ? selfEstimate : (em.actualChangeRate || 0),
    estimateTime: !estimateUpdated && selfEstimate != null
      ? `${String((now.getUTCHours()+8)%24).padStart(2,"0")}:${String(now.getUTCMinutes()).padStart(2,"0")}`
      : "",
    actualNav: em.actualNav,
    actualDate: em.actualDate,
    actualChangeRate: em.actualChangeRate,
  };
}

async function fetchHistory(fundCode, totalNeeded) {
  const https = require("https");
  const PER_PAGE = 20;
  const pages = Math.ceil(totalNeeded / PER_PAGE);
  const pageTasks = Array.from({ length: pages }, (_, i) =>
    new Promise((resolve) => {
      const req = https.get({
        hostname: "api.fund.eastmoney.com",
        path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=${i + 1}&pageSize=${PER_PAGE}`,
        headers: { Referer: "https://fundf10.eastmoney.com/" },
      }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
            resolve((json.Data.LSJZList || []).map((item) => ({
              date: item.FSRQ,
              nav: parseFloat(item.DWJZ) || 0,
              cumulativeNav: parseFloat(item.LJJZ) || 0,
              changeRate: parseFloat(item.JZZZL) || 0,
            })));
          } catch (e) { resolve([]); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve([]); });
      req.on("error", () => resolve([]));
    })
  );
  const results = await Promise.all(pageTasks);
  return results.flat();
}

async function fetchProfileData(fundCode) {
  const https = require("https");
  const [profile, manager] = await Promise.all([
    new Promise((resolve) => {
      const url = `https://fundmobapi.eastmoney.com/FundMApi/FundDetailInformation.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
      const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = (JSON.parse(body).Datas) || {};
            resolve({
              fundName: d.SHORTNAME || "",
              fundType: d.FTYPE || "",
              establishDate: d.ESTABDATE || "",
              fundSize: parseFloat(d.ENDNAV) || null,
              riskLevel: d.RISKLEVEL || "",
              company: d.JJGS || "",
              mgmtFee: d.MGREXP || null,
              trustFee: d.TRUSTEXP || null,
              salesFee: d.SALESEXP || null,
            });
          } catch (e) { resolve(null); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    }),
    new Promise((resolve) => {
      const url = `https://fundmobapi.eastmoney.com/FundMApi/FundManagerList.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
      const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const list = (JSON.parse(body).Datas || []).filter((m) => !m.LEMPDATE);
            const cur = list[0] || {};
            resolve({
              name: cur.MGRNAME || "",
              tenureDays: Math.round(cur.DAYS) || 0,
              startDate: cur.FEMPDATE || "",
              tenureReturn: cur.PENAVGROWTH ? parseFloat(cur.PENAVGROWTH).toFixed(2) : null,
            });
          } catch (e) { resolve(null); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    }),
  ]);
  return { profile, manager };
}

async function fetchPeTemp(fundCode) {
  try {
    const db = cloud.database();
    const res = await db.collection("fund_temperatures")
      .where({ fundCode })
      .orderBy("createTime", "desc")
      .limit(1)
      .get();
    if (res.data && res.data.length > 0) {
      const t = res.data[0];
      return { signal: t.signal, label: t.label, normPE: t.normPE };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ---- 自主估算辅助函数 ----

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
                  stockCode: tds[1], stockName: tds[2], navRatio: ratio,
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

function fetchStockPricesTencent(codes) {
  const http = require("http");
  const map = {};
  if (!codes || codes.length === 0) return map;
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
            const curr = parseFloat(fields[3]), prev = parseFloat(fields[4]);
            if (!isNaN(prev) && !isNaN(curr) && prev > 0) {
              map[code] = { prevClose: prev, price: curr, changeRate: +(((curr-prev)/prev)*100).toFixed(2) };
            }
          }
        } catch (e) {}
        resolve();
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });
  return (async () => {
    for (let i = 0; i < codes.length; i += BATCH) await fetchBatch(codes.slice(i, i + BATCH));
    return map;
  })();
}
