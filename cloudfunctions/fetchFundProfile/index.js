const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const fd = require("./_shared/fund-data");

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    // 最新已发布季报：1-3月→12月, 4-6月→3月, 7-9月→6月, 10-12月→9月
    const { year: curY, month: curM } = fd.getQuarterParams();
    let prevY = curY, prevM = curM - 3;
    if (prevM <= 0) { prevY = curY - 1; prevM = 12; }

	    // 4 个请求全部并行，减少一轮网络往返
	    const [profile, manager, holdingsData, prevHoldingsData, turnoverRates] = await Promise.all([
	      fetchProfile(fundCode),
	      fetchManager(fundCode),
	      fetchHoldings(fundCode, curY, curM),
	      fetchHoldings(fundCode, prevY, prevM).catch(() => ({ holdings: [], reportYear: null, reportMonth: null, ok: false })),
	      fetchTurnoverRate(fundCode).catch(() => []),
	    ]);
    let holdings = holdingsData.holdings || [];
    let prevHoldings = prevHoldingsData.holdings || [];
    // 上期数据拉取失败（而非「上期真的空」）→ 前端显示「上期数据缺失」，避免误报全部新增/退出
    let prevDataIncomplete = prevHoldingsData.ok === false;

    // 根据实际季报日期判断当期数据归属哪个季度
    // 若请求 Q2 但 API 返回 Q1 数据，自动调整对比季度
    let actualYear = holdingsData.reportYear;
    let actualMonth = holdingsData.reportMonth;
    if (actualMonth && actualYear && (actualYear !== curY || actualMonth !== curM)) {
      // API 返回的不是请求的季度，重新获取正确的上期数据
      let prevTargetM = actualMonth - 3;
      let prevTargetY = actualYear;
      if (prevTargetM <= 0) { prevTargetY = actualYear - 1; prevTargetM = 12; }
      if (prevTargetM !== prevM || prevTargetY !== prevY) {
        const fallback = await fetchHoldings(fundCode, prevTargetY, prevTargetM).catch(() => ({ holdings: [], ok: false }));
        prevHoldings = fallback.holdings || [];
        if (fallback.ok === false) prevDataIncomplete = true;
      }
    }

    // 计算持仓变动
    const prevMap = {};
    prevHoldings.forEach(h => { prevMap[h.stockCode] = h; });
    holdings.forEach(h => {
      const prev = prevMap[h.stockCode];
      if (prevDataIncomplete) {
        // 上期数据缺失：不推断新增/变动，避免误报
        h.ratioChange = null;
        h.changeType = 'unknown';
      } else if (prev && prev.navRatio) {
        const v = +(parseFloat(h.navRatio) - parseFloat(prev.navRatio)).toFixed(2);
        h.ratioChange = isNaN(v) ? null : v;
        h.changeType = v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'hold';
      } else if (prev) {
        h.ratioChange = null;
        h.changeType = 'hold';
      } else {
        h.ratioChange = null;
        h.changeType = 'new';
      }
    });
    // 上季度有但本季度没有的 → 退出（上期数据缺失时无法判断，不展示）
    const currCodes = new Set(holdings.map(h => h.stockCode));
    const exited = !prevDataIncomplete
      ? prevHoldings.filter(h => !currCodes.has(h.stockCode)).map(h => ({
          ...h, changeType: 'exit', ratioChange: null,
        }))
      : [];

    // 提取前 10 持仓（排除带 * 的非固定持仓）
    const top10 = holdings.filter(h => !h.rank.includes('*')).slice(0, 10);

    // 云函数内批量拉取股票实时行情（腾讯批量接口，1 个 HTTP，避开客户端 6 连接限制）
    let stockQuotes = {};
    try {
      const q = await fd.fetchStockPricesTencent(top10.map(h => h.stockCode).filter(Boolean));
      stockQuotes = q; // { [code]: { price, prevClose, changeRate } }
    } catch (e) { /* 行情失败不阻塞主流程 */ }

    const enrichedHoldings = top10.map(h => ({
      ...h,
      stockChangeRate: stockQuotes[h.stockCode] && stockQuotes[h.stockCode].changeRate != null
        ? stockQuotes[h.stockCode].changeRate : null,
      isHK: h.stockCode && h.stockCode.length === 5,
    }));

    // 退出的也传回去（前端按需显示）
    const enrichedExited = exited.filter(h => !h.rank.includes('*')).map(h => ({
      ...h,
      stockChangeRate: null,
      isHK: h.stockCode && h.stockCode.length === 5,
    }));

    const quarterLabel = actualYear && actualMonth ? `${actualYear}年Q${Math.ceil(actualMonth / 3)}` : '';

    return { code: 0, data: { profile, manager, holdings: enrichedHoldings, exited: enrichedExited, quarterLabel, turnoverRates, prevDataIncomplete } };
  } catch (e) {
    console.error("获取基金信息失败:", e);
    return { code: 500, msg: "获取基金信息失败" };
  }
};

