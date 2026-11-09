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

// ---------------- 交易时段边界（北京时间） ----------------
// 集合竞价 9:15-9:25，开盘价 9:25 定出 → 从 9:25 起就有"今日估值"可展示，
// 所以"今天"的起点是 9:25 而不是开盘 9:30（displayDay / 快照 / 轮询共用这一个边界）。
// ⚠️ 客户端 miniprogram/utils/market-time.js 的 marketPhase() 必须与此一致。
const OPEN_MIN = 565;      // 09:25 集合竞价开盘价定出
const AM_CLOSE_MIN = 690;  // 11:30 上午收盘
const PM_OPEN_MIN = 780;   // 13:00 下午开盘
const CLOSE_MIN = 900;     // 15:00 收盘

// 是否当日盘口时段（含 9:25-9:30 集合竞价段，不含午休）。
// 端点是有意与客户端 marketPhase()（9:25~15:00，15:00 即 afterClose）不同的：
// 云端含 15:00 整分钟，好让收盘那一刻的快照点被写上；11:30 整分钟不算盘口（客户端靠 isLunchBreak 掩住）
function inTradingWindow(bjMin) {
  return (bjMin >= OPEN_MIN && bjMin < AM_CLOSE_MIN) || (bjMin >= PM_OPEN_MIN && bjMin <= CLOSE_MIN);
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
  return _fetchHoldingsOnce(fundCode, topline, timeoutMs, year, month, false).then((rows) => {
    // 4 月空窗兜底：Q1 法定披露截止 ~4/22，4/1–各基金实际披露日之间请求 (year,3)
    // 当年一张表都没有 → 解析为空，回退上年 Q4 再拉一次（7/10 月无此问题：年内已有上季表）
    if ((!rows || rows.length === 0) && month === 3) {
      return _fetchHoldingsOnce(fundCode, topline, timeoutMs, year - 1, 12, false);
    }
    return rows;
  });
}

function _fetchHoldingsOnce(fundCode, topline, timeoutMs, year, month, withMeta) {
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=${topline}&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          resolve(_parseHoldingsHtml(body, withMeta));
        } catch (e) {
          resolve(withMeta ? { holdings: [], fundName: "" } : []);
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(withMeta ? { holdings: [], fundName: "" } : []); });
    req.on("error", () => resolve(withMeta ? { holdings: [], fundName: "" } : []));
  });
}

/**
 * 拉取基金持仓股列表 + 基金名称（温度计算需要名称判断 ETF）
 */
