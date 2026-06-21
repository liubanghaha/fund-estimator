const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 定时任务：每日凌晨 3:00 计算所有持仓基金的估值温度
 *
 *  算法：
 *    每只股票独立打分 — 当前PE在自身历史 PE 区间的分位
 *    亏损股用 PB 替代、周期股加风险提示
 *    基金估值 = 持仓股估值按持仓占比的几何加权平均
 *    判定：< 0.7 低估 | 0.7~1.3 正常 | > 1.3 高估
 *
 *  流程：
 *    1. 获取持仓基金代码（去重）
 *    2. 并发拉取基金前十大持仓股
 *    3. 批量查询所有持仓股的 PE+PB+行业（行情接口） + 历史PE区间（估值接口）
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

    // 3. 收集所有唯一股票代码 & 批量查 PE+PB+行业（行情接口 + 历史PE接口）
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
      const [liveData, histData] = await Promise.all([
        batchFetchLiveData(codes),
        batchFetchHistoricalPE(codes),
      ]);
      // 合并数据
      codes.forEach(code => {
        const live = liveData[code] || {};
        const hist = histData[code] || {};
        stockMap[code] = {
          pe: live.pe || null,
          pb: live.pb || null,
          price: live.price || null,
          industry: live.industry || "其他",
          peHistory: hist.peYears || [],
          pbHistory: hist.pbYears || [],
          totalYears: hist.totalYears || 0,
        };
      });
    }

    const withHist = Object.values(stockMap).filter(s => s.totalYears > 0).length;
    console.log(`[computeFundTemperature] 有历史PE数据: ${withHist}/${codes.length}`);

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
        stocksWithData: c.stocksWithData,
        totalStocks: c.totalStocks,
        detailPEs: c.detailPEs,
        warnings: c.warnings || [],
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

