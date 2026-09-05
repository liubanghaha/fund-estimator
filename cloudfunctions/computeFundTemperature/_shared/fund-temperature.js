/**
 * 云函数共享估值温度逻辑（单一数据源）。
 * 云函数独立部署，副本通过 scripts/sync-shared.js 同步进各函数目录，
 * 修改本文件后必须运行 npm run sync:shared。
 */
"use strict";

const https = require("https");
const http = require("http");

const MIN_COVERAGE = 20;

// ---------------- 行业分类 ----------------

/**
 * 行业 → 估值分类代码（打分用）
 */
function classifyIndustryCode(industry) {
  const cyc = ["煤炭", "钢铁", "有色", "石油", "化工", "稀土", "黄金", "铜", "铝", "海运", "造船", "矿石", "建材", "水泥", "玻璃"];
  const fin = ["银行", "保险", "证券", "地产", "房地产", "多元金融"];
  const tech = ["半导体", "芯片", "软件", "计算机", "通信", "电子", "光模块", "互联网", "游戏", "传媒"];
  const util = ["电力", "水务", "高速", "公路", "港口", "铁路", "燃气", "环保"];
  const biomed = ["医药", "生物", "医疗", "中药", "化学制药", "医疗器械"];
  const consume = ["白酒", "食品", "饮料", "家电", "汽车", "服装", "旅游", "零售", "免税", "调味品", "乳业", "养殖"];
  const mfg = ["机械", "电气", "新能源", "电池", "军工", "航天", "船舶", "仪器仪表", "电力设备"];

  for (const kw of cyc) if (industry.includes(kw)) return "cycle";
  for (const kw of fin) if (industry.includes(kw)) return "finance";
  for (const kw of tech) if (industry.includes(kw)) return "tech";
  for (const kw of util) if (industry.includes(kw)) return "utility";
  for (const kw of biomed) if (industry.includes(kw)) return "biomed";
  for (const kw of consume) if (industry.includes(kw)) return "consume";
  for (const kw of mfg) if (industry.includes(kw)) return "mfg";
  return "other";
}

/**
 * 行业 → 中文展示标签（资产配置用），「其他」时用股票名关键词兜底
 */
/**
 * 用户持仓行业聚合（getPortfolio 资产配置 与 fetchMarketOverview 持仓行业置顶 共用，保证两页同口径）。
 * 权重取持仓档案市值（缺失/为 0 回退 份额×档案净值），不依赖实时估值——
 * 否则估值缺失的基金被整只剔除，穿透会塌缩成个别基金的行业。
 * @param holdingsDocs 持仓文档数组（需含 fundCode/marketValue/shares/nav）
 * @param tempLatest { [fundCode]: 最新温度记录（需含 detailPEs） }
 * @returns { list: [{industry, raw 占比(已按行业权重归一)}], coverage: 行业明细覆盖的持仓市值占比 }
 */
function aggregateUserIndustries(holdingsDocs, tempLatest) {
  const industryMap = {};
  let totalWeight = 0;
  let totalValue = 0, coveredValue = 0;
  for (const h of holdingsDocs || []) {
    const shares = parseFloat(h.shares) || 0;
    const nav = parseFloat(h.nav) || 0;
    let fundValue = parseFloat(h.marketValue);
    if (!(fundValue > 0)) fundValue = shares * nav;
    if (!(fundValue > 0)) continue;
    totalValue += fundValue;
    const t = tempLatest && tempLatest[h.fundCode];
    if (!t || !t.detailPEs || !t.detailPEs.length) continue;
    coveredValue += fundValue;
    for (const pe of t.detailPEs) {
      const w = fundValue * ((parseFloat(pe.ratio)) || 0) / 100;
      const cat = classifyIndustryLabel(pe.industry, pe.name);
      industryMap[cat] = (industryMap[cat] || 0) + w;
      totalWeight += w;
    }
  }
  const list = Object.entries(industryMap)
    .map(([industry, w]) => ({ industry, raw: totalWeight > 0 ? (w / totalWeight) * 100 : 0 }))
    .sort((a, b) => b.raw - a.raw);
  return { list, coverage: totalValue > 0 ? +((coveredValue / totalValue) * 100).toFixed(1) : null };
}

