/**
 * 云函数共享数据层（单一数据源）。
 * 云函数独立部署，副本通过 scripts/sync-shared.js 同步进各函数目录，
 * 修改本文件后必须运行 npm run sync:shared。
 */
"use strict";

const https = require("https");

// ---------------- 北京时间工具 ----------------

// 返回一个 UTC 字段等于北京壁钟时间的 Date 对象
function _bjDate(date) {
  const d = date instanceof Date ? date : new Date();
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 8 * 3600000);
}

function formatBJDate(date) {
  const d = _bjDate(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function formatBJTime(date) {
  const d = _bjDate(date);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function isBJWeekday(date) {
  const d = _bjDate(date);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * 最近已发布季报的年份/月份（1-3月→上年12月，4-6月→3月，7-9月→6月，10-12月→9月）
 */
function getQuarterParams(date) {
  const d = _bjDate(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3;
  let curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) {
      curM = pubMonths[i];
      break;
    }
    if (i === 0) {
      curY = year - 1;
      curM = 12;
    }
  }
  return { year: curY, month: curM };
}

// ---------------- 东方财富基金持仓 ----------------

// 从表头 th 中定位「占净值比例」列索引（列数随基金类型/季度变化：
// 实测 7 列（无最新价/涨跌幅）与 9 列（有）两种，n-3 恰好都指向占比列，
// 但列数再变时固定下标会取错列 → 以表头列名为准，找不到时回退 n-3）
// 注意：必须传入单张表的 HTML——东财 jjcc 一次返回该年多张季度表，
// 各表列数不同（占比列分别在 6 / 4），沿用第一张表的列下标去读后续表会整体错位
function _findRatioColIndex(tableHtml) {
  const thead = tableHtml.match(/<thead[\s\S]*?<\/thead>/);
  if (!thead) return -1;
  const ths = thead[0].match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [];
  for (let i = 0; i < ths.length; i++) {
    const text = ths[i].replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    if (text.indexOf("占净值") !== -1) return i;
  }
  return -1;
}

function _parseHoldingsHtml(body, withMeta) {
  const match = body.match(/content:"([^"]+)"/);
  if (!match) {
    return withMeta ? { holdings: [], fundName: "" } : [];
  }
  const html = match[1].replace(/\\"/g, '"');
  const nameMatch = html.match(/<a title='([^']*)'/);
  const fundName = nameMatch ? nameMatch[1] : "";

  // 东财 jjcc 带 year 参数会返回该年全部季度的持仓表（005660 返回 2026Q2 + 2026Q1 两张），
  // 而且各表列数不同：9 列（含最新价/涨跌幅）占比在第 6 列，7 列的占比在第 4 列、第 6 列是
  // 「持仓市值（万元）」。此前只认全文第一个 thead 的列下标，导致：
  //   ① 上一季度表按第 6 列读，读到持仓市值，parseFloat("24,036.32") 在千分位逗号处截断成 24
  //   ② 两个季度的持仓混在一起加权（005660 占比合计 249%），旧持仓稀释当期口径
  // 估算只需最新一期持仓 → 取第一张含「占净值」表头的表（即最新季度），并用它自己的表头定列。
  const tableRe = /<table[\s\S]*?<\/table>/g;
  let tm, mainTable = null;
  while ((tm = tableRe.exec(html)) !== null) {
    if (_findRatioColIndex(tm[0]) !== -1) { mainTable = tm[0]; break; }
  }
  // 表结构意外变化时不比现状更差：退回全文解析，交给 n-3 兜底
  if (!mainTable) mainTable = html;

  const ratioCol = _findRatioColIndex(mainTable);
  const rows = [];
  const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(mainTable)) !== null) {
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (tds.length >= 7 && tds.length <= 10 && !tds[0].includes("*")) {
      const n = tds.length;
      const col = ratioCol >= 1 && ratioCol < n ? ratioCol : n - 3;
      const ratio = parseFloat(tds[col]) || 0;
      if (ratio > 0 && ratio <= 100) {
        rows.push({
          stockCode: tds[1],
          stockName: tds[2],
          navRatio: ratio,
        });
      }
    }
  }
  return withMeta ? { holdings: rows, fundName } : rows;
}

