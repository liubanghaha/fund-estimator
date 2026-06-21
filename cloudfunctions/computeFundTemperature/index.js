const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 定时任务：每日凌晨 3:00 计算所有持仓基金的估值温度
 *
 *  算法：
 *    每只股票独立打分 — 现价在自身 52周高低价区间的位置
 *    基金估值 = 持仓股估值按持仓占比的几何加权平均
 *    判定：< 0.7 低估 | 0.7~1.3 正常 | > 1.3 高估
 *
 *  流程：
 *    1. 获取持仓基金代码（去重）
 *    2. 并发拉取基金前十大持仓股
 *    3. 批量查询所有持仓股的 PE + 行业 + 52周高低价
 *    4. 每只股票打分 → 基金加权汇总 → 写入 fund_temperatures
 */
exports.main = async (event) => {
  const today = formatDate(new Date());
  console.log(`[computeFundTemperature] 开始计算 ${today}`);

  try {
    // 1. 获取所有持仓的基金代码（去重）
    const fundCodes = await getUniqueFundCodes();
    console.log(`[computeFundTemperature] 持仓基金数: ${fundCodes.length}`);
    if (fundCodes.length === 0) return { code: 0, msg: "无持仓基金" };

    // 2. 并发拉取持仓股（限制并发数 10，防止限流）
    const fundHoldings = {};
    let fetchFailCount = 0;
    const CONCURRENT = 10;
    for (let i = 0; i < fundCodes.length; i += CONCURRENT) {
      const batch = fundCodes.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (fundCode) => {
        try {
          const holdings = await fetchHoldings(fundCode);
          return { fundCode, holdings, ok: holdings.length > 0 };
        } catch (e) { return { fundCode, holdings: [], ok: false }; }
      }));
      for (const r of results) {
        if (r.ok) fundHoldings[r.fundCode] = r.holdings;
        else fetchFailCount++;
      }
      if (i + CONCURRENT < fundCodes.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.log(`[computeFundTemperature] 有持仓数据的基金: ${Object.keys(fundHoldings).length}, 拉取失败: ${fetchFailCount}`);

    // 持仓数据不足半数时从昨日温度数据恢复
    if (Object.keys(fundHoldings).length < fundCodes.length * 0.5) {
      console.log(`[computeFundTemperature] 持仓数据不足 (${Object.keys(fundHoldings).length}/${fundCodes.length})，尝试从昨日温度数据恢复`);
      try {
        const recovered = await recoverHoldingsFromHistory(fundCodes);
        if (Object.keys(recovered).length > Object.keys(fundHoldings).length) {
          Object.assign(fundHoldings, recovered);
          console.log(`[computeFundTemperature] 从历史恢复 ${Object.keys(recovered).length} 只基金持仓`);
        }
      } catch (e) {
        console.error("[computeFundTemperature] 从历史恢复失败:", e.message);
      }
    }

    // 3. 收集所有唯一股票代码 & 批量查 PE + 行业 + 52周高低价
    const stockMap = {};
    const allStockCodes = new Set();
    Object.values(fundHoldings).forEach(list => {
      list.forEach(h => {
        if (h.stockCode && (h.stockCode.length === 6 || h.stockCode.length === 5)) {
          allStockCodes.add(h.stockCode);
        }
      });
    });
    const codes = [...allStockCodes];
    console.log(`[computeFundTemperature] 持仓股去重数: ${codes.length}`);

    if (codes.length > 0) {
      const peData = await batchFetchPE(codes);
      Object.assign(stockMap, peData);
    }

    const with52 = Object.values(stockMap).filter(s => s.high52w).length;
    console.log(`[computeFundTemperature] 有52周数据: ${with52}/${codes.length}`);

    // 4. 计算估值信号
    const candidates = [];
    for (const [fundCode, holdings] of Object.entries(fundHoldings)) {
      const result = calcSignal(fundCode, holdings, stockMap);
      if (result) candidates.push(result);
    }

    // 5. 批量写入 DB
    const results = [];
    for (const c of candidates) {
      results.push({
        fundCode: c.fundCode,
        date: today,
        signal: c.signal,
        label: c.label,
        normPE: c.normPE,
        weightedPE: c.weightedPE,
        coverage: c.coverage,
        stocksWith52w: c.stocksWith52w,
        totalStocks: c.totalStocks,
        detailPEs: c.detailPEs,
        createTime: new Date(),
      });
    }

    if (results.length > 0) {
      // 批量删除今日旧数据
      const allCodes = results.map(r => r.fundCode);
      for (let i = 0; i < allCodes.length; i += 100) {
        const batch = allCodes.slice(i, i + 100);
        await db.collection("fund_temperatures")
          .where({ fundCode: _.in(batch), date: today })
          .remove()
          .catch(() => {});
      }
      // 批量写入
      for (let i = 0; i < results.length; i += 50) {
        const batch = results.slice(i, i + 50);
        await Promise.all(batch.map(r =>
          db.collection("fund_temperatures").add({ data: r }).catch(() => {})
        ));
      }
    }

    const dist = { low: 0, mid: 0, high: 0, nodata: 0 };
    results.forEach(r => { dist[r.signal] = (dist[r.signal] || 0) + 1; });
    console.log(`[computeFundTemperature] 完成 ${results.length} 只 (低估:${dist.low} 正常:${dist.mid} 高估:${dist.high} 无数据:${dist.nodata})`);
    return { code: 0, data: { count: results.length, date: today, signalDist: dist } };
  } catch (e) {
    console.error("[computeFundTemperature] 异常:", e);
    return { code: 500, msg: e.message };
  }
};