async function batchFetchLiveData(codes) {
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
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f9,f12,f100,f164&secids=${secids}`;

    await new Promise((resolve) => {
      const req = https.get(url, { headers: { Referer: "https://quote.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const data = JSON.parse(body).data;
            if (data && data.diff) {
              data.diff.forEach(item => {
                const pe = item.f9;
                if (pe !== undefined && pe !== null) {
                  const actualPE = pe > 500 ? pe / 100 : pe;
                  const pb = item.f164 != null ? (+item.f164) : null;
                  map[item.f12] = {
                    pe: actualPE,
                    pb: pb && pb > 0 ? pb : null,
                    price: item.f2 || null,
                    industry: item.f100 || "其他",
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

async function batchFetchHistoricalPE(codes) {
  const https = require("https");
  const map = {};

  for (const code of codes) {
    await new Promise((resolve) => {
      const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_VALUE_ANALYSIS&columns=PEAVG,PEMAX,PEMIN,PBAVG,PBMAX,PBMIN&filter=(SECURITY_CODE=%22${code}%22)&pageSize=50&sortColumns=STARTDATE&sortTypes=1`;
      const req = https.get(url, { headers: { Referer: "https://data.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            const data = (d.result && d.result.data) || [];
            map[code] = {
              peYears: data.map(r => ({
                avg: +r.PEAVG, max: +r.PEMAX, min: +r.PEMIN,
              })).filter(r => r.avg > 0 && r.avg < 10000),
              pbYears: data.map(r => ({
                avg: +r.PBAVG, max: +r.PBMAX, min: +r.PBMIN,
              })).filter(r => r.avg > 0 && r.avg < 1000),
              totalYears: data.length,
            };
          } catch (e) { map[code] = { peYears: [], pbYears: [], totalYears: 0 }; }
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
 * 行业分类 → 估值逻辑
 */
function classifyIndustry(industry) {
  const cyc = ["煤炭","钢铁","有色","石油","化工","稀土","黄金","铜","铝","海运","造船","矿石","建材","水泥","玻璃"];
  const fin = ["银行","保险","证券","地产","房地产","多元金融"];
  const tech = ["半导体","芯片","软件","计算机","通信","电子","光模块","互联网","游戏","传媒"];
  const util = ["电力","水务","高速","公路","港口","铁路","燃气","环保"];
  const biomed = ["医药","生物","医疗","中药","化学制药","医疗器械"];
  const consume = ["白酒","食品","饮料","家电","汽车","服装","旅游","零售","免税","调味品","乳业","养殖"];
  const mfg = ["机械","电气","新能源","电池","军工","航天","船舶","仪器仪表","电力设备"];

  for (const kw of cyc) if (industry.includes(kw)) return "cycle";
  for (const kw of fin) if (industry.includes(kw)) return "finance";
  for (const kw of tech) if (industry.includes(kw)) return "tech";
  for (const kw of util) if (industry.includes(kw)) return "utility";
  for (const kw of biomed) if (industry.includes(kw)) return "biomed";
  for (const kw of consume) if (industry.includes(kw)) return "consume";
  for (const kw of mfg) if (industry.includes(kw)) return "mfg";
  return "other";
}

function computePEPercentile(currentPE, peYears) {
  if (!peYears || peYears.length < 3) return null;
  const avgs = peYears.map(y => y.avg).sort((a, b) => a - b);
  let below = 0;
  for (const a of avgs) { if (currentPE > a) below++; }
  return Math.round((below / avgs.length) * 100);
}

function getStockScore(pe, pePct, pb, pbPct, industryType) {
  // 1. 亏损股 / 负PE
  if (!pe || pe <= 0 || pe > 500) {
    if (pb && pb > 0 && pbPct != null) {
      return { score: pbPct < 25 ? 1.6 : pbPct < 65 ? 1.0 : 0.4, note: `PB${pbPct}%分位(PE无效)`, warn: false };
    }
    return { score: 1.0, note: "PE无效", warn: false };
  }

  // 2. 高PE绝对值 天花板限制
  if (pe > 80 && pePct != null) {
    return { score: 0.5, note: `PE${pe}倍·${pePct}%分位`, warn: false };
  }
  if (pe > 50 && pePct != null && pePct < 40) {
    return { score: 0.7, note: `PE${pe}倍偏高·${pePct}%分位`, warn: false };
  }

  // 3. 金融股：PE + PB 各半
  if (industryType === "finance" && pb && pb > 0 && pbPct != null) {
    const peS = pePct != null ? (pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5) : 1.0;
    const pbS = pbPct < 25 ? 1.5 : pbPct < 65 ? 1.0 : 0.5;
    return { score: +(peS * 0.5 + pbS * 0.5).toFixed(2), note: `PE${pePct}% PB${pbPct}%分位`, warn: false };
  }

  // 4. 周期股：PE 低位 + 警告
  if (industryType === "cycle" && pePct != null && pePct < 40) {
    return { score: pePct < 20 ? 1.4 : 1.0, note: `PE${pePct}%分位⚠️周期顶部`, warn: true };
  }

  // 5. 通用：PE 分位
  if (pePct != null) {
    return { score: pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5, note: `PE${pePct}%分位`, warn: false };
  }

  return { score: 1.0, note: "数据不足", warn: false };
}

/**
 * 计算基金估值信号（PE 历史分位 + 行业修正）
 *
 * 判定：
 *   PE 分位 < 30% → 低估（normPE < 0.7）
 *   30%-70% → 正常
 *   > 70% → 高估（normPE > 1.3）
 *
 * 行业修正：
 *   金融/银行 → 优先 PB 分位
 *   周期 → 仅 PE 分位，分位 < 30% 时加风险提示
 *   亏损股 → 仅 PB（如 PB 不可用则标注"PE无效"）
 */
function calcSignal(fundCode, holdings, stockMap) {
  const MIN_COVERAGE = 20;
  let totalRatio = 0, totalScore = 0, stocksWithData = 0, totalStocks = 0;
  const detailPEs = [];
  const warnings = [];

  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (!stock) return;
    totalStocks++;

    const pePct = stock.pe && stock.pe > 0 ? computePEPercentile(stock.pe, stock.peHistory) : null;
    const pbPct = stock.pb && stock.pb > 0 ? computePEPercentile(stock.pb, stock.pbHistory) : null;
    const iType = classifyIndustry(stock.industry || "");
    const sr = getStockScore(stock.pe, pePct, stock.pb, pbPct, iType);

    totalScore += sr.score * h.navRatio;
    totalRatio += h.navRatio;
    stocksWithData++;
    if (sr.warn) warnings.push(`${h.stockName}: ${sr.note}`);

    detailPEs.push({
      code: h.stockCode, name: h.stockName,
      pe: stock.pe ? +stock.pe.toFixed(2) : null,
      pb: stock.pb ? +stock.pb.toFixed(2) : null,
      industry: stock.industry, normPE: sr.score, ratio: h.navRatio, note: sr.note,
    });
  });

  if (totalRatio < MIN_COVERAGE) return null;
  if (stocksWithData === 0) {
    const wp = totalRatio > 0 ? +(totalRatio / totalRatio).toFixed(2) : 0;
    return { fundCode, signal: "nodata", label: "--", normPE: 0, weightedPE: wp, coverage: +totalRatio.toFixed(1), stocksWithData: 0, totalStocks, detailPEs, warnings };
  }

  const avgScore = +(totalScore / totalRatio).toFixed(3);
  const normPE = +(2.0 - avgScore).toFixed(3);

  let totalWeightedPE = 0;
  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (stock && stock.pe && stock.pe > 0) totalWeightedPE += stock.pe * h.navRatio;
  });
  const weightedPE = totalRatio > 0 ? +(totalWeightedPE / totalRatio).toFixed(2) : 0;

  let signal, label;
  // 阈值放宽：avgScore ∈ [0.5, 1.5], normPE ∈ [0.5, 1.5]
  // < 0.75 → 低估（avgScore > 1.25, 即组合里多数股票显著低估）
  // 0.75-1.25 → 正常
  // > 1.25 → 高估
  if (normPE < 0.75) { signal = "low"; label = "低估"; }
  else if (normPE > 1.25) { signal = "high"; label = "高估"; }
  else { signal = "mid"; label = "正常"; }

  if (warnings.length > 0) label += "⚠️";

  return { fundCode, signal, label, normPE, weightedPE, coverage: +totalRatio.toFixed(1), stocksWithData, totalStocks, detailPEs, warnings };
}
