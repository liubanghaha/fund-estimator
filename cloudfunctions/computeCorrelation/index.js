const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require("https");

exports.main = async (event) => {
  const { fundCodes } = event;
  if (!fundCodes || !Array.isArray(fundCodes) || fundCodes.length < 2) {
    return { code: 400, msg: "请提供至少2个基金代码" };
  }

  try {
    // 1. 并行获取每只基金的 1 年净值历史
    const allHistories = await Promise.all(fundCodes.map(code => fetchHistory(code, 250)));

    // 2. 对齐日期（找公共交易日）
    const dateSets = allHistories.map(h => new Set(h.map(d => d.date)));
    const commonDates = [...dateSets[0]].filter(d => dateSets.every(s => s.has(d))).sort();
    if (commonDates.length < 20) return { code: 0, data: { matrix: [], commonDates: commonDates.length, msg: "公共交易日不足" } };

    // 3. 计算每只基金的日收益率序列
    const returnSeries = allHistories.map(h => {
      const map = {};
      h.forEach(d => { map[d.date] = d.nav; });
      const returns = [];
      for (let i = 1; i < commonDates.length; i++) {
        const today = map[commonDates[i]], yesterday = map[commonDates[i - 1]];
        if (today > 0 && yesterday > 0) returns.push((today - yesterday) / yesterday);
        else returns.push(0);
      }
      return returns;
    });

    // 4. 两两计算 Pearson 相关系数
    const matrix = [];
    for (let i = 0; i < fundCodes.length; i++) {
      for (let j = i + 1; j < fundCodes.length; j++) {
        const r = pearson(returnSeries[i], returnSeries[j]);
        matrix.push({
          fundA: fundCodes[i],
          fundB: fundCodes[j],
          correlation: parseFloat(r.toFixed(3)),
        });
      }
    }

    return { code: 0, data: { matrix, commonDates: commonDates.length } };
  } catch (e) {
    console.error("相关性计算失败:", e.message);
    return { code: 500, msg: "计算失败" };
  }
};

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i];
    sxy += x[i] * y[i];
    sx2 += x[i] ** 2; sy2 += y[i] ** 2;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx ** 2) * (n * sy2 - sy ** 2));
  return den === 0 ? 0 : num / den;
}

async function fetchHistory(fundCode, totalNeeded) {
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
            resolve((json.Data.LSJZList || []).map(item => ({
              date: item.FSRQ,
              nav: parseFloat(item.DWJZ) || 0,
            })));
          } catch (e) { resolve([]); }
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve([]); });
      req.on("error", () => resolve([]));
    })
  );
  const results = await Promise.all(pageTasks);
  return results.flat();
}
