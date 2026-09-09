const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fd = require("./_shared/fund-data");
const https = require("https");
const ft = require("./_shared/fund-temperature");
const td = require("./_shared/trading-day");

exports.main = async (event) => {
  const { fundCode, src } = event;
  if (!fundCode || !/^\d{6}$/.test(fundCode)) return { code: 400, msg: "请提供有效的6位基金代码" };
  const estSrc = src === "self" ? "self" : "em";

  try {
    const [estimate, history, profileData, peTemp] = await Promise.all([
      fetchEstimate(fundCode, estSrc),
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

async function fetchEstimate(fundCode, estSrc) {
  // 1. 获取东方财富最新净值（用于兜底和昨收基准）
  const em = await fd.fetchLatestNavEastMoney(fundCode);
  const todayStr = fd.formatBJDate();
  // 数据所属日：当日 9:30 起为今日；凌晨/周末/节假日为上一交易日（净值已确定，按实际口径）
  const estimateUpdated = em.actualDate === _dataDay(todayStr);

  // 净值已公布：估算请求无意义（官方 GSZZL 已清空），直接走真值短路，省两轮外部请求
  if (estimateUpdated) {
    return {
      nav: (em.yesterdayNav || em.actualNav) || null,
      estimatedNav: null,
      estimatedChangeRate: em.actualChangeRate != null ? em.actualChangeRate : null,
      estimateTime: "",
      source: "nav",
      actualNav: em.actualNav,
      actualDate: em.actualDate,
      actualChangeRate: em.actualChangeRate,
    };
  }

  // 2. 官方估值（FundMNFInfo GSZZL；与天天基金 App 同口径，仅盘中/净值未公布前提供）
  const mnf = await new Promise((resolve) => {
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=wechat_est&Fcodes=${encodeURIComponent(fundCode)}`;
    const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/", "User-Agent": "Mozilla/5.0" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const it = (JSON.parse(Buffer.concat(chunks).toString("utf8")).Datas || [])[0] || {};
          resolve({
            gsz: it.GSZ != null && it.GSZ !== "--" ? parseFloat(it.GSZ) : null,
            gzhm: (String(it.GZTIME || "").match(/(\d{1,2}:\d{2})/) || [])[1] || "",
            gszzl: it.GSZZL != null && it.GSZZL !== "--" ? parseFloat(it.GSZZL) : null,
            gztime: it.GZTIME || null,
          });
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });

  // 3. 自主估算：持仓股涨跌加权
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

  // 4. 组装（净值未公布）：按所选源优先，三层兜底
  const mnfToday = mnf.gztime != null && (_gdIsToday(mnf.gztime, todayStr)) && mnf.gszzl != null;

  let estRate = null, estTime = "", source = "nav";
  if (estSrc === "em" && mnfToday) {
    estRate = mnf.gszzl; estTime = mnf.gzhm || mnf.gztime; source = "em";
  } else if (selfEstimate != null) {
    estRate = selfEstimate; estTime = fd.formatBJTime(); source = "self";
  } else if (mnfToday) {
    estRate = mnf.gszzl; estTime = mnf.gzhm || mnf.gztime; source = "em";
  } else {
    estRate = em.actualChangeRate != null ? em.actualChangeRate : null; source = "nav";
  }

  return {
    nav: em.actualNav || null,
    estimatedNav: source === "em" ? (mnf.gsz || null) : null,
    estimatedChangeRate: estRate,
    estimateTime: estTime,
    source,
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
      const req = https.get(url, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
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
    }),
  ]);
  return { profile, manager };
}

async function fetchPeTemp(fundCode) {
  try {
    const today = fd.formatBJDate();
    const res = await db.collection("fund_temperatures")
      .where({ fundCode, date: today })
      .field({ signal: true, label: true, normPE: true })
      .limit(1)
      .get();
    if (res.data && res.data.length > 0) {
      const t = res.data[0];
      return { signal: t.signal, label: ft.sanitizeLabel(t.label), normPE: t.normPE };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 数据所属日（净值/估算口径）：当日 9:30 起（含盘后当晚）为今日——盘中估算/晚间精确；
// 次日凌晨开盘前与周末、节假日为上一交易日——净值已确定，按实际口径
function _dataDay(todayStr) {
  const bj = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const openedToday = day >= 1 && day <= 5 && min >= 570;
  // lastTradingDay 含当天，取"上一交易日"须从昨天回找
  return openedToday && td.isTradingDay(todayStr) ? todayStr : td.lastTradingDay(_addDays(todayStr, -1));
}

function _addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