function classifyIndustryLabel(industry, stockName) {
  if (industry && industry !== "其他" && industry !== "其它") {
    // 东财 2025 行业分类细化，二级名带 Ⅱ 后缀（白酒Ⅱ/银行Ⅱ/军工电子Ⅱ）；
    // 展示与东财板块名对齐时剥离，避免新旧两套名字并存导致穿透/匹配碎片化
    const stripped = industry.replace(/[ⅠⅡⅢ]+$/, "").trim();
    return stripped || industry;
  }
  const labels = { tech: "科技", biomed: "医药", consume: "消费", finance: "金融", cycle: "周期", utility: "公用事业", mfg: "制造" };
  const map = {
    tech: ["半导体", "芯片", "软件", "计算机", "通信", "电子", "光模块", "互联网", "游戏", "传媒", "元件", "IT", "信息", "数据", "智能", "科技"],
    biomed: ["医药", "生物", "医疗", "中药", "化学制药", "器械", "医"],
    consume: ["白酒", "食品", "饮料", "家电", "汽车", "服装", "旅游", "零售", "免税", "调味品", "乳业", "养殖", "消费", "农业", "牧原", "酒店", "餐饮", "美妆", "纺织"],
    finance: ["银行", "保险", "证券", "地产", "房地产", "金融", "信托", "期货", "基金"],
    cycle: ["煤炭", "钢铁", "有色", "石油", "化工", "稀土", "黄金", "铜", "铝", "海运", "造船", "矿石", "建材", "水泥", "玻璃", "金属", "纸", "化纤", "塑料", "橡胶", "化学"],
    utility: ["电力", "水务", "高速", "公路", "港口", "铁路", "燃气", "环保", "新能源发电", "电网", "核电", "水"],
    mfg: ["机械", "电气", "新能源", "电池", "军工", "航天", "船舶", "仪器仪表", "电力设备", "航空", "光伏", "风电", "通用设备", "专用设备", "电源", "装备", "重工", "锅炉", "电机", "自动化", "机器人", "电器"],
  };
  if (stockName) {
    for (const [cat, keywords] of Object.entries(map)) {
      for (const kw of keywords) {
        if (stockName.includes(kw)) return labels[cat];
      }
    }
  }
  return "其他";
}

function isETFByName(fundName) {
  return /ETF|交易型开放式|指数/.test(fundName || "");
}

// ---------------- PE 分位与打分 ----------------

function computePEPercentile(current, arr) {
  if (!arr || arr.length < 3) return null;
  const avgs = arr.map(y => y.avg).sort((a, b) => a - b);
  let below = 0;
  for (const a of avgs) {
    if (current > a) below++;
  }
  return Math.round((below / avgs.length) * 100);
}

function getStockScore(pe, pePct, pb, pbPct, industryType) {
  if (!pe || pe <= 0 || pe > 500) {
    if (pb && pb > 0 && pbPct != null) {
      return { score: pbPct < 25 ? 1.6 : pbPct < 65 ? 1.0 : 0.4, note: `PB${pbPct}%分位(PE无效)`, warn: false };
    }
    return { score: 1.0, note: "PE无效", warn: false };
  }

  if (pe > 80 && pePct != null) {
    return { score: 0.5, note: `PE${pe}倍·${pePct}%分位`, warn: false };
  }
  if (pe > 50 && pePct != null && pePct < 40) {
    return { score: 0.7, note: `PE${pe}倍偏高·${pePct}%分位`, warn: false };
  }

  if (industryType === "finance" && pb && pb > 0 && pbPct != null) {
    const peS = pePct != null ? (pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5) : 1.0;
    const pbS = pbPct < 25 ? 1.5 : pbPct < 65 ? 1.0 : 0.5;
    return { score: +(peS * 0.5 + pbS * 0.5).toFixed(2), note: `PE${pePct}% PB${pbPct}%分位`, warn: false };
  }

  if (industryType === "cycle" && pePct != null && pePct < 40) {
    return { score: pePct < 20 ? 1.4 : 1.0, note: `PE${pePct}%分位⚠️周期顶部`, warn: true };
  }

  if (pePct != null) {
    return { score: pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5, note: `PE${pePct}%分位`, warn: false };
  }

  return { score: 1.0, note: "数据不足", warn: false };
}

