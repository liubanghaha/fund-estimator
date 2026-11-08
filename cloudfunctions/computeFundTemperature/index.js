const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");
const td = require("./_shared/trading-day");
const https = require("https");

/**
 * 定时任务：每日凌晨 3:00 计算所有持仓基金的估值温度
 *
 *  算法：
 *    每只股票独立打分 — 当前PE在自身历史 PE 区间的分位
 *    亏损股用 PB 替代、周期股加风险提示
 *    基金估值 = 持仓股估值按持仓占比的几何加权平均
 *    判定：< 0.75 低估 | 0.75~1.25 正常 | > 1.25 高估
 *
 *  流程：
 *    1. 获取持仓基金代码（去重）
 *    2. 获取持仓股列表：
 *       - 季报窗口期（1/4/7/10月 15日起）→ 优先读季报快照表 fund_quarterly_holdings
 *         （snapshotQuarterlyHoldings 每工作日 04:00 捕获新季报），缺失的才从东财拉取。
 *         2026-10-15 起窗口期全量拉东财耗时 117s 吃光 90s 历史 PE 预算 → normPE 全兜底 1.0、
 *         档位全"适中"（每个季报季复发），改读快照后预算全留给历史 PE
 *       - 非窗口期 → 从 fund_temperatures 读取缓存，无缓存才拉取
 *    3. 批量查询所有持仓股的 PE+PB+行业（行情接口） + 历史PE区间（估值接口）
 *    4. 每只股票打分 → 基金加权汇总 → 写入 fund_temperatures
 *
 *  行业快照回填（2026-09-27 新增）：行情主源（东财 lvb）带行业字段，但降级到腾讯源时
 *  无行业 → 历史代码硬写"其他" → 行业穿透在"半导体 / 科技 / 其他"之间漂移
 *  （实测 2026-09-26 缺行业 221 只 vs 09-27 缺 0 只）。行业几乎不变，故：
 *  取值 = 当日主源行业 → 缺失时回填 stock_industries 快照（最近一次已知）→ 仍无才"其他"；
 *  当日拿到的有效行业写回快照表。event.seedIndustries=true 可一次性从历史温度表灌种子。
 */
// ---- 行业快照（stock_industries：_id=股票代码 → { industry, updatedAt }）----
const BAD_INDUSTRY = new Set(["", "-", "其他", "其它", "未知", "null"]);
function goodIndustry(v) {
  const t = String(v || "").trim();
  return t && !BAD_INDUSTRY.has(t) ? t : "";
}
async function readIndustrySnapshot(codes) {
  const map = {};
  try {
    for (let i = 0; i < codes.length; i += 100) {
      const res = await db.collection("stock_industries")
        .where({ _id: _.in(codes.slice(i, i + 100)) })
        .field({ industry: true })
        .get();
      (res.data || []).forEach((d) => { const g = goodIndustry(d.industry); if (g) map[d._id] = g; });
    }
  } catch (e) { /* 集合未建（首次运行）时忽略：当日行业照常用，下次跑就有快照 */ }
  return map;
}
async function upsertIndustrySnapshot(list) {
  try {
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      await Promise.all(chunk.map((x) =>
        db.collection("stock_industries").doc(x.code)
          .set({ data: { industry: x.industry, updatedAt: Date.now() } })
          .catch(() => {})
      ));
    }
  } catch (e) { console.warn("[computeFundTemperature] 行业快照写入失败:", e.message); }
}

let industrySnapStat = null; // 本轮行业快照命中/新学计数（写入状态文档供观测）