function fetchTempHoldingsWithMeta(fundCode, opts = {}) {
  const { topline = 20, timeoutMs = 8000 } = opts;
  const { year, month } = getQuarterParams();
  return _fetchHoldingsOnce(fundCode, topline, timeoutMs, year, month, true).then((meta) => {
    // 4 月空窗兜底，同 fetchTempHoldings
    if (meta && (!meta.holdings || meta.holdings.length === 0) && month === 3) {
      return _fetchHoldingsOnce(fundCode, topline, timeoutMs, year - 1, 12, true);
    }
    return meta;
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
              // fields[30]=行情时间戳，三种格式：沪深 20260924161444、港股 2026/09/25 10:02:30、
              // 美股 2026-09-24 16:00:01。休市/停牌时它是最后一次成交时刻——调用方靠它判断
              // 行情是不是"今天的"（休市日腾讯给的是上一交易日的涨跌，别当今日估算用）
              const rawTs = String(fields[30] || "").replace(/\D/g, "");
              const quoteDate = rawTs.length >= 8
                ? `${rawTs.slice(0, 4)}-${rawTs.slice(4, 6)}-${rawTs.slice(6, 8)}`
                : null;
              map[code] = {
                price: curr,
                prevClose: prev,
                changeRate: +(((curr - prev) / prev) * 100).toFixed(2),
                market: qtCode.slice(0, 2),   // sh|sz|hk|us
                date: quoteDate,              // 行情所属日期 YYYY-MM-DD
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
            // 涨跌恰为 0.00% 是有效值（指数/货基常见），不能被 || null 吞成"未公布"
            //（此前与 fetchNAVHistory 的空串区分口径不一致，下游会静默退到估算口径）
            actualChangeRate: (today.JZZZL === "" || today.JZZZL == null) ? null : (parseFloat(today.JZZZL) || 0),
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
            // JZZZL 缺失/空串（货币基金、部分债基、当日未公布）置 null：伪造 0% 会把
            // "缺数即弃"的下游守卫（误差台账/温度回测）全部变成死代码
            changeRate: (item.JZZZL === "" || item.JZZZL == null) ? null : (parseFloat(item.JZZZL) || 0),
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

  // 分批限并发（每批 5 页）：260~280 天要 11-14 页，3 页/批时详情页/收益页首屏
  // 光拉历史就要 5 轮往返；5 页/批 3 轮完成。瞬时 5 个 lsjz GET 在东财容忍范围内
  const pageIndexes = Array.from({ length: pages }, (_, i) => i + 1);
  const results = [];
  const CONCURRENT = 5;
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
// 不能为凑齐全量把调用方的函数预算耗尽（快照任务每分钟跑，全平台基金要十几批；
// 持仓上百只的用户同样会叠出多批）。
//
// 重试（2026-09-28 加）：这条接口偶发整批零返回（实测同一天 14:44 有 81/158 个账号同时缺值、
// 13:22 有 44 个），原实现一次超时就整体放弃 → 下游只能退回自算，同一行数字悄悄换口径。
// 现在：首轮用常规超时，缺值的代码用短超时补一轮（3s 足够一次正常轻请求，实测 ~200ms）。
// ⚠️ 缺值里混着"本就无覆盖"的标的（债券/968），所以重试只是再试一次、不做无限重试；
// 首轮出现"整批零返回"才算取数失败并打日志（否则持有债券基金的用户每次调用都会刷日志）。
function fetchSinaEstimates(codes, opts = {}) {
  const map = {};
  if (!codes || codes.length === 0) return Promise.resolve(map);
  const { timeoutMs = 8000, batchSize = 60, budgetMs = 0, retryTimeoutMs = 3000 } = opts;

  const fetchBatch = (batch, perTimeout) => new Promise((resolve) => {
    const list = batch.map((c) => `fu_${c}`).join(",");
    const req = https.get(`https://hq.sinajs.cn/list=${list}`, {
      headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => { chunks.push(c); });
      res.on("end", () => {
        let hit = 0;
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
            hit++;
          }
        } catch (e) { /* ignore */ }
        resolve({ ok: true, hit });
      });
    });
    req.setTimeout(perTimeout, () => { req.destroy(); resolve({ ok: false, hit: 0 }); });
    req.on("error", () => resolve({ ok: false, hit: 0 }));
  });

  return (async () => {
    const started = Date.now();
    let pending = [...codes];
    let failBatches = 0; // 首轮"整批零返回"的批次数：这才是取数失败，需要日志
    let missedAtFirstRound = 0;
    for (let round = 1; round <= 2 && pending.length > 0; round++) {
      const roundTimeout = round === 1 ? timeoutMs : retryTimeoutMs;
      const stillMissing = [];
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        let perTimeout = roundTimeout;
        if (budgetMs > 0) {
          const remain = budgetMs - (Date.now() - started);
          if (remain <= 0) { stillMissing.push(...batch); continue; } // 预算用尽：停止续批，用已拿到的那部分
          perTimeout = Math.min(roundTimeout, remain);
        }
        const r = await fetchBatch(batch, perTimeout);
        if (round === 1 && r.hit === 0) failBatches++;
        // 缺值集合按"响应里有没有这只"判：部分返回时只补缺的那些
        batch.forEach((c) => { if (!map[c]) stillMissing.push(c); });
      }
      if (round === 1) missedAtFirstRound = stillMissing.length;
      pending = stillMissing;
    }
    if (failBatches > 0) {
      console.warn(`[fetchSinaEstimates] 首轮 ${failBatches} 批零返回、缺 ${missedAtFirstRound} 只，重试后仍缺 ${pending.length} 只：${pending.slice(0, 6).join(",")}`);
    }
    return map;
  })();
}