/**
 * 计算基金估值信号（统一阈值：normPE < 0.75 低估 / > 1.25 高估）
 * stockMap: { [stockCode]: { pe, pb, price, industry, peHistory, pbHistory, totalYears } }
 */
function calcSignal(fundCode, holdings, stockMap) {
  let totalRatio = 0;
  let totalScore = 0;
  let stocksWithData = 0;
  let totalStocks = 0;
  const detailPEs = [];
  const warnings = [];

  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (!stock) return;
    totalStocks++;

    const pePct = stock.pe && stock.pe > 0 ? computePEPercentile(stock.pe, stock.peHistory) : null;
    const pbPct = stock.pb && stock.pb > 0 ? computePEPercentile(stock.pb, stock.pbHistory) : null;
    const iType = classifyIndustryCode(stock.industry || "");
    const sr = getStockScore(stock.pe, pePct, stock.pb, pbPct, iType);

    totalScore += sr.score * h.navRatio;
    totalRatio += h.navRatio;
    stocksWithData++;
    if (sr.warn) warnings.push(`${h.stockName}: ${sr.note}`);

    detailPEs.push({
      code: h.stockCode,
      name: h.stockName,
      pe: stock.pe ? +stock.pe.toFixed(2) : null,
      pb: stock.pb ? +stock.pb.toFixed(2) : null,
      industry: stock.industry,
      normPE: sr.score,
      ratio: h.navRatio,
      note: sr.note,
    });
  });

  if (totalRatio < MIN_COVERAGE) return null;
  if (stocksWithData === 0) {
    return {
      fundCode,
      signal: "nodata",
      label: "--",
      normPE: 0,
      weightedPE: 0,
      coverage: +totalRatio.toFixed(1),
      stocksWithData: 0,
      totalStocks,
      detailPEs,
      warnings,
    };
  }

  const avgScore = +(totalScore / totalRatio).toFixed(3);
  const normPE = +(2.0 - avgScore).toFixed(3);

  let totalWeightedPE = 0;
  holdings.forEach(h => {
    const stock = stockMap[h.stockCode];
    if (stock && stock.pe && stock.pe > 0) totalWeightedPE += stock.pe * h.navRatio;
  });
  const weightedPE = totalRatio > 0 ? +(totalWeightedPE / totalRatio).toFixed(2) : 0;

  let signal = "mid";
  let label = "温度适中";
  if (normPE < 0.75) {
    signal = "low";
    label = "温度偏低";
  } else if (normPE > 1.25) {
    signal = "high";
    label = "温度偏高";
  }
  if (warnings.length > 0) label += "⚠️";

  return {
    fundCode,
    signal,
    label,
    normPE,
    weightedPE,
    coverage: +totalRatio.toFixed(1),
    stocksWithData,
    totalStocks,
    detailPEs,
    warnings,
  };
}

// ---------------- 实时 PE/PB 与历史分位 ----------------

function _buildSecid(code) {
  if (code.length === 5) return `116.${code}`;
  if (code.startsWith("6")) return `1.${code}`;
  return `0.${code}`;
}

async function _fetchLiveEastMoney(codes, timeoutMs) {
  const map = {};
  const BATCH = 40;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const secids = batch.map(_buildSecid).join(",");
    // ⚠️ 2026-09-04 起该接口无 ut 令牌返回空（同 clist），必须带 ut；push2 对云函数出口偶发限流 → 主站失败走 delay 镜像
    const q = `fltt=2&fields=f2,f9,f12,f100,f164&secids=${secids}&ut=bd1d9ddb04089700cf9c27f6f7426281`;
    const fetchBody = (host) => new Promise((resolve) => {
      const req = https.get(`https://${host}/api/qt/ulist.np/get?${q}`, { headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve(body));
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(""); });
      req.on("error", () => resolve(""));
    });
    let body = await fetchBody("push2.eastmoney.com");
    if (!body || body.length < 10) body = await fetchBody("push2delay.eastmoney.com");
    await new Promise((resolve) => {
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
  }
  return map;
}