// ---- 市场级指标（债市温度 / 股债性价比，2026-11-05 竞品调研增补）----
// 随每日温度任务一起算，写入 app_config/temp_task_status.marketIndicator，供详情页温度卡消费。
// 数据源（云函数无域名限制）：新浪国债日行情 CN10YT（近 3 年序列算分位）+ 蛋卷估值中心（沪深300 PE）。
// 任一源失败只缺对应字段，不阻塞温度主流程；债市温度口径 = 10Y 收益率历史分位映射
// 温度三档（收益率历史低位 = 债价高位 = 偏高），纯数据陈述、无引导性措辞。
function _httpsGetJson(url, referer) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({ "User-Agent": "Mozilla/5.0" }, referer ? { Referer: referer } : {}),
      timeout: 8000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("JSON 解析失败")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("超时")); });
    req.on("error", reject);
  });
}
async function calcMarketIndicators() {
  const out = {};
  // 1) 10Y 国债收益率：新浪日行情（2022-12 起有数据），近 3 年窗口算分位
  try {
    const d = await _httpsGetJson("https://bond.finance.sina.com.cn/hq/gb/daily?symbol=CN10YT", "https://finance.sina.com.cn/");
    const rows = (d && d.result && d.result.data) || [];
    const closes = rows.map((r) => parseFloat(r.c)).filter((v) => isFinite(v) && v > 0);
    if (closes.length >= 250) {
      const last = closes[closes.length - 1];
      const win = closes.slice(-750);
      const below = win.filter((v) => v <= last).length;
      const pct = Math.round((below / win.length) * 100);
      out.bondYield = +last.toFixed(3);
      out.yieldPct = pct;
      out.bondTemp = pct <= 33 ? "偏高" : pct >= 67 ? "偏低" : "适中"; // 收益率低位=债价高位
      out.yieldDays = win.length;
      out.yieldDate = (rows[rows.length - 1] && rows[rows.length - 1].d) || "";
    }
  } catch (e) { console.warn("[computeFundTemperature] CN10YT 读取失败:", e.message); }
  // 2) 沪深300 PE + 股债性价比（风险溢价）：蛋卷估值中心（每市收盘后更新）
  try {
    const d = await _httpsGetJson("https://danjuanfunds.com/djapi/index_eva/dj");
    const items = (d && d.data && d.data.items) || [];
    const csi = items.find((x) => /000300/.test(x.index_code || ""));
    if (csi && csi.pe > 0) {
      out.csi300PE = +csi.pe.toFixed(2);
      if (out.bondYield != null) {
        // 股债性价比 = 沪深300 盈利收益率(1/PE,%) − 10Y 国债收益率(%)，纯数值陈述
        out.riskPremium = +(100 / csi.pe - out.bondYield).toFixed(2);
      }
    }
  } catch (e) { console.warn("[computeFundTemperature] 蛋卷估值读取失败:", e.message); }
  if (out.bondYield == null && out.csi300PE == null) return null;
  out.updatedAt = Date.now();
  return out;
}

