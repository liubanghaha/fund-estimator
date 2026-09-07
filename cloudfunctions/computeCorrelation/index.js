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
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const html = match[1].replace(/\\"/g, '"');
          // 东财 jjcc 按 year 返回当年多个季度的 <table>，须按"截止至"日期选中目标季度表，
          // 否则全年各季度行混入 → 同一股票被计多次 → fundCount/重合度虚高
          const targetEnd = `${curY}-${String(curM).padStart(2, "0")}-${curM === 3 ? "31" : curM === 6 ? "30" : curM === 9 ? "30" : "31"}`;
          const pickTable = (htmlStr) => {
            const tblRe = /<table[\s\S]*?<\/table>/g;
            let tm;
            let firstValid = null;
            while ((tm = tblRe.exec(htmlStr)) !== null) {
              const tbl = tm[0];
              const before = htmlStr.slice(Math.max(0, tm.index - 300), tm.index);
              const em = before.match(/截止至：[\s\S]*?(\d{4}-\d{2}-\d{2})/);
              const thText = ((tbl.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || []).map(t => t.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).join("|"));
              if (thText.indexOf("占净值") === -1) continue;
              if (!firstValid) firstValid = tbl;
              if (em && em[1] === targetEnd) return tbl;
            }
            return firstValid || htmlStr;
          };
          const mainHtml = pickTable(html);
          // 表头定位「占净值比例」列（列数随基金类型/季度变化，固定 n-3 会取错列）
          const ratioCol = (() => {
            const thead = mainHtml.match(/<thead[\s\S]*?<\/thead>/);
            if (!thead) return -1;
            const ths = thead[0].match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [];
            for (let i = 0; i < ths.length; i++) {
              const text = ths[i].replace(/<[^>]+>/g, "").replace(/\s+/g, "");
              if (text.indexOf("占净值") !== -1) return i;
            }
            return -1;
          })();
          const rows = [];
          const seen = new Set(); // 同基金同季度内按 stockCode 去重
          const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
          let trMatch;
          while ((trMatch = trRegex.exec(mainHtml)) !== null) {
            const tds = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
              tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            if (tds.length >= 7 && tds.length <= 10 && !tds[0].includes("*") && !seen.has(tds[1])) {
              seen.add(tds[1]);
              const n = tds.length;
              const col = ratioCol >= 1 && ratioCol < n ? ratioCol : n - 3;
              rows.push({
                stockCode: tds[1],
                stockName: tds[2],
                navRatio: parseFloat(tds[col]) || 0,
              });
            }
          }
          // 口径=「前十大持仓对比」：QDII 等基金东财披露全量明细（70+ 行），须截取前十大
          // 打新获配股占净值显示 0.00%，多只基金同时打新会造成重合假象，一并剔除
          resolve(rows.slice(0, 10).filter((r) => r.navRatio >= 0.1));
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };
  const { fundCodes } = event;
  if (!fundCodes || !Array.isArray(fundCodes) || fundCodes.length < 2) {
    return { code: 400, msg: "请提供至少2个基金代码" };
  }
  // 上限保护：超过 20 只基金时按 30s 超时预算拉取不完，截断并通知前端
  const truncated = fundCodes.length > 20;
  const codes = fundCodes.slice(0, 20);

  try {
    // 1. 并行拉取每只基金的持仓股（限 10 只/批 + 100ms，避免用户传大量基金时瞬时并发被风控）
    const CONCURRENT = 10;
    const allHoldings = [];
    for (let i = 0; i < codes.length; i += CONCURRENT) {
      const batch = codes.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        try {
          const list = await fetchHoldings(code);
          return { code, list };
        } catch (e) { return { code, list: [] }; }
      }));
      allHoldings.push(...results);
      if (i + CONCURRENT < codes.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

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
    const codeList = codes;
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
        totalFunds: codes.length,
        truncated,
        hasHoldingsCount: Object.values(fundStockMap).filter(l => l.length > 0).length,
      },
    };
  } catch (e) {
    console.error("持仓重合分析失败:", e.message);
    return { code: 500, msg: "分析失败" };
  }
};