// ---------------- 数据源一（新浪）最近值缓存 ----------------
// 用途：新浪偶发整批取数失败时，下游**不换源**——沿用同源的最近一次值，而不是悄悄换成自算口径
// （2026-09-28 实测：同一行数字在两个源之间跳变，主动基金两源差约 1pp；自算只覆盖前十大重仓）。
// 写入方只有 snapshotProfit（每 2 分钟一轮，本来就把全平台新浪值拉一遍，零额外上游请求）；
// 读取方是四个估值入口（getPortfolio / fetchFundEstimate / batchFetchEstimate / fetchFundOverview）。
const EST_CACHE_COLLECTION = "fund_estimate_cache";
// 盘中沿用上限：盘中源头在动，太久说明长时间取不到，宁缺也不静默冻结一个旧数
const SINA_STALE_TRADING_MS = 30 * 60 * 1000;

// 同源最近值能否沿用：必须与请求同一"数据所属日"（避免把上一交易日的值当今日），且时效内。
// 盘后/午休/周末新浪自己也不再更新（实测最后一版 16:04-16:06），当日值直接可用；
// 盘中则限 30 分钟。
function staleCacheUsable(cached, todayStr, now) {
  if (!cached || cached.rate == null || cached.date !== todayStr) return false;
  const bj = new Date(now + 8 * 3600000);
  const live = bj.getUTCDay() >= 1 && bj.getUTCDay() <= 5 && inTradingWindow(bj.getUTCHours() * 60 + bj.getUTCMinutes());
  if (!live) return true;
  return now - (cached.ts || 0) <= SINA_STALE_TRADING_MS;
}

// 估值源选择：四个估值入口共用一套口径，避免各页各写一条分支而漂移。
// pref = "sina"（数据源一）| "self"（数据源二）；入参里的 sinaRate/selfRate 都已由调用方做过日期校验
// 返回 { rate, source, time, nav }，rate === null 表示今日暂无估值（调用方按"未出估值"处理）；
// nav 只在数据源一有对应金额时给出（估算净值），沿用缓存值时一并带上，避免"涨跌有值、估算净值空"
// 持仓股加权涨跌（2026-11-08 审查收敛：4 处 computeSelfEstimate 的公式漂移消除——本函数为唯一口径）。
// holdings 项兼容 {stockCode|code, navRatio|ratio}；prices 为 fetchStockPricesTencent 返回（含 changeRate）。
// opts.today 传入时启用逐股日期校验：停牌/停更股的旧涨跌不混入当日估算（2026-10-06 审查口径）。
// 返回 null = 无有效持仓数据（调用方按"自算不可用"处理）。
function weightedChangeRate(holdings, prices, opts = {}) {
  let totalRatio = 0, weighted = 0;
  (holdings || []).forEach((h) => {
    const code = h.stockCode || h.code;
    const ratio = parseFloat(h.navRatio != null ? h.navRatio : h.ratio) || 0;
    const p = code ? prices[code] : null;
    if (!p || p.changeRate == null) return;
    if (opts.today && p.date !== opts.today) return;
    totalRatio += ratio;
    weighted += p.changeRate * ratio;
  });
  if (!(totalRatio > 0)) return null;
  const rate = +(weighted / totalRatio).toFixed(2);
  // opts.detail：同时回传加权覆盖率（%），供调用方写 _coverage 等观测字段
  return opts.detail ? { rate, coverage: +totalRatio.toFixed(1) } : rate;
}

