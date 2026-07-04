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
	      const result = findClosestNAV(navHistory, currentMonth, day);
	      if (result) {
	        const nav = result.nav;
	        const navDate = result.date;
	        const shares = amount / nav;
	        totalShares += shares;
	        totalInvested += amount;
	        monthlyDetail.push({
	          month: `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, "0")}`,
	          nav: +nav.toFixed(4),
	          navDate,
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

    // 当前市值（取最近一个有效净值及其日期）
    let latestNAV = 0;
    let latestNAVDate = "";
    for (let i = navHistory.length - 1; i >= 0; i--) {
      const n = navHistory[i].nav;
      if (n && n > 0) { latestNAV = n; latestNAVDate = navHistory[i].date; break; }
    }
    if (latestNAV <= 0) {
      return { code: 404, msg: "未获取到有效净值" };
    }
    const currentValue = totalShares * latestNAV;
    const totalReturn = currentValue - totalInvested;
    const returnRate = ((currentValue / totalInvested) - 1) * 100;

    // 年化收益率 (XIRR 二分法，考虑每笔定投的实际日期)
    const annualizedReturn = calcXIRR(monthlyDetail, currentValue, latestNAVDate);

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
        months: monthlyDetail.length,
        monthlyDetail,
      },
    };
  } catch (e) {
    console.error("[dcaBacktest] 异常:", e);
    return { code: 500, msg: e.message };
  }
};

/**
 * XIRR 年化收益率（二分法）
 * cashFlows: [{ navDate, amount }]  amount 为每期投入（正数）
 * endValue: 当前市值
 * endDate: 最新净值日期
 */
function calcXIRR(monthlyDetail, endValue, endDate) {
  if (monthlyDetail.length < 2) {
    // 只有一期，用简化公式
    const totalInvested = monthlyDetail.reduce((s, d) => s + d.amount, 0);
    if (totalInvested <= 0) return 0;
    const firstDate = new Date(monthlyDetail[0].navDate);
    const lastDate = new Date(endDate);
    const years = Math.max(0.1, (lastDate - firstDate) / (365.25 * 24 * 60 * 60 * 1000));
    return (Math.pow(endValue / totalInvested, 1 / years) - 1) * 100;
  }

  // 构建现金流：投入为负，终值为正
  const cashFlows = monthlyDetail.map(d => ({
    date: new Date(d.navDate),
    amount: -d.amount,
  }));
  cashFlows.push({
    date: new Date(endDate),
    amount: endValue,
  });

  // 二分法求解 IRR
  const firstDate = cashFlows[0].date;
  const dayToYear = (date) => (date - firstDate) / (365.25 * 24 * 60 * 60 * 1000);

  function npv(rate) {
    let total = 0;
    for (const cf of cashFlows) {
      const years = dayToYear(cf.date);
      total += cf.amount / Math.pow(1 + rate, years);
    }
    return total;
  }

  let low = -0.999;   // -99.9%
  let high = 10.0;    // 1000%
  let npvLow = npv(low);
  let npvHigh = npv(high);

  // 如果同号，扩展搜索范围
  let expand = 0;
  while (npvLow * npvHigh > 0 && expand < 15) {
    if (Math.abs(npvLow) < Math.abs(npvHigh)) {
      low = low * 2 - 0.5;
      npvLow = npv(low);
    } else {
      high = high * 2 + 0.5;
      npvHigh = npv(high);
    }
    expand++;
  }

  if (npvLow * npvHigh > 0) return 0;

  // 二分迭代
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < 1e-6) return mid * 100;
    if (npvMid * npvLow < 0) {
      high = mid;
      npvHigh = npvMid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }

  return ((low + high) / 2) * 100;
}

/**
 * 拉取基金历史净值（东方财富接口），分页拉全
 */
async function fetchNAVHistory(fundCode, startDate) {
  const https = require("https");
  const startYear = startDate.getFullYear();
  const currentYear = new Date().getFullYear();
  const allData = [];

  for (let year = startYear; year <= currentYear; year++) {
    // 先拉第 1 页，获取 TotalCount
    const page1 = await fetchNAVPage(https, fundCode, year, 1);
    if (!page1 || page1.list.length === 0) continue;
    allData.push(...page1.list);

    // 计算总页数（API 固定每页 20 条）
    const pageSize = page1.list.length; // 实际每页条数
    const totalPages = Math.ceil(page1.total / pageSize);
    if (totalPages <= 1) continue;

    // 并发拉取剩余页
    const pageTasks = [];
    for (let p = 2; p <= totalPages; p++) {
      pageTasks.push(fetchNAVPage(https, fundCode, year, p));
    }
    const results = await Promise.all(pageTasks);
    results.forEach(r => {
      if (r && r.list.length > 0) allData.push(...r.list);
    });
  }

  return allData;
}

function fetchNAVPage(https, fundCode, year, pageIndex) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=200&startDate=${year}-01-01&endDate=${year}-12-31&_=${Date.now()}`;
  return new Promise((resolve) => {
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
          resolve({
            total: json.TotalCount || 0,
            list: list.map(item => ({
              date: item.FSRQ,
              nav: parseFloat(item.DWJZ) || 0,
            })).filter(item => item.nav > 0),
          });
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/**
 * 找到指定月份最接近定投日的净值，返回 { nav, date }
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
    if (nextCandidates.length > 0) return nextCandidates[0];
    return null;
  }

  // 找最接近目标日的净值（不晚于目标日）
  const target = `${prefix}-${String(targetDay).padStart(2, "0")}`;
  const onOrBefore = candidates.filter(item => item.date <= target);
  if (onOrBefore.length > 0) return onOrBefore[onOrBefore.length - 1];
  return candidates[0];
}