// 持仓占比合计校验：单季度披露的「占净值比例」合计不可能超过 100%。
// 早期解析把同一次年月响应里上一季度的表按错列读成「持仓市值（万元）」（parseFloat 在千分位
// 逗号处截断成 24 这类值）并与当季混合，合计可达 200%+。这类历史脏数据会让加权口径失真，
// 必须判为不可用并触发重新拉取——否则非季报窗口期会一直复用自己写下的脏缓存，污染长期驻留
// （computeFundTemperature 的 getCachedHoldings 正是读自家 detailPEs）。
// 阈值留 0.5 容忍百分号四舍五入。
function isValidHoldings(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  let sum = 0;
  for (const h of list) {
    const v = Number(h && (h.navRatio != null ? h.navRatio : h.ratio));
    sum += isFinite(v) ? v : 0;
  }
  return sum > 0 && sum <= 100.5;
}

/**
 * 拉取基金持仓股列表（东方财富 FundArchivesDatas）
 */
function fetchTempHoldings(fundCode, opts = {}) {
  const { topline = 100, timeoutMs = 8000 } = opts;
  const { year, month } = getQuarterParams();
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=${topline}&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve(_parseHoldingsHtml(body, false));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

/**
 * 拉取基金持仓股列表 + 基金名称（温度计算需要名称判断 ETF）
 */
function fetchTempHoldingsWithMeta(fundCode, opts = {}) {
  const { topline = 20, timeoutMs = 8000 } = opts;
  const { year, month } = getQuarterParams();
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=${topline}&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve(_parseHoldingsHtml(body, true));
        } catch (e) {
          resolve({ holdings: [], fundName: "" });
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ holdings: [], fundName: "" }); });
    req.on("error", () => resolve({ holdings: [], fundName: "" }));
  });
}

/**
 * ETF 联接穿透：持仓主体是 ETF 份额时，穿透到 ETF 的持仓股
 */
async function fetchTempHoldingsDeep(fundCode, opts = {}) {
  const holdings = await fetchTempHoldings(fundCode, opts);
  if (!holdings || holdings.length === 0) return [];
  const isEtfCode = (code) => /^(1\d{4}|5\d{4}|159\d{3}|51\d{4}|56\d{4}|58\d{4})$/.test(code);
  const etfCodes = holdings.filter(h => h.stockCode && isEtfCode(h.stockCode)).map(h => h.stockCode);
  if (etfCodes.length > 0 && etfCodes.length >= holdings.length * 0.3) {
    const etfHoldings = await fetchTempHoldings(etfCodes[0], opts);
    if (etfHoldings && etfHoldings.length > 0) return etfHoldings;
  }
  return holdings;
}

// ---------------- 腾讯实时行情 ----------------

/**
 * 批量拉取腾讯全球股票行情（A股/港股/美股）
 * 返回 { [code]: { price, prevClose, changeRate } }
 */