async function _fetchLiveTencent(codes, timeoutMs) {
  const map = {};
  const BATCH = 20;
  const toQtCode = (code) => {
    if (code.length === 5) return `hk${code}`;
    if (code.startsWith("6")) return `sh${code}`;
    return `sz${code}`;
  };
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const qtCodes = batch.map(toQtCode).join(",");
    const url = `http://qt.gtimg.cn/q=${qtCodes}`;
    await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => { chunks.push(c); });
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            for (const code of batch) {
              const qtCode = toQtCode(code);
              const re = new RegExp(`v_${qtCode}="([^"]*)"`);
              const match = body.match(re);
              if (!match) continue;
              const fields = match[1].split("~");
              const pe = parseFloat(fields[39]) || null;
              const pb = parseFloat(fields[46]) || null;
              const price = parseFloat(fields[3]) || null;
              if (pe || pb || price) {
                map[code] = {
                  pe: pe && pe > 0 ? pe : null,
                  pb: pb && pb > 0 ? pb : null,
                  price,
                  industry: "其他",
                };
              }
            }
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

/**
 * 批量拉取实时 PE/PB/行业：东财为主，覆盖率不足时重试 + 腾讯兜底
 */
async function fetchStockLiveBatch(codes, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  let map = await _fetchLiveEastMoney(codes, timeoutMs);
  let withPE = Object.values(map).filter(s => s.pe != null).length;

  if (withPE < codes.length * 0.5) {
    await new Promise(r => setTimeout(r, 1000));
    const missed = codes.filter(c => !map[c] || map[c].pe == null);
    const retryMap = await _fetchLiveEastMoney(missed, timeoutMs);
    for (const [code, data] of Object.entries(retryMap)) {
      if (!map[code] || map[code].pe == null) map[code] = data;
    }
    withPE = Object.values(map).filter(s => s.pe != null).length;
  }

  const missedCodes = codes.filter(c => !map[c] || map[c].pe == null);
  if (missedCodes.length > 0) {
    const tencentMap = await _fetchLiveTencent(missedCodes, timeoutMs);
    for (const [code, data] of Object.entries(tencentMap)) {
      if (!map[code] || map[code].pe == null) map[code] = data;
    }
  }
  return map;
}

/**
 * 批量拉取历史 PE/PB 区间（限并发 15/批）
 */
async function fetchStockHistBatch(codes, opts = {}) {
  const { timeoutMs = 10000, concurrent = 15 } = opts;
  const map = {};

  const fetchOne = (code) => new Promise((resolve) => {
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
              avg: +r.PEAVG,
              max: +r.PEMAX,
              min: +r.PEMIN,
            })).filter(r => r.avg > 0 && r.avg < 10000),
            pbYears: data.map(r => ({
              avg: +r.PBAVG,
              max: +r.PBMAX,
              min: +r.PBMIN,
            })).filter(r => r.avg > 0 && r.avg < 1000),
            totalYears: data.length,
          };
        } catch (e) {
          map[code] = { peYears: [], pbYears: [], totalYears: 0 };
        }
        resolve();
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });

  for (let i = 0; i < codes.length; i += concurrent) {
    const batch = codes.slice(i, i + concurrent);
    await Promise.all(batch.map(fetchOne));
    if (i + concurrent < codes.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return map;
}

module.exports = {
  classifyIndustryCode,
  classifyIndustryLabel,
  isETFByName,
  computePEPercentile,
  getStockScore,
  calcSignal,
  fetchStockLiveBatch,
  fetchStockHistBatch,
  // 兼容 DB 旧数据：把历史版本写入的定性词映射为测量词（合规整改）
  sanitizeLabel(label) {
    if (!label) return label;
    return String(label)
      .replace(/低估/g, "温度偏低")
      .replace(/高估/g, "温度偏高")
      .replace(/正常/g, "温度适中");
  },
  aggregateUserIndustries,
};
