const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "请提供有效的6位基金代码" };

  try {
    const [estimate, history, profileData] = await Promise.all([
      fetchEstimate(fundCode),
      fetchHistory(fundCode, 260),
      fetchProfileData(fundCode),
    ]);
    return {
      code: 0, msg: "success",
      data: {
        ...estimate,
        history,
        profile: profileData.profile,
        manager: profileData.manager,
      },
    };
  } catch (e) {
    console.error("获取基金概览失败:", e.message);
    return { code: 500, msg: "获取基金概览失败" };
  }
};

async function fetchEstimate(fundCode) {
  const https = require("https");
  const [tt, em] = await Promise.all([
    new Promise((resolve) => {
      const req = https.get(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, ""));
            resolve({
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
    }),
    new Promise((resolve) => {
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
            resolve({
              actualNav: parseFloat(today.DWJZ) || null,
              actualDate: today.FSRQ || "",
              actualChangeRate: parseFloat(today.JZZZL) || null,
            });
          } catch (e) { resolve({}); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve({}); });
      req.on("error", () => resolve({}));
    }),
  ]);
  return { ...tt, ...em };
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