exports.main = async (event) => {
  // 定时任务专用（2026-11-08 P0）：拒客户端调用（seedIndustries 等运维动作不可伪造）
  const { OPENID: _tempOpenid } = cloud.getWXContext();
  if (_tempOpenid) return { code: -1, msg: "拒绝客户端调用" };
  // 一次性运维动作：从历史温度表灌行业种子（回填快照、加速收敛）
  if (event && event.seedIndustries) {
    const t0 = Date.now();
    const from = new Date(Date.now() + 8 * 3600000 - 3 * 86400000).toISOString().slice(0, 10);
    const seen = {};
    let scanned = 0;
    for (let skip = 0; skip < 30000; skip += 200) {
      if (Date.now() - t0 > 90000) break; // 预算保护：没扫完的下次任务自然补全
      const res = await db.collection("fund_temperatures")
        .where({ date: _.gte(from) })
        .field({ detailPEs: true })
        .skip(skip).limit(200).get();
      const rows = res.data || [];
      scanned += rows.length;
      rows.forEach((r) => {
        (r.detailPEs || []).forEach((p) => {
          const g = goodIndustry(p.industry);
          if (g && p.code && !seen[p.code]) seen[p.code] = g;
        });
      });
      if (rows.length < 200) break;
    }
    const list = Object.entries(seen).map(([code, industry]) => ({ code, industry }));
    await upsertIndustrySnapshot(list);
    const out = { code: 0, scanned, stocks: list.length, costMs: Date.now() - t0 };
    console.log(`[computeFundTemperature] 行业种子灌入 ${JSON.stringify(out)}`);
    return out;
  }
  const today = fd.formatBJDate();
  const _startTime = Date.now();
  const inWindow = isInReportWindow();
  // 节假日守卫：周末/法定假日不算不写（cron 表达不了节假日，守卫只能放代码里）。
  // 此前国庆 7 天每天写 ~1460 行死数据、每个周末同样——读侧虽已按交易日过滤，写侧也该封口。
  // 手动运维动作（seedIndustries）不在此闸内
  // force=true（运维手动修复）：跳过非交易日闸（2026-11-08 加——坏数据周末修复用）
  if (!event.force && !td.isTradingDay(today)) {
    console.log(`[computeFundTemperature] 非交易日 ${today} 跳过`);
    return { code: 0, msg: `非交易日 ${today} 跳过` };
  }
  console.log(`[computeFundTemperature] 开始计算 ${today}, 季报窗口期: ${inWindow}`);

  try {
    // 1. 获取所有持仓的基金代码（去重）
    const fundCodes = await getUniqueFundCodes();
    console.log(`[computeFundTemperature] 持仓基金数: ${fundCodes.length}`);
    // 运行状态落库（app_config）：CLI 拉不到 120s 函数的返回/日志，用状态文档观测任务死在哪一步
    await db.collection("app_config").doc("temp_task_status").set({
      data: { status: "running", today, startTime: Date.now(), fundCount: fundCodes.length }
    }).catch(() => {});
    if (fundCodes.length === 0) return { code: 0, msg: "无持仓基金" };

    // 2. 获取持仓股列表
    let fundHoldings = {};
    let fetchFailCount = 0;
    let etfMap = {};

    if (inWindow) {
      // 窗口期主源=季报快照表（毫秒级读库），把 90s 预算全留给历史 PE 区间；
      // 快照缺失的基金（新基金/尚未披露）才回退东财单查
      console.log(`[computeFundTemperature] 季报窗口期，从 fund_quarterly_holdings 快照读持仓`);
      fundHoldings = await getSnapshotHoldings(fundCodes);
      console.log(`[computeFundTemperature] 快照命中: ${Object.keys(fundHoldings).length}/${fundCodes.length}`);
      const missedCodes = fundCodes.filter(c => !fundHoldings[c]);
      if (missedCodes.length > 0) {
        // 回退拉取限预算（40s）：598 只全拉完要 90s+ 会再次挤掉历史 PE——健康基线里历史
        // 也只覆盖 ~35% 股票，预算公平比全量覆盖重要。超预算的基金本轮跳过（不出当日行）
        console.log(`[computeFundTemperature] 快照未命中 ${missedCodes.length} 只，从东方财富拉取（预算 40s）`);
        const result = await fetchHoldingsBatch(missedCodes, { budgetMs: 40000 });
        Object.assign(fundHoldings, result.holdings);
        fetchFailCount = result.failCount;
        Object.assign(etfMap, result.etfMap || {});
      }
    } else {
      console.log(`[computeFundTemperature] 非窗口期，从 fund_temperatures 读取缓存持仓`);
      fundHoldings = await getCachedHoldings(fundCodes);
      const cachedCount = Object.keys(fundHoldings).length;
      console.log(`[computeFundTemperature] 缓存命中: ${cachedCount}/${fundCodes.length}`);

      const missedCodes = fundCodes.filter(c => !fundHoldings[c]);
      if (missedCodes.length > 0) {
        console.log(`[computeFundTemperature] 缓存未命中 ${missedCodes.length} 只，从东方财富拉取`);
        const result = await fetchHoldingsBatch(missedCodes);
        Object.assign(fundHoldings, result.holdings);
        fetchFailCount = result.failCount;
        Object.assign(etfMap, result.etfMap || {});
      }
    }

    // 持仓数据不足半数时从历史温度数据恢复
    if (Object.keys(fundHoldings).length < fundCodes.length * 0.5) {
      console.log(`[computeFundTemperature] 持仓数据不足 (${Object.keys(fundHoldings).length}/${fundCodes.length})，尝试从历史温度数据恢复`);
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
      // live 与 hist 并行（无数据依赖）。曾改串行：live 全额挤占 90s 预算 → hist 剩余预算
      // 不足被截断 → 大量股票 peHistory 缺失 → 温度整体退化为"恒定适中"且照常写库。
      // 并行时墙钟 ≈ max(live, hist) ≤ 90s，仍给写库留 30s；hist 保留批间预算闸（到点停止
      // 续批，缺历史的走实时 PE 兜底），不会启动后冲破 120s 被强杀
      const histBudget = 90000 - (Date.now() - _startTime);
      const [liveData, histData] = await Promise.all([
        ft.fetchStockLiveBatch(codes),
        histBudget > 10000
          ? ft.fetchStockHistBatch(codes, { budgetMs: histBudget })
          : Promise.resolve({}),
      ]);
      if (histBudget <= 10000) console.log(`[computeFundTemperature] 已超 90s 预算，跳过历史 PE 区间`);
      // 行业快照回填：当日主源缺失（降级到腾讯源）时用最近一次已知行业补上，
      // 保证行业穿透的粒度稳定（不因行情源波动在"半导体/科技/其他"之间跳）
      const snap = await readIndustrySnapshot(codes);
      industrySnapStat = { total: codes.length, hit: Object.keys(snap).length };
      const learned = [];
      codes.forEach(code => {
        const live = liveData[code] || {};
        const hist = histData[code] || {};
        const fresh = goodIndustry(live.industry);
        const industry = fresh || snap[code] || "其他";
        if (fresh && fresh !== snap[code]) learned.push({ code, industry: fresh });
        stockMap[code] = {
          pe: live.pe || null,
          pb: live.pb || null,
          price: live.price || null,
          industry,
          peHistory: hist.peYears || [],
          pbHistory: hist.pbYears || [],
          totalYears: hist.totalYears || 0,
        };
      });
      industrySnapStat.learned = learned.length;
      console.log(`[computeFundTemperature] 行业快照：命中 ${industrySnapStat.hit}/${industrySnapStat.total}，本轮新学 ${industrySnapStat.learned}`);
      if (learned.length > 0) await upsertIndustrySnapshot(learned);
    }

    const withHist = Object.values(stockMap).filter(s => s.totalYears > 0).length;
    console.log(`[computeFundTemperature] 有历史PE数据: ${withHist}/${codes.length}`);

    // 4. 计算估值信号（统一算法/阈值）
    const candidates = [];
    for (const [fundCode, holdings] of Object.entries(fundHoldings)) {
      const result = ft.calcSignal(fundCode, holdings, stockMap);
      if (result) {
        result.isETF = etfMap[fundCode] || false;
        candidates.push(result);
      }
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
        isETF: c.isETF || false,
        createTime: new Date(),
      });
    }

    if (results.length > 0) {
      // _id = fundCode_date 单文档 upsert（doc.set 幂等：存在覆盖、不存在创建），
      // 替代原 remove+add 两步写库，天然防并发重复计算重复写
      for (let i = 0; i < results.length; i += 50) {
        const batch = results.slice(i, i + 50);
        await Promise.all(batch.map(r =>
          db.collection("fund_temperatures")
            .doc(`${r.fundCode}_${r.date}`)
            .set({ data: r })
            .catch(() => {})
        ));
      }
    }

    const dist = { low: 0, mid: 0, high: 0, nodata: 0 };
    results.forEach(r => { dist[r.signal] = (dist[r.signal] || 0) + 1; });
    console.log(`[computeFundTemperature] 完成 ${results.length} 只 (低估:${dist.low} 正常:${dist.mid} 高估:${dist.high} 无数据:${dist.nodata})`);
    // 状态写入提前（2026-11-08 修复：此前在 calcMarketIndicators 之后——外部 HTTP 慢速流
    // 不触发 socket 超时会挂到 300s 被杀，状态/后续日期的温度全部停更，11-06~11-08 实测三天）
    await db.collection("app_config").doc("temp_task_status").set({
      data: { status: "done", today, count: results.length, finishedAt: Date.now(), signalDist: dist, industrySnap: industrySnapStat }
    }).catch(() => {});
    // 市场级指标（债市温度/股债性价比）算完补写（race 硬超时 8s，慢速流不再挂死函数）
    const marketIndicator = await Promise.race([
      calcMarketIndicators(),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]).catch(() => null);
    if (marketIndicator) {
      await db.collection("app_config").doc("temp_task_status")
        .update({ data: { marketIndicator } }).catch(() => {});
    }

    // 回测缓存自愈（2026-10-24 补，10-21~24 回测页空窗 4 天的教训）：温度产出正常后，
    // 检查温度回测缓存是否已 >20h（=定时重算线过期，正常应每晚 20:30 重算一次）。
    // 过期说明当晚 20:30 的重算失败/没跑——此刻温度数据刚刷新完毕正是重算的最佳时机，
    // 顺手补一次（异步不阻塞本函数返回；失败仅记日志，等明晚 20:30 再试）
    try {
      const btCache = await db.collection("temp_backtest_cache").doc("temp_backtest_cache").get();
      const btAge = Date.now() - ((btCache.data && btCache.data.computedAt) || 0);
      if (btAge > 20 * 3600 * 1000) {
        console.log(`[computeFundTemperature] 回测缓存已 ${Math.round(btAge / 3600000)}h 未更新，触发补算`);
        cloud.callFunction({ name: "temperatureBacktest", data: { force: true } })
          .then(() => console.log("[computeFundTemperature] 回测补算完成"))
          .catch(e => console.error("[computeFundTemperature] 回测补算失败:", e.message));
      }
    } catch (e) { /* 缓存集合不存在等：交给 20:30 定时任务 */ }

    return { code: 0, data: { count: results.length, date: today, signalDist: dist } };
  } catch (e) {
    console.error("[computeFundTemperature] 异常:", e);
    await db.collection("app_config").doc("temp_task_status").set({
      data: { status: "error", error: String(e.message || e).slice(0, 300), failedAt: Date.now() }
    }).catch(() => {});
    return { code: 500, msg: e.message };
  }
};