// ---- helpers ----

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getUniqueFundCodes() {
  const MAX_LIMIT = 100;
  const all = [];
  let done = false;
  while (!done) {
    const res = await db.collection("holdings")
      .field({ fundCode: true })
      .limit(MAX_LIMIT)
      .skip(all.length)
      .get();
    if (res.data.length === 0) { done = true; break; }
    all.push(...res.data);
    if (res.data.length < MAX_LIMIT) done = true;
  }
  return [...new Set(all.map(h => h.fundCode))];
}

async function recoverHoldingsFromHistory(fundCodes) {
  const holdings = {};
  // 往前尝试最近 3 天
  for (let d = 1; d <= 3; d++) {
    const targetDate = formatDate(new Date(Date.now() - d * 86400000));
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length; i += BATCH) {
      const batch = fundCodes.slice(i, i + BATCH);
      const res = await db.collection("fund_temperatures")
        .where({ fundCode: _.in(batch), date: targetDate })
        .get();
      (res.data || []).forEach(t => {
        if (t.detailPEs && t.detailPEs.length > 0 && !holdings[t.fundCode]) {
          holdings[t.fundCode] = t.detailPEs.map(p => ({
            stockCode: p.code,
            stockName: p.name,
            navRatio: p.ratio,
          }));
        }
      });
    }
    if (Object.keys(holdings).length > 0) break; // 找到数据就停
  }
  return holdings;
}

function fetchHoldings(fundCode) {
  const https = require("https");
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3, curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
    if (i === 0) { curY = year - 1; curM = 12; }
  }

  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=${curY}&month=${curM}&rt=${Math.random()}`;
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
            if (tds.length >= 7 && !tds[0].includes("*")) {
              const n = tds.length;
              rows.push({
                rank: tds[0],
                stockCode: tds[1],
                stockName: tds[2],
                navRatio: parseFloat(tds[n - 3]) || 0,
                shares: tds[n - 2],
                marketValue: tds[n - 1],
              });
            }
          }
          resolve(rows);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

async function batchFetchPE(codes) {
  const https = require("https");
  const map = {};
  const BATCH = 40;

  const buildSecid = (code) => {
    if (code.length === 5) return `116.${code}`;
    if (code.startsWith("6")) return `1.${code}`;
    return `0.${code}`;
  };

  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const secids = batch.map(buildSecid).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f9,f12,f100,f350,f351&secids=${secids}`;

    await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { Referer: "https://quote.eastmoney.com/" },
      }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const data = JSON.parse(body).data;
            if (data && data.diff) {
              data.diff.forEach(item => {
                const pe = item.f9;
                if (pe && pe > 0) {
                  const actualPE = pe > 500 ? pe / 100 : pe;
                  let high52w = null, low52w = null;
                  if (item.f350 > 0 && item.f351 > 0 && item.f350 < 1e6) {
                    high52w = +item.f350;
                    low52w = +item.f351;
                  }
                  map[item.f12] = {
                    pe: actualPE,
                    price: item.f2 || null,
                    industry: item.f100 || "其他",
                    high52w,
                    low52w,
                  };
                }
              });
            }
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

