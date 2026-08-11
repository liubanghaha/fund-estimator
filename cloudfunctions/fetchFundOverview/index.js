const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const fd = require("./_shared/fund-data");

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "请提供有效的6位基金代码" };

  try {
    const [estimate, history, profileData, peTemp] = await Promise.all([
      fetchEstimate(fundCode),
      fd.fetchNAVHistory(fundCode, 260),
      fetchProfileData(fundCode),
      fetchPeTemp(fundCode),
    ]);
    return {
      code: 0, msg: "success",
      data: {
        ...estimate,
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
  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await fd.fetchLatestNavEastMoney(fundCode);

  // 2. 自主估算：持仓股涨跌加权
  let selfEstimate = null;
  if (fd.isBJWeekday()) {
    try {
      const holdings = await fd.fetchTempHoldings(fundCode);
      if (holdings && holdings.length > 0) {
        const stockCodes = [...new Set(holdings.map(h => h.stockCode).filter(Boolean))];
        const prices = stockCodes.length > 0 ? await fd.fetchStockPricesTencent(stockCodes) : {};
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
  const todayStr = fd.formatBJDate();
  const estimateUpdated = em.actualDate === todayStr;

  // nav 要与 actualNav 保持一致，避免前端 selectChangeRate 误判
  const baseNav = estimateUpdated ? (em.yesterdayNav || em.actualNav) : em.actualNav;

  return {
    nav: baseNav || null,
    estimatedNav: null,
    estimatedChangeRate: !estimateUpdated && selfEstimate != null ? selfEstimate : (em.actualChangeRate || 0),
    estimateTime: !estimateUpdated && selfEstimate != null ? fd.formatBJTime() : "",
    actualNav: em.actualNav,
    actualDate: em.actualDate,
    actualChangeRate: em.actualChangeRate,
  };
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