function pickEstimate({ pref, sinaRate, sinaTime, sinaNav, selfRate, selfTime, cached, todayStr, now }) {
  if (pref === "self") {
    // 数据源二：自算优先，缺失时用新浪兜底（保持原行为）
    if (selfRate != null) return { rate: selfRate, source: "self", time: selfTime || "", nav: null };
    if (sinaRate != null) return { rate: sinaRate, source: "sina", time: sinaTime || "", nav: sinaNav != null ? sinaNav : null };
    return { rate: null, source: "", time: "", nav: null };
  }
  // 数据源一：本轮新浪 → 同源最近值 → 自算（仅"从无新浪值"的无覆盖标的，或长时间取不到）
  if (sinaRate != null) {
    // 快照时间不回退（2026-11-09 事故）：新浪 CDN 多节点缓存不一致——同一基金连续请求会交替
    // 返回新旧两个快照（实测 11:32 的 1.8154 ↔ 11:23 的 2.1148），列表与详情各自拉取时刻不同
    // 就显示成两个数（用户："实时估值怎么不一样"）。本轮快照早于已缓存快照（同一天且都是
    // HH:mm 格式）时，判定为 CDN 旧节点，沿用缓存值，保证同一时间窗内全端一致
    if (cached && cached.rate != null && cached.date === todayStr &&
        cached.time && sinaTime && /^\d{1,2}:\d{2}/.test(sinaTime) && sinaTime < cached.time) {
      return { rate: cached.rate, source: "sina", time: cached.time, nav: cached.nav != null ? cached.nav : (sinaNav != null ? sinaNav : null) };
    }
    return { rate: sinaRate, source: "sina", time: sinaTime || "", nav: sinaNav != null ? sinaNav : null };
  }
  if (staleCacheUsable(cached, todayStr, now)) {
    return { rate: cached.rate, source: "sina", time: cached.time || "", nav: cached.nav != null ? cached.nav : null };
  }
  if (selfRate != null) return { rate: selfRate, source: "self", time: selfTime || "", nav: null };
  return { rate: null, source: "", time: "", nav: null };
}

// 读同源最近值。⚠️ 必须分块：快照任务一次要补的缺值可达 300 只（整批失败那一轮），
// 早期版本 `_.in(list.slice(0,200))` 会把 200 之后静默丢掉 —— 恰恰在最需要它的时候（整批失败）
// 让部分基金又退回了自算，等于修复只做了一半
async function readEstimateCache(db, codes) {
  const out = {};
  const list = [...new Set((codes || []).filter(Boolean))];
  const CHUNK = 100;
  for (let i = 0; i < list.length; i += CHUNK) {
    try {
      const res = await db.collection(EST_CACHE_COLLECTION)
        .where({ _id: db.command.in(list.slice(i, i + CHUNK)) })
        .field({ rate: true, time: true, nav: true, date: true, ts: true })
        .limit(CHUNK)
        .get();
      (res.data || []).forEach((d) => { out[d._id] = d; });
    } catch (e) {
      console.warn("[readEstimateCache] 读取失败:", e.message);
    }
  }
  return out;
}

// 批量写回本轮拿到的今日值（只由 snapshotProfit 调用；分块串行，避免瞬发几百个写）
async function writeEstimateCache(db, entries) {
  const list = (entries || []).filter((e) => e && e.fundCode && e.rate != null && e.date);
  if (list.length === 0) return 0;
  const CHUNK = 50;
  for (let i = 0; i < list.length; i += CHUNK) {
    await Promise.all(list.slice(i, i + CHUNK).map((e) => db.collection(EST_CACHE_COLLECTION)
      .doc(e.fundCode)
      .set({ data: { fundCode: e.fundCode, rate: e.rate, time: e.time || "", nav: e.nav != null ? e.nav : null, date: e.date, ts: e.ts || Date.now() } })
      .catch(() => {})));
  }
  return list.length;
}

module.exports = {
  formatBJDate,
  formatBJTime,
  isBJWeekday,
  inTradingWindow,
  OPEN_MIN,
  AM_CLOSE_MIN,
  PM_OPEN_MIN,
  CLOSE_MIN,
  getQuarterParams,
  fetchTempHoldings,
  fetchTempHoldingsWithMeta,
  fetchTempHoldingsDeep,
  isValidHoldings,
  fetchStockPricesTencent,
  fetchSinaEstimates,
  pickEstimate,
  weightedChangeRate,
  staleCacheUsable,
  readEstimateCache,
  writeEstimateCache,
  EST_CACHE_COLLECTION,
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