// ---- helpers ----

/**
 * 判断当前是否在季报发布窗口期
 * 季报窗口: 1/4/7/10月 15日起至月底（各基金公司集中在截止日前几天披露）
 *   - 1月: 四季报（上年12月）
 *   - 4月: 一季报（3月）
 *   - 7月: 二季报（6月）
 *   - 10月: 三季报（9月）
 */
function isInReportWindow() {
  const parts = fd.formatBJDate().split("-");
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  return [1, 4, 7, 10].includes(month) && day >= 15;
}

/**
 * 批量拉取持仓股（封装并发控制）
 * opts.budgetMs：整体预算（毫秒）。批间检查，到点停止续批——窗口期快照回退量可能达数百只，
 * 不设预算会重演"持仓拉取吃光历史 PE 预算"（2026-10-15 事故）。0 = 不限（非窗口期小批量兜底用）
 */
async function fetchHoldingsBatch(fundCodes, opts = {}) {
  const { budgetMs = 0 } = opts;
  const started = Date.now();
  const holdings = {};
  const etfMap = {};
  let failCount = 0;
  const CONCURRENT = 10;
  for (let i = 0; i < fundCodes.length; i += CONCURRENT) {
    if (budgetMs > 0 && i > 0 && Date.now() - started >= budgetMs) {
      console.log(`[computeFundTemperature] 回退拉取达 ${budgetMs}ms 预算，剩余 ${fundCodes.length - i} 只本轮跳过`);
      break;
    }
    const batch = fundCodes.slice(i, i + CONCURRENT);
    const results = await Promise.all(batch.map(async (fundCode) => {
      try {
        const { holdings: rows, fundName } = await fd.fetchTempHoldingsWithMeta(fundCode);
        return { fundCode, holdings: rows, fundName, ok: rows.length > 0 };
      } catch (e) { return { fundCode, holdings: [], fundName: "", ok: false }; }
    }));
    for (const r of results) {
      if (r.ok) holdings[r.fundCode] = r.holdings;
      else failCount++;
      etfMap[r.fundCode] = ft.isETFByName(r.fundName);
    }
    if (i + CONCURRENT < fundCodes.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return { holdings, failCount, etfMap };
}

/**
 * 从季报快照表读各基金最新一期持仓（季报窗口期用，2026-10-17 新增）。
 * snapshotQuarterlyHoldings 每工作日 04:00 维护（_id=fundCode_reportDate 幂等 upsert）；
 * 温度任务 03:00 先跑，读到的是截至昨日 04:00 的快照——季报持仓一天滞后可接受。
 * 每 100 个代码分块查、按 reportDate 降序：本地取每基金最新一期；行结构与东财拉取路径
 * 一致（{ stockCode, stockName, navRatio }），calcSignal 无需改动。
 */
async function getSnapshotHoldings(fundCodes) {
  const out = {};
  for (let i = 0; i < fundCodes.length; i += 100) {
    const chunk = fundCodes.slice(i, i + 100);
    // 行数 = 代码数 × 已积累季报期数；reportDate 降序保证触顶时留下的也是最新期
    const res = await db.collection("fund_quarterly_holdings")
      .where({ fundCode: _.in(chunk) })
      .orderBy("reportDate", "desc")
      .limit(1000)
      .get();
    (res.data || []).forEach(doc => {
      if (!doc.fundCode || !Array.isArray(doc.holdings) || !doc.holdings.length) return;
      if (out[doc.fundCode]) return; // 降序遍历，首个即最新一期
      const rows = doc.holdings
        .filter(h => h && h.stockCode && h.navRatio != null)
        .map(h => ({ stockCode: h.stockCode, stockName: h.stockName, navRatio: h.navRatio }));
      if (rows.length) out[doc.fundCode] = rows;
    });
  }
  return out;
}

async function getUniqueFundCodes() {
  const MAX_LIMIT = 1000;
  const all = [];
  let lastId = "";
  while (true) {
    const q = db.collection("holdings").field({ fundCode: true }).limit(MAX_LIMIT).orderBy("_id", "asc");
    // _id 游标分页（skip 深分页会随数据量增长而变慢）
    const res = lastId ? await q.where({ _id: _.gt(lastId) }).get() : await q.get();
    if (!res.data || res.data.length === 0) break;
    all.push(...res.data);
    if (res.data.length < MAX_LIMIT) break;
    lastId = res.data[res.data.length - 1]._id;
  }
  return [...new Set(all.map(h => h.fundCode))];
}

async function recoverHoldingsFromHistory(fundCodes) {
  const holdings = {};
  // 往前尝试最近 10 天（跨假期、季度末空窗）
  for (let d = 1; d <= 10; d++) {
    const targetDate = fd.formatBJDate(new Date(Date.now() - d * 86400000));
    const BATCH = 100;
    for (let i = 0; i < fundCodes.length; i += BATCH) {
      const batch = fundCodes.slice(i, i + BATCH);
      const res = await db.collection("fund_temperatures")
        .where({ fundCode: _.in(batch), date: targetDate })
        .get();
      (res.data || []).forEach(t => {
        if (fd.isValidHoldings(t.detailPEs) && !holdings[t.fundCode]) {
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

/**
 * 从 fund_temperatures 读取最近的持仓股缓存（非季报窗口期使用）
 * 查找每只基金最近一条有 detailPEs 的记录，提取为 holdings 格式
 */
async function getCachedHoldings(fundCodes) {
  const holdings = {};
  const BATCH = 100;
  // 往前查找，每个基金取最近一条有 detailPEs 的记录
  for (let i = 0; i < fundCodes.length; i += BATCH) {
    const batch = fundCodes.slice(i, i + BATCH);
    const res = await db.collection("fund_temperatures")
      .where({ fundCode: _.in(batch) })
      .orderBy("createTime", "desc")
      .limit(batch.length * 3) // 每个基金可能有多条记录，多取一些
      .get();
    // 按 fundCode 去重，只取每个基金的第一条（最近）
    const seen = new Set();
    (res.data || []).forEach(t => {
      if (seen.has(t.fundCode)) return;
      if (!t.detailPEs || t.detailPEs.length === 0) return;
      // 每只基金只认最近一条：脏数据也在此判定，不回退更早记录（更早的同样脏）
      seen.add(t.fundCode);
      // 历史脏占比（合计 >100%）→ 判为未命中，触发 fetchHoldingsBatch 现拉修正
      if (!fd.isValidHoldings(t.detailPEs)) return;
      holdings[t.fundCode] = t.detailPEs.map(p => ({
        stockCode: p.code,
        stockName: p.name,
        navRatio: p.ratio,
      }));
    });
  }
  return holdings;
}
