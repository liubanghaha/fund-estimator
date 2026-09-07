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
    prevHoldings.forEach(h => { if (h.stockCode) prevMap[h.stockCode] = h; });
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

    // 提取前 10 持仓（排除带 * 的非固定持仓；rank 缺失时视为异常行跳过）
    const top10 = holdings.filter(h => h.rank && !h.rank.includes('*')).slice(0, 10);

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
    const enrichedExited = exited.filter(h => h.rank && !h.rank.includes('*')).map(h => ({
      ...h,
      stockChangeRate: null,
      isHK: h.stockCode && h.stockCode.length === 5,
    }));

    const quarterLabel = actualYear && actualMonth ? `${actualYear}年Q${Math.ceil(actualMonth / 3)}` : '';

    return { code: 0, data: { profile, manager, holdings: enrichedHoldings, exited: enrichedExited, quarterLabel, turnoverRates, prevDataIncomplete, _debug: { curM, prevM, prevY, actualMonth, holdingsTop: holdings.map(h => ({ code: h.stockCode, n: h.stockName, r: h.navRatio })), prevTop: prevHoldings.map(h => ({ code: h.stockCode, n: h.stockName, r: h.navRatio })) } } };
  } catch (e) {
    console.error("获取基金信息失败:", e);
    return { code: 500, msg: "获取基金信息失败" };
  }
};

function fetchProfile(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fundmobapi.eastmoney.com/FundMApi/FundDetailInformation.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
    const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
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
    const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
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
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          // content 未匹配 = 该季度确实无持仓数据（新基金/无季报），不算拉取失败；
          // 拉取失败仅指无匹配/超时/网络错误（走下方 catch/超时分支）
          if (!match) { resolve({ holdings: [], reportMonth: null, ok: true }); return; }
          const html = match[1].replace(/\\"/g, '"');

          // 东财 jjcc 按 year 返回该年多个季度的 <table>，每个 table 前带"截止至：YYYY-MM-DD"（报告期）。
          // fetchHoldings 需按目标季度截止日选对对应 table，否则取到的上期=本期、或占比列错位。
          // 目标季度截止日：month 为季度末月，Q1→03-31 / Q2→06-30 / Q3→09-30 / Q4→12-31。
          const targetEnd = `${year}-${String(month).padStart(2, "0")}-${month === 3 ? "31" : month === 6 ? "30" : month === 9 ? "30" : "31"}`;

          // 按"截止至"日期把每个 table 报告期分组
          let targetTable = null, reportYear = null, reportMonth = null;
          const tblRe = /<table[\s\S]*?<\/table>/g;
          let tblMatch;
          while ((tblMatch = tblRe.exec(html)) !== null) {
            const tbl = tblMatch[0];
            const before = html.slice(Math.max(0, tblMatch.index - 300), tblMatch.index);
            const endMatch = before.match(/截止至：[\s\S]*?(\d{4}-\d{2}-\d{2})/);
            const dateStr = endMatch ? endMatch[1] : null;
            const thText = (tbl.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [])
              .map(t => t.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).join("|");
            if (thText.indexOf("占净值") === -1) continue; // 只认持仓主表（含占净值比例表头）
            if (dateStr === targetEnd) { targetTable = tbl; reportYear = parseInt(dateStr.slice(0, 4)); reportMonth = parseInt(dateStr.slice(5, 7)); break; }
            // 用最近一个"非目标但已发布"的表兜底（前端 prevDataIncomplete 已处理缺失）
            if (!targetTable && dateStr) { /* 暂记第一个含占净值的表，若未命中目标则用它 */ }
          }
          const mainHtml = targetTable || (() => {
            // 未命中目标季度：退化为取第一个含占净值的表（历史数据）
            const anyTbl = html.match(/<table[\s\S]*?<\/table>/g);
            if (anyTbl) {
              for (const t of anyTbl) {
                if ((t.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || []).some(x => x.replace(/<[^>]+>/g, "").replace(/\s+/g, "").indexOf("占净值") !== -1)) {
                  const b = html.slice(Math.max(0, html.indexOf(t) - 300), html.indexOf(t));
                  const em = b.match(/截止至：[\s\S]*?(\d{4}-\d{2}-\d{2})/);
                  if (em) { reportYear = parseInt(em[1].slice(0, 4)); reportMonth = parseInt(em[1].slice(5, 7)); }
                  return t;
                }
              }
            }
            return html;
          })();

          // 表头定位「占净值比例」列（列数随季度变化，7 列/9 列不同，须用当前 table 的表头）
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
          const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
          let trMatch;
          while ((trMatch = trRegex.exec(mainHtml)) !== null) {
            const tds = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let tdMatch;
            while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
              tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
            }
            // 列数 7-10 均接受；占比列必须稳定为准：优先表头「占净值比例」定位，
            // 表头定位失败或该列值域异常（非 0-100 的百分比）时，回退到"行内首个 0-100 的数"，
            // 绝不使用固定倒数第 N 列（列数随基金类型/季度变化，固定偏移会取错列导致占比离谱）。
            // 均取不到 → 该行占比置 null（前端显示 --，而非用错列误导）。
            if (tds.length >= 7 && tds.length <= 10) {
              const n = tds.length;
              const ratioStr = (() => {
                // 1) 表头定位的列，校验值域在 0-100（占比是百分比）
                if (ratioCol >= 1 && ratioCol < n) {
                  const v = parseFloat(tds[ratioCol]);
                  if (!isNaN(v) && v >= 0 && v <= 100) return tds[ratioCol];
                }
                // 2) 行内首个 0-100 的百分比数（占比列）
                for (let i = 1; i < n; i++) {
                  const v = parseFloat(tds[i]);
                  if (!isNaN(v) && v >= 0 && v <= 100) return tds[i];
                }
                return null;
              })();
              const ratio = ratioStr == null ? NaN : parseFloat(ratioStr);
              rows.push({
                rank: tds[0],
                stockCode: tds[1],
                stockName: tds[2],
                navRatio: isNaN(ratio) ? null : ratio,
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
    }, (res) => { res.setEncoding("utf8");
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
