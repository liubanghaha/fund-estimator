const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    // 最新已发布季报：1-3月→12月, 4-6月→3月, 7-9月→6月, 10-12月→9月
    const pubMonths = [12, 3, 6, 9];
    let curM = 3, curY = year;
    for (let i = 3; i >= 0; i--) {
      if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
      if (i === 0) { curY = year - 1; curM = 12; }
    }
    let prevY = curY, prevM = curM - 3;
    if (prevM <= 0) { prevY = curY - 1; prevM = 12; }

    // 4 个请求全部并行，减少一轮网络往返
    const [profile, manager, holdings, prevHoldings] = await Promise.all([
      fetchProfile(fundCode),
      fetchManager(fundCode),
      fetchHoldings(fundCode, curY, curM),
      fetchHoldings(fundCode, prevY, prevM).catch(() => []),
    ]);

    // 计算持仓变动
    const prevMap = {};
    prevHoldings.forEach(h => { prevMap[h.stockCode] = h; });
    holdings.forEach(h => {
      const prev = prevMap[h.stockCode];
      if (prev && prev.navRatio) {
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
    // 上季度有但本季度没有的 → 退出
    const currCodes = new Set(holdings.map(h => h.stockCode));
    const exited = prevHoldings.filter(h => !currCodes.has(h.stockCode)).map(h => ({
      ...h, changeType: 'exit', ratioChange: null,
    }));

    // 提取前 10 持仓（排除带 * 的非固定持仓）
    const top10 = holdings.filter(h => !h.rank.includes('*')).slice(0, 10);

    const enrichedHoldings = top10.map(h => ({
      ...h,
      stockChangeRate: null,
      isHK: h.stockCode && h.stockCode.length === 5,
    }));

    // 退出的也传回去（前端按需显示）
    const enrichedExited = exited.filter(h => !h.rank.includes('*')).map(h => ({
      ...h,
      stockChangeRate: null,
      isHK: h.stockCode && h.stockCode.length === 5,
    }));

    return { code: 0, data: { profile, manager, holdings: enrichedHoldings, exited: enrichedExited } };
  } catch (e) {
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
            if (tds.length >= 7) {
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
          resolve(rows.length > 0 ? rows : []);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

/**
 * 服务端批量拉取股票实时行情，避开客户端 6 连接限制
 */
async function fetchStockQuotes(holdings) {
  const https = require("https");
  const map = {};

  const tasks = holdings.map(h => {
    const code = h.stockCode;
    let secid;
    if (code.length === 6) {
      secid = (code.startsWith("6") ? "1." : "0.") + code;
    } else if (code.length === 5) {
      secid = "116." + code; // 港股
    } else {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const url = `https://push2his.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f170`;
      const req = https.get(url, {
        headers: {
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = (JSON.parse(body).data) || {};
            map[code] = d.f170 != null ? +(d.f170 / 100).toFixed(2) : null;
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.setTimeout(5000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  });

  await Promise.all(tasks);
  return map;
}