/**
 * 计算基金估值信号（单一维度：52周价格位置）
 *
 * 每只股票独立打分：
 *   normPE = (现价 - 52周最低) / (52周最高 - 52周最低) × 2
 *   0 = 52周最低点, 2 = 52周最高点
 *
 * 基金估值 = exp( Σ(ln(clamp(normPE, 0.25, 4.0)) × 持仓占比) / Σ(持仓占比) )
 *
 * 判定：
 *   < 0.7 → 低估    0.7 ~ 1.3 → 正常    > 1.3 → 高估
 *   持仓占比 < 20% → 跳过
 *   全部持仓无52周数据 → 无数据
 */
function calcSignal(fundCode, holdings, stockMap) {
  const MIN_NORM = 0.25;
  const MAX_NORM = 4.0;
  const MIN_COVERAGE = 20;

  let totalRatio = 0;
  let totalLogNormPE = 0;
  let stocksWith52w = 0;
  let totalStocks = 0;
  const detailPEs = [];

  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (!stock || !stock.pe || stock.pe <= 0) return;
    totalStocks++;

    let rawNormPE;
    if (stock.high52w && stock.low52w && stock.price && stock.high52w > stock.low52w) {
      const pos = (stock.price - stock.low52w) / (stock.high52w - stock.low52w);
      rawNormPE = +(pos * 2).toFixed(3);
      stocksWith52w++;
    } else {
      rawNormPE = 1.0;
    }

    const normPE = +Math.max(MIN_NORM, Math.min(MAX_NORM, rawNormPE)).toFixed(3);
    totalLogNormPE += Math.log(normPE) * h.navRatio;
    totalRatio += h.navRatio;

    detailPEs.push({
      code: h.stockCode,
      name: h.stockName,
      pe: +stock.pe.toFixed(2),
      industry: stock.industry,
      normPE,
      ratio: h.navRatio,
    });
  });

  if (totalRatio < MIN_COVERAGE) {
    console.log(`[computeFundTemperature] ${fundCode} 持仓股占比仅 ${totalRatio}%，低于${MIN_COVERAGE}%阈值，跳过`);
    return null;
  }

  // 全部无52周数据 → 标记为无数据
  if (stocksWith52w === 0 && totalStocks > 0) {
    let totalPE = 0;
    holdings.forEach(h => {
      const stock = stockMap[h.stockCode];
      if (stock && stock.pe > 0) totalPE += stock.pe * h.navRatio;
    });
    const wp = totalRatio > 0 ? +(totalPE / totalRatio).toFixed(2) : 0;
    return {
      fundCode,
      signal: "nodata",
      label: "--",
      normPE: 0,
      weightedPE: wp,
      coverage: +totalRatio.toFixed(1),
      stocksWith52w: 0,
      totalStocks,
      detailPEs,
    };
  }

  const normPE = +(Math.exp(totalLogNormPE / totalRatio)).toFixed(3);

  let totalWeightedPE = 0;
  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (stock && stock.pe > 0) totalWeightedPE += stock.pe * h.navRatio;
  });
  const weightedPE = totalRatio > 0 ? +(totalWeightedPE / totalRatio).toFixed(2) : 0;

  let signal, label;
  if (normPE < 0.7) { signal = "low"; label = "低估"; }
  else if (normPE > 1.3) { signal = "high"; label = "高估"; }
  else { signal = "mid"; label = "正常"; }

  return {
    fundCode,
    signal,
    label,
    normPE,
    weightedPE,
    coverage: +totalRatio.toFixed(1),
    stocksWith52w,
    totalStocks,
    detailPEs,
  };
}
