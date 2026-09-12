const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");

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
 *       - 季报窗口期（1/4/7/10月 15日起）→ 从东方财富拉取最新季报
 *       - 非窗口期 → 从 fund_temperatures 读取缓存，无缓存才拉取
 *    3. 批量查询所有持仓股的 PE+PB+行业（行情接口） + 历史PE区间（估值接口）
 *    4. 每只股票打分 → 基金加权汇总 → 写入 fund_temperatures
 */
exports.main = async (event) => {
  const today = fd.formatBJDate();
  const _startTime = Date.now();
  const inWindow = isInReportWindow();
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
      console.log(`[computeFundTemperature] 季报窗口期，从东方财富拉取持仓股`);
      const result = await fetchHoldingsBatch(fundCodes);
      fundHoldings = result.holdings;
      fetchFailCount = result.failCount;
      etfMap = result.etfMap || {};
      console.log(`[computeFundTemperature] 拉取结果: 成功 ${Object.keys(fundHoldings).length}, 失败 ${fetchFailCount}`);
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
      const liveData = await ft.fetchStockLiveBatch(codes);
      let histData = {};
      // 90s 总预算内才拉历史 PE 区间（120s 超时留 30s 给写库），超预算用实时 PE 兜底
      if (Date.now() - _startTime < 90000) {
        // 剩余预算传入批间循环：到点停止续批，已拉到的照常返回（缺历史的走实时 PE 兜底），
        // 避免预算只在启动前检查一次、启动后冲破 120s 被强杀
        histData = await ft.fetchStockHistBatch(codes, { budgetMs: 90000 - (Date.now() - _startTime) });
      } else {
        console.log(`[computeFundTemperature] 已超 90s 预算，跳过历史 PE 区间`);
      }
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
    await db.collection("app_config").doc("temp_task_status").set({
      data: { status: "done", today, count: results.length, finishedAt: Date.now(), signalDist: dist }
    }).catch(() => {});
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
 */
async function fetchHoldingsBatch(fundCodes) {
  const holdings = {};
  const etfMap = {};
  let failCount = 0;
  const CONCURRENT = 10;
  for (let i = 0; i < fundCodes.length; i += CONCURRENT) {
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

async function getUniqueFundCodes() {
  const MAX_LIMIT = 1000;
  const all = [];
  let lastId = "";
  while (true) {
    const q = db.collection("holdings").field({ fundCode: true }).limit(MAX_LIMIT);
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
