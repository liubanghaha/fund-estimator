const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 定投回测
 * 输入：fundCode, monthlyAmount, startYear, startMonth, monthlyDay, endYear, endMonth
 * 输出：累计投入、当前市值、总收益、年化收益率、逐月明细
 */
exports.main = async (event) => {
  const { fundCode, monthlyAmount, startYear, startMonth, monthlyDay, endYear, endMonth } = event;
  if (!fundCode || !monthlyAmount || !startYear || !startMonth) {
    return { code: 400, msg: "参数不完整" };
  }

  const amount = parseFloat(monthlyAmount);
  const day = parseInt(monthlyDay) || 1;
  const start = new Date(parseInt(startYear), parseInt(startMonth) - 1, 1);
  const end = endYear && endMonth
    ? new Date(parseInt(endYear), parseInt(endMonth) - 1, 1)
    : new Date(); // 默认到现在

  try {
    // 拉取基金净值历史
    const navHistory = await fetchNAVHistory(fundCode, start);
    if (navHistory.length === 0) {
      return { code: 404, msg: "未获取到净值数据" };
    }

    // 按日期排序（升序）
    navHistory.sort((a, b) => a.date.localeCompare(b.date));

    // 从起始月开始，每月定投
    let totalShares = 0;
    let totalInvested = 0;
    const monthlyDetail = [];

    let currentMonth = new Date(start.getFullYear(), start.getMonth(), 1);
    while (currentMonth <= end) {
      const nav = findClosestNAV(navHistory, currentMonth, day);
      if (nav) {
        const shares = amount / nav;
        totalShares += shares;
        totalInvested += amount;
        monthlyDetail.push({
          month: `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, "0")}`,
          nav: +nav.toFixed(4),
          shares: +shares.toFixed(2),
          amount,
          cumulativeShares: +totalShares.toFixed(2),
          cumulativeInvested: totalInvested,
        });
      }
      currentMonth.setMonth(currentMonth.getMonth() + 1);
    }

    if (totalInvested === 0) {
      return { code: 404, msg: "所选时间段内无有效净值数据" };
    }

    // 当前市值（取最近一个有效净值）
    let latestNAV = 0;
    for (let i = navHistory.length - 1; i >= 0; i--) {
      const n = navHistory[i].nav;
      if (n && n > 0) { latestNAV = n; break; }
    }
    if (latestNAV <= 0) {
      return { code: 404, msg: "未获取到有效净值" };
    }
    const currentValue = totalShares * latestNAV;
    const totalReturn = currentValue - totalInvested;
    const returnRate = ((currentValue / totalInvested) - 1) * 100;

    // 年化收益率 (XIRR 简化：按总月份线性折算)
    const months = monthlyDetail.length;
    const annualizedReturn = months > 0
      ? ((Math.pow(currentValue / totalInvested, 12 / months) - 1) * 100)
      : 0;

    return {
      code: 0,
      data: {
        fundCode,
        monthlyAmount: amount,
        totalInvested: +totalInvested.toFixed(2),
        currentValue: +currentValue.toFixed(2),
        totalReturn: +totalReturn.toFixed(2),
        returnRate: +returnRate.toFixed(2),
        annualizedReturn: +annualizedReturn.toFixed(2),
        months,
        monthlyDetail,
      },
    };
  } catch (e) {
    console.error("[dcaBacktest] 异常:", e);
    return { code: 500, msg: e.message };
  }
};

/**
 * 拉取基金历史净值（东方财富接口）
 */
async function fetchNAVHistory(fundCode, startDate) {
  const https = require("https");
  // 按年份分段拉取，从起始年到当前年
  const startYear = startDate.getFullYear();
  const currentYear = new Date().getFullYear();
  const allData = [];

  for (let year = startYear; year <= currentYear; year++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=200&startDate=${year}-01-01&endDate=${year}-12-31&_=${Date.now()}`;

    const data = await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { Referer: "https://fundf10.eastmoney.com/" },
      }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const jsonStr = body.replace(/^jQuery\(/, "").replace(/\);?$/, "");
            const json = JSON.parse(jsonStr);
            const list = (json.Data && json.Data.LSJZList) || [];
            resolve(list.map(item => ({
              date: item.FSRQ,
              nav: parseFloat(item.DWJZ) || 0,
            })).filter(item => item.nav > 0));
          } catch (e) { resolve([]); }
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
      req.on("error", () => resolve([]));
    });
    allData.push(...data);
  }

  return allData;
}

/**
 * 找到指定月份最接近定投日的净值
 */
function findClosestNAV(navHistory, month, targetDay) {
  const year = month.getFullYear();
  const m = month.getMonth() + 1;
  const prefix = `${year}-${String(m).padStart(2, "0")}`;

  const candidates = navHistory.filter(item => item.date.startsWith(prefix));
  if (candidates.length === 0) {
    // 下月份
    const nextPrefix = m === 12
      ? `${year + 1}-01`
      : `${year}-${String(m + 1).padStart(2, "0")}`;
    const nextCandidates = navHistory.filter(item => item.date.startsWith(nextPrefix));
    if (nextCandidates.length > 0) return nextCandidates[0].nav;
    return null;
  }

  // 找最接近目标日的净值（不晚于目标日）
  const target = `${prefix}-${String(targetDay).padStart(2, "0")}`;
  const onOrBefore = candidates.filter(item => item.date <= target);
  if (onOrBefore.length > 0) return onOrBefore[onOrBefore.length - 1].nav;
  return candidates[0].nav;
}