function fetchProfile(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fundmobapi.eastmoney.com/FundMApi/FundDetailInformation.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
    const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const d = (JSON.parse(body).Datas) || {};
          resolve({
            fundCode: d.FCODE || fundCode,
            fundName: d.SHORTNAME || "",
            fullName: d.FULLNAME || "",
            fundType: d.FTYPE || "",
            establishDate: d.ESTABDATE || "",
            fundSize: parseFloat(d.ENDNAV) || null,
            sizeDate: d.FEGMRQ || "",
            riskLevel: d.RISKLEVEL || "",
            company: d.JJGS || "",
            custodian: d.TGYH || "",
            managerName: d.JJJL || "",
            benchmark: d.BENCH || "",
            mgmtFee: d.MGREXP || "",
            trustFee: d.TRUSTEXP || "",
            salesFee: d.SALESEXP || "",
          });
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function fetchManager(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
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
  });
}

function fetchHoldings(fundCode, year, month) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          // content 未匹配 = 该季度确实无持仓数据（新基金/无季报），不算拉取失败；
          // 拉取失败仅指无匹配/超时/网络错误（走下方 catch/超时分支）
          if (!match) { resolve({ holdings: [], reportMonth: null, ok: true }); return; }
          const html = match[1].replace(/\\"/g, '"');
          // 解析实际报告截止日期（e.g. "2025-12-31" → year=2025, month=12）
          const dateMatch = html.match(/(\d{4})-(\d{2})-\d{2}/);
          const reportYear = dateMatch ? parseInt(dateMatch[1]) : null;
          const reportMonth = dateMatch ? parseInt(dateMatch[2]) : null;
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
            // 列结构只有 7 列或 9 列两种（9 列多出资讯列），其余视为异常行丢弃，
            // 否则 tds[n-3] 会取错列导致「上季度数据偶发 undefined/异常」
            if (tds.length === 7 || tds.length === 9) {
              const n = tds.length;
              rows.push({
                rank: tds[0],
                stockCode: tds[1],
                stockName: tds[2],
                navRatio: tds[n - 3],
                shares: tds[n - 2],
                marketValue: tds[n - 1],
              });
            }
          }
          resolve({ holdings: rows, reportYear, reportMonth, ok: true });
        } catch (e) { resolve({ holdings: [], reportMonth: null, ok: false }); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ holdings: [], reportMonth: null, ok: false }); });
    req.on("error", () => resolve({ holdings: [], reportMonth: null, ok: false }));
  });
}

/**
 * 拉取基金换手率（从天天基金 HTML 页面解析）
 */
function fetchTurnoverRate(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fund.eastmoney.com/${fundCode}.html`;
    const req = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const rates = [];
          // 解析表格：<tr><td>报告期</td><td>换手率</td></tr>
          const tableRegex = /<tr[^>]*>\s*<td[^>]*>(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\d.]+)%<\/td>\s*<\/tr>/g;
          let match;
          while ((match = tableRegex.exec(body)) !== null) {
            rates.push({
              date: match[1],
              rate: parseFloat(match[2]),
            });
          }
          resolve(rates);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}
