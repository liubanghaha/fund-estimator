const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const [profile, manager, holdings] = await Promise.all([
      fetchProfile(fundCode),
      fetchManager(fundCode),
      fetchHoldings(fundCode),
    ]);
    return { code: 0, data: { profile, manager, holdings } };
  } catch (e) {
    return { code: 500, msg: "获取基金信息失败" };
  }
};

function fetchProfile(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fundmobapi.eastmoney.com/FundMApi/FundDetailInformation.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
    https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => {
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
    }).on("error", () => resolve(null));
  });
}

function fetchManager(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://fundmobapi.eastmoney.com/FundMApi/FundManagerList.ashx?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`;
    https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => {
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
    }).on("error", () => resolve(null));
  });
}

function fetchHoldings(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const qMonths = [3, 6, 9, 12];
    let y = year;
    let m = 12;
    for (let i = qMonths.length - 1; i >= 0; i--) {
      if (qMonths[i] <= month) { m = qMonths[i]; break; }
    }
    if (month < 4) { y = year - 1; m = 12; }

    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=${y}&month=${m}&rt=${Math.random()}`;
    https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve([]); return; }
          const html = match[1].replace(/\\"/g, '"');
          // 提取表格行
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
    }).on("error", () => resolve([]));
  });
};
