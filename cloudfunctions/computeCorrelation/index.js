const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require("https");
const db = cloud.database();

// 拉取基金前十大持仓股（本季度）
async function fetchHoldings(fundCode) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3, curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
    if (i === 0) { curY = year - 1; curM = 12; }
  }
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=${curY}&month=${curM}&rt=${Math.random()}`;
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
              rows.push({
                stockCode: tds[1],
                stockName: tds[2],
                navRatio: parseFloat(tds[n - 3]) || 0,
              });
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

exports.main = async (event) => {
  const { fundCodes } = event;
  if (!fundCodes || !Array.isArray(fundCodes) || fundCodes.length < 2) {
    return { code: 400, msg: "请提供至少2个基金代码" };
  }

  try {
    // 1. 并行拉取每只基金的持仓股
    const allHoldings = await Promise.all(fundCodes.map(async (code) => {
      try {
        const list = await fetchHoldings(code);
        return { code, list };
      } catch (e) { return { code, list: [] }; }
    }));

    const fundStockMap = {};   // fundCode → [{stockCode, stockName, navRatio}]
    const stockFundMap = {};   // stockCode → [{fundCode, fundName, navRatio}]
    const fundNames = {};      // for display (we get names from event)

    allHoldings.forEach(({ code, list }) => {
      fundStockMap[code] = list;
      list.forEach(h => {
        if (!stockFundMap[h.stockCode]) stockFundMap[h.stockCode] = [];
        stockFundMap[h.stockCode].push({ fundCode: code, stockName: h.stockName, navRatio: h.navRatio });
      });
    });

    // 2. 找出被多只基金持有的股票（重合持仓），按持有基金数降序
    const sharedStocks = Object.entries(stockFundMap)
      .filter(([_, funds]) => funds.length >= 2)
      .map(([stockCode, funds]) => ({
        stockCode,
        stockName: funds[0].stockName,
        fundCount: funds.length,
        funds: funds.map(f => ({ fundCode: f.fundCode, ratio: f.navRatio })),
      }))
      .sort((a, b) => b.fundCount - a.fundCount);

    // 3. 计算每对基金的重合度（两两对比持仓交集）
    const codeList = fundCodes;
    const pairs = [];
    for (let i = 0; i < codeList.length; i++) {
      for (let j = i + 1; j < codeList.length; j++) {
        const stocksA = new Set((fundStockMap[codeList[i]] || []).map(h => h.stockCode));
        const stocksB = new Set((fundStockMap[codeList[j]] || []).map(h => h.stockCode));
        const intersection = [...stocksA].filter(s => stocksB.has(s));
        const union = new Set([...stocksA, ...stocksB]);
        const overlapCount = intersection.length;
        const overlapRate = union.size > 0 ? +(overlapCount / union.size).toFixed(2) : 0;
        if (overlapCount > 0) {
          pairs.push({
            fundA: codeList[i],
            fundB: codeList[j],
            overlapCount,
            overlapRate,
            sharedStocks: intersection,
          });
        }
      }
    }
    pairs.sort((a, b) => b.overlapCount - a.overlapCount);

    return {
      code: 0,
      data: {
        sharedStocks,
        pairs,
        totalFunds: fundCodes.length,
        hasHoldingsCount: Object.values(fundStockMap).filter(l => l.length > 0).length,
      },
    };
  } catch (e) {
    console.error("持仓重合分析失败:", e.message);
    return { code: 500, msg: "分析失败" };
  }
};