function fetchStockPricesTencent(codes, opts = {}) {
  const map = {};
  if (!codes || codes.length === 0) return Promise.resolve(map);
  const { timeoutMs = 10000, batchSize = 50 } = opts;

  const toQtCode = (code) => {
    const c = String(code).trim().toUpperCase();
    // 字母 ticker 优先（如 5 位美股 GOOGL，避免被误判为港股）
    if (/^[A-Z]/.test(c) && c.length <= 5) return `us${c}`;
    if (/^\d{5}$/.test(c)) return `hk${c}`;
    if (c.startsWith("6") || c.startsWith("5") || c.startsWith("688")) return `sh${c}`;
    return `sz${c}`;
  };

  const fetchBatch = (batchCodes) => new Promise((resolve) => {
    const qtCodes = batchCodes.map(toQtCode).join(",");
    const req = https.get(`https://qt.gtimg.cn/q=${qtCodes}`, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          for (const code of batchCodes) {
            const qtCode = toQtCode(code);
            const re = new RegExp(`v_${qtCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`);
            const match = body.match(re);
            if (!match) continue;
            const fields = match[1].split("~");
            if (fields.length < 5) continue;
            const curr = parseFloat(fields[3]);
            const prev = parseFloat(fields[4]);
            if (!isNaN(prev) && !isNaN(curr) && prev > 0) {
              map[code] = {
                price: curr,
                prevClose: prev,
                changeRate: +(((curr - prev) / prev) * 100).toFixed(2),
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

  return (async () => {
    for (let i = 0; i < codes.length; i += batchSize) {
      await fetchBatch(codes.slice(i, i + batchSize));
    }
    return map;
  })();
}

// ---------------- 东方财富基金净值 ----------------

/**
 * 最新净值（含昨日净值，供估算兜底）
 * 东财 lsjz 不收录 968 互认基金（实测 TotalCount:0），空结果时自动兜底
 * FundMNFInfo 接口（T+1 公布，仅有最新净值+涨跌幅，无昨日净值/盘中估算）
 */
function fetchLatestNavEastMoney(fundCode, opts = {}) {
  const { pageSize = 2, timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=${pageSize}`,
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
          const list = (json.Data && json.Data.LSJZList) || [];
          const today = list[0] || {};
          const yesterday = list[1] || {};
          resolve({
            actualNav: parseFloat(today.DWJZ) || null,
            actualDate: today.FSRQ || "",
            actualChangeRate: parseFloat(today.JZZZL) || null,
            yesterdayNav: parseFloat(yesterday.DWJZ) || null,
          });
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  }).then((r) => {
    // 东财无数据（968 互认基金等）→ FundMNFInfo 兜底
    if (r && (r.actualNav == null || r.actualNav <= 0)) {
      return fetchLatestNavMNF(fundCode, opts);
    }
    return r;
  });
}

/**
 * 互认基金（968xxx）最新净值兜底：FundMNFInfo 接口
 * 返回结构与 fetchLatestNavEastMoney 对齐；T+1 公布、无昨日净值/盘中估算
 */
function fetchLatestNavMNF(fundCode, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "fundmobapi.eastmoney.com",
      path: `/FundMNewApi/FundMNFInfo?Fcodes=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`,
      headers: { Referer: "https://m.fund.eastmoney.com/" },
    }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const d = (JSON.parse(body).Datas || [])[0] || {};
          const nav = parseFloat(d.NAV) || null;
          resolve({
            actualNav: nav,
            actualDate: d.PDATE || "",
            actualChangeRate: d.NAVCHGRT != null ? parseFloat(d.NAVCHGRT) : null,
            yesterdayNav: null,
            isMNF: true,
          });
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}

// ---------------- 指数基金跟踪指数（INDEXCODE） ----------------

/**
 * 调东财基金详情接口，返回该基金的跟踪指数信息。
 * 任意指数基金都能拿到官方 INDEXCODE（如沪深300→000300、中证白酒→399997），
 * 从而无需手工维护"行业→指数"映射表，行业天然全覆盖。
 * 返回 { indexCode, indexName, fundType } | null；非指数基金 INDEXCODE 为空。
 */
function fetchTrackIndex(fundCode, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "fundmobapi.eastmoney.com",
      path: `/FundMNewApi/FundMNDetailInformation?FCODE=${fundCode}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`,
      headers: { Referer: "https://m.fund.eastmoney.com/" },
    }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const d = (JSON.parse(body).Datas) || {};
          const indexCode = (d.INDEXCODE || "").trim();
          if (!indexCode || !/^\d{6}$/.test(indexCode)) return resolve(null);
          resolve({
            indexCode,
            indexName: (d.INDEXNAME || "").trim(),
            fundType: (d.FTYPE || "").trim(),
          });
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/**
 * 判断指数代码的行情市场前缀（腾讯行情用 sh/sz）。
 * A 股宽基/行业指数：39 开头为深市(sz，如 399006 创业板指、399997 中证白酒)，其余为沪市(sh)。
 */
function resolveIndexPrefix(indexCode) {
  const c = String(indexCode || "").trim();
  if (/^39\d{4}$/.test(c)) return "sz";
  return "sh";
}

/**
 * 拉指数实时涨跌幅（腾讯行情 qt.gtimg.cn），返回 { price, prevClose, changeRate } | null。
 * 与 fetchStockPricesTencent 同源（腾讯 qt.gtimg.cn），字段 [3]=现价 [4]=昨收。
 */
function fetchIndexRealtime(indexCode, opts = {}) {
  const { timeoutMs = 8000 } = opts;
  const prefix = resolveIndexPrefix(indexCode);
  const qtCode = `${prefix}${indexCode}`;
  return new Promise((resolve) => {
    const req = https.get(`https://qt.gtimg.cn/q=${qtCode}`, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          const re = new RegExp(`v_${qtCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`);
          const match = body.match(re);
          if (!match) return resolve(null);
          const fields = match[1].split("~");
          const curr = parseFloat(fields[3]);
          const prev = parseFloat(fields[4]);
          if (isNaN(curr) || isNaN(prev) || prev <= 0) return resolve(null);
          resolve({
            price: curr,
            prevClose: prev,
            changeRate: +(((curr - prev) / prev) * 100).toFixed(2),
          });
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/**
 * 批量拉指数实时涨跌（腾讯行情 qt.gtimg.cn 支持一次多只），
 * 返回 { [indexCode]: { price, prevClose, changeRate } }。
 * 解析口径与 fetchIndexRealtime 一致；批内未命中的 code（网络丢包等）
 * 由调用方按需走 fetchIndexRealtime 单拉兜底。
 */
function fetchIndexRealtimeBatch(indexCodes, opts = {}) {
  const map = {};
  const codes = [...new Set((indexCodes || []).filter(Boolean))];
  if (codes.length === 0) return Promise.resolve(map);
  const { timeoutMs = 8000, batchSize = 50 } = opts;

  const toQtCode = (code) => `${resolveIndexPrefix(code)}${code}`;

  const fetchBatch = (batch) => new Promise((resolve) => {
    const qtCodes = batch.map(toQtCode).join(",");
    const req = https.get(`https://qt.gtimg.cn/q=${qtCodes}`, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          for (const code of batch) {
            const qtCode = toQtCode(code);
            const re = new RegExp(`v_${qtCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`);
            const match = body.match(re);
            if (!match) continue;
            const fields = match[1].split("~");
            const curr = parseFloat(fields[3]);
            const prev = parseFloat(fields[4]);
            if (isNaN(curr) || isNaN(prev) || prev <= 0) continue;
            map[code] = {
              price: curr,
              prevClose: prev,
              changeRate: +(((curr - prev) / prev) * 100).toFixed(2),
            };
          }
        } catch (e) { /* ignore */ }
        resolve();
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });

  return (async () => {
    for (let i = 0; i < codes.length; i += batchSize) {
      await fetchBatch(codes.slice(i, i + batchSize));
    }
    return map;
  })();
}

// ---------------- 跟踪指数查询（带 fund_index_cache 缓存） ----------------

const INDEX_CACHE_COLLECTION = "fund_index_cache";

async function _indexCacheUpsert(db, fundCode, indexCode, indexName) {
  try {
    await db.collection(INDEX_CACHE_COLLECTION).doc(fundCode).set({
      data: { fundCode, indexCode: indexCode || "", indexName: indexName || "", updatedAt: Date.now() },
    });
  } catch (e) { /* 缓存写失败不影响主流程 */ }
}

/**
 * 批量获取跟踪指数（带 cache）：一次 `_.in` 查缓存，缺的调东财补上并写回。
 * 返回 map：{ [fundCode]: { indexCode, indexName, fundType } | null }
 * null 表示"非指数基金 / 查不到"，同样会被缓存（indexCode 空），避免反复查东财。
 */
async function getTrackIndexBatchCached(db, fundCodes, opts = {}) {
  const map = {};
  const codes = (fundCodes || []).filter(Boolean);
  if (!codes.length || !db) return map;
  const missing = [];
  try {
    const _ = db.command;
    const BATCH = 100;
    for (let i = 0; i < codes.length; i += BATCH) {
      const res = await db.collection(INDEX_CACHE_COLLECTION)
        .where({ fundCode: _.in(codes.slice(i, i + BATCH)) })
        .field({ fundCode: true, indexCode: true, indexName: true })
        .get();
      (res.data || []).forEach(d => {
        map[d.fundCode] = d.indexCode ? { indexCode: d.indexCode, indexName: d.indexName || "", fundType: "" } : null;
      });
    }
  } catch (e) { /* 缓存读失败走全量补拉 */ }

  for (const code of codes) if (!(code in map)) missing.push(code);

  // 补拉缺失（并发限制，避免瞬时大量请求东财）
  if (missing.length > 0) {
    const CONCURRENT = opts.concurrent || 8;
    for (let i = 0; i < missing.length; i += CONCURRENT) {
      const batch = missing.slice(i, i + CONCURRENT);
      const results = await Promise.all(batch.map(async (code) => {
        const track = await fetchTrackIndex(code, opts);
        if (track) {
          await _indexCacheUpsert(db, code, track.indexCode, track.indexName);
          return { code, val: track };
        }
        // 非指数基金：缓存"无跟踪指数"，避免重复查东财
        await _indexCacheUpsert(db, code, "", "");
        return { code, val: null };
      }));
      results.forEach(r => { map[r.code] = r.val; });
    }
  }
  return map;
}

/**
 * 单基金获取跟踪指数（带 cache）：查缓存，无则调东财补上并写回。
 * 返回 { indexCode, indexName, fundType } | null。
 */
async function getTrackIndexCached(db, fundCode, opts = {}) {
  if (!db || !fundCode) return fetchTrackIndex(fundCode, opts);
  try {
    const res = await db.collection(INDEX_CACHE_COLLECTION).doc(fundCode).get();
    const d = res && res.data;
    if (d) return d.indexCode ? { indexCode: d.indexCode, indexName: d.indexName || "", fundType: "" } : null;
  } catch (e) { /* 未命中缓存，走补拉 */ }
  const track = await fetchTrackIndex(fundCode, opts);
  await _indexCacheUpsert(db, fundCode, track ? track.indexCode : "", track ? track.indexName : "");
  return track;
}

/**
 * 历史净值（分页并发拉取，页序从新到旧）
 * 注意：东财 lsjz 接口固定每页 20 条（实测 pageSize 任意值均被忽略），
 * 页数 = ceil(need/20)；天数钳制 800（防 days 参数被滥用为外部 API DoS；
 * 800 = 详情页"近三年"视图所需 750+50 的取数上限）
 */
function fetchNAVHistory(fundCode, totalNeeded, opts = {}) {
  const { perPage = 20, timeoutMs = 8000 } = opts;
  const need = Math.max(1, Math.min(800, totalNeeded || 0));
  const pages = Math.max(1, Math.ceil(need / perPage));

  const fetchPage = (pageIndex) => new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=${perPage}`,
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
          const list = (json.Data.LSJZList || []).map((item) => ({
            date: item.FSRQ,
            nav: parseFloat(item.DWJZ) || 0,
            cumulativeNav: parseFloat(item.LJJZ) || 0,
            changeRate: parseFloat(item.JZZZL) || 0,
          }));
          resolve(list);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });

  // 分批限并发（每批 3 页），避免页数多时瞬时大量请求打东财接口
  const pageIndexes = Array.from({ length: pages }, (_, i) => i + 1);
  const results = [];
  const CONCURRENT = 3;
  const pump = async () => {
    while (pageIndexes.length) {
      const batch = pageIndexes.splice(0, CONCURRENT);
      const batchRes = await Promise.all(batch.map(fetchPage));
      results.push(...batchRes);
      if (pageIndexes.length) await new Promise(r => setTimeout(r, 120));
    }
  };
  return pump().then(() => results.flat());
}

// ---------------- 新浪实时估值 ----------------

// 新浪实时估值轻接口（支持批量，一次可带上百只）：
//   https://hq.sinajs.cn/list=fu_001475,fu_110003
// 响应为 GBK 文本，每行形如：
//   var hq_str_fu_001475="名称,时间,估算净值,昨日净值,累计净值,分红,估算涨跌%,日期,第二套估算净值,第二套涨跌%";
// 注意：必须带 Referer，否则 403；无覆盖的标的（债券基金、968 互认基金）返回空串。
// 涨跌基准是上一交易日已公布净值（worth 字段可能是今日已公布的，不可当基准）。
// 解析只取数字/日期字段，并以「日期」字段锚定位置——基金名称含逗号时按固定下标会整体错位。
// opts.budgetMs：整体预算（毫秒）。到点即停止续批、返回已拿到的部分——估值是"有则优先、
// 无则回退自算"，不能为凑齐全量把调用方的函数预算耗尽（快照任务每分钟跑，全平台基金要十几批；
// 持仓上百只的用户同样会叠出多批）。
function fetchSinaEstimates(codes, opts = {}) {
  const map = {};
  if (!codes || codes.length === 0) return Promise.resolve(map);
  const { timeoutMs = 8000, batchSize = 60, budgetMs = 0 } = opts;

  const fetchBatch = (batch, perTimeout) => new Promise((resolve) => {
    const list = batch.map((c) => `fu_${c}`).join(",");
    const req = https.get(`https://hq.sinajs.cn/list=${list}`, {
      headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        try {
          // 按 latin1 取字节：只解析 ASCII 数字/日期，中文名称不参与取值故无需 GBK 解码
          const body = Buffer.concat(chunks).toString("latin1");
          const re = /hq_str_fu_(\w+)="([^"]*)"/g;
          let m;
          while ((m = re.exec(body)) !== null) {
            const parts = m[2].split(",");
            const di = parts.findIndex((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.trim()));
            if (di < 6) continue; // 空数据（无覆盖标的）或字段不足
            const nav = parseFloat(parts[di - 5]);
            const changeRate = parseFloat(parts[di - 1]);
            if (!isFinite(nav) || !isFinite(changeRate)) continue;
            const prevNav = parseFloat(parts[di - 4]);
            const nav2 = parseFloat(parts[di + 1]);
            const changeRate2 = parseFloat(parts[di + 2]);
            map[m[1]] = {
              nav,                                        // 估算净值
              prevNav: isFinite(prevNav) ? prevNav : null, // 昨日净值（涨跌基准）
              changeRate,                                 // 估算涨跌%（主算法，误差更小）
              nav2: isFinite(nav2) ? nav2 : null,         // 第二套算法估算净值
              changeRate2: isFinite(changeRate2) ? changeRate2 : null,
              time: (parts[di - 6] || "").slice(0, 5),   // 数据时间，统一为 HH:mm（与自算路径 formatBJTime 一致）
              date: parts[di].trim(),                     // 估算所属日 YYYY-MM-DD
            };
          }
        } catch (e) { /* ignore */ }
        resolve();
      });
    });
    req.setTimeout(perTimeout, () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
  });

  return (async () => {
    const started = Date.now();
    for (let i = 0; i < codes.length; i += batchSize) {
      let perTimeout = timeoutMs;
      if (budgetMs > 0) {
        const remain = budgetMs - (Date.now() - started);
        if (remain <= 0) break; // 预算用尽：停止续批，用已拿到的那部分
        perTimeout = Math.min(timeoutMs, remain);
      }
      await fetchBatch(codes.slice(i, i + batchSize), perTimeout);
    }
    return map;
  })();
}

module.exports = {
  formatBJDate,
  formatBJTime,
  isBJWeekday,
  getQuarterParams,
  fetchTempHoldings,
  fetchTempHoldingsWithMeta,
  fetchTempHoldingsDeep,
  isValidHoldings,
  fetchStockPricesTencent,
  fetchSinaEstimates,
  fetchLatestNavEastMoney,
  fetchLatestNavMNF,
  fetchNAVHistory,
  fetchTrackIndex,
  resolveIndexPrefix,
  fetchIndexRealtime,
  fetchIndexRealtimeBatch,
  getTrackIndexBatchCached,
  getTrackIndexCached,
};
