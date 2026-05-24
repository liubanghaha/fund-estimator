const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  try {
    const res = await db.collection("holdings").where({ _openid: OPENID }).get();
    const holdings = res.data || [];

    if (holdings.length === 0) {
      return {
        code: 0,
        data: { holdings: [], totalAmount: "0.00", todayProfit: "0.00",
          todayProfitRate: "0.00", totalReturn: "0.00", totalReturnRate: "0.00", updateTime: "" },
      };
    }

    let totalCost = 0, totalMarket = 0, totalYesterdayMarket = 0, totalTodayProfit = 0;
    let updateTime = "";
    const enriched = [];

    for (const h of holdings) {
      let currentNav = h.buyPrice;
      let todayChangeRate = 0;
      let todayProfitAmount = 0;

      try {
        const [tiantian, eastmoney] = await Promise.all([
          fetchTiantian(h.fundCode),
          fetchEastMoney(h.fundCode),
        ]);

        currentNav = eastmoney.actualNav || tiantian.nav || h.buyPrice;

        const yesterdayNav = tiantian.nav; // 昨日净值

        // 当日收益 = (当日净值 - 昨日净值) × 份额
        // 收益率 = (当日净值 - 昨日净值) / 昨日净值 × 100，所以收益 = 昨日净值 × 份额 × 收益率 / 100
        // 收盘后优先用实际净值，盘中用估算净值
        if (eastmoney.actualNav != null && yesterdayNav != null && eastmoney.actualNav !== yesterdayNav) {
          todayProfitAmount = (eastmoney.actualNav - yesterdayNav) * h.shares;
          todayChangeRate = eastmoney.actualChangeRate || 0;
        } else if (tiantian.estimatedNav != null && yesterdayNav != null) {
          todayProfitAmount = (tiantian.estimatedNav - yesterdayNav) * h.shares;
          todayChangeRate = tiantian.estimatedChangeRate || 0;
        } else {
          todayChangeRate = eastmoney.actualChangeRate || 0;
        }

        totalYesterdayMarket += (yesterdayNav || currentNav) * h.shares;
        if (tiantian.estimateTime) updateTime = tiantian.estimateTime;
      } catch (e) {
        console.error(`获取基金 ${h.fundCode} 估值失败:`, e);
      }

      const costValue = h.buyPrice * h.shares;
      const marketValue = currentNav * h.shares;
      const totalReturn = h.holdingReturn || (marketValue - costValue);
      const totalReturnRate = costValue > 0 ? ((totalReturn / costValue) * 100) : 0;

      totalCost += costValue;
      totalMarket += marketValue;
      totalTodayProfit += todayProfitAmount;

      enriched.push({
        ...h,
        currentNav: currentNav.toFixed(4),
        marketValue: marketValue.toFixed(2),
        todayChangeRate: todayChangeRate.toFixed(2),
        todayProfit: todayProfitAmount.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
      });
    }

    const todayProfitRate = totalYesterdayMarket > 0 ? ((totalTodayProfit / totalYesterdayMarket) * 100) : 0;
    const totalReturn = totalMarket - totalCost;
    const totalReturnRate = totalCost > 0 ? ((totalReturn / totalCost) * 100) : 0;

    // 按当日收益金额倒序排序
    enriched.sort((a, b) => parseFloat(b.todayProfit) - parseFloat(a.todayProfit));

    return {
      code: 0,
      data: {
        holdings: enriched,
        totalAmount: totalMarket.toFixed(2),
        todayProfit: totalTodayProfit.toFixed(2),
        todayProfitRate: todayProfitRate.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        updateTime,
      },
    };
  } catch (e) {
    console.error("获取持仓失败:", e);
    return { code: 500, msg: "获取持仓失败" };
  }
};

function fetchTiantian(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, ""));
          resolve({
            fundCode: json.fundcode,
            fundName: json.name,
            nav: parseFloat(json.dwjz) || null,
            estimatedNav: parseFloat(json.gsz) || null,
            estimatedChangeRate: parseFloat(json.gszzl) || null,
            estimateTime: json.gztime || "",
          });
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", (e) => {
      console.error("天天基金请求失败:", e.message);
      resolve({});
    });
  });
}

function fetchEastMoney(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: "api.fund.eastmoney.com",
        path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`,
        headers: { "Referer": "https://fundf10.eastmoney.com/" },
      },
      (res) => {
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
          } catch (e) {
            console.error("东方财富解析失败:", e.message);
            resolve({});
          }
        });
      }
    );
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", (e) => {
      console.error("东方财富请求失败:", e.message);
      resolve({});
    });
  });
}
