const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
const td = require("./_shared/trading-day");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 温度公开回测（信任线：方法论可对账）
 *
 * 做法（纯数据陈述）：取近 120 天 fund_temperatures 的逐日温度信号（low/mid/high），
 * 对每个"基金-日"信号点，用东财净值算其后 5/10/20 个交易日的净值涨跌，
 * 按温度分桶出均值/中位数/上涨占比/样本数。聚合结果缓存进 app_config 的
 * temp_backtest_cache，客户端只读缓存（含 computedAt，如实标注数据截至）。
 *
 * 刷新策略：工作日 20:30 定时重算（多数净值已公布；个别晚公布的基金自然少算一天，
 * 前向收益用的是"已公布净值"，绝不用估算值充数——这是方法论可对账的底线）。
 * 客户端调用只读缓存，绝不现场重算（743 只基金拉净值会把用户请求拖死）。
 * 首次部署后用 cloudbase fn invoke 手动跑一轮生成缓存。
 *
 * 合规：输出全是"过去 N 天历史统计"，措辞走温度偏低/适中/偏高，页面加免责句。
 */

const CACHE_DOC = "temp_backtest_cache";
const TEMP_DAYS = 120;          // 温度回看窗口（自然日）
const NAV_DAYS = 130;           // 每基金净值行数（≈82 个交易日的温度窗口 + 20 交易日前向 + 余量）
const HORIZONS = [5, 10, 20];   // 前向交易日档位
const NAV_CONCURRENT = 8;
const BATCH_SLEEP_MS = 150;
const BUDGET_MS = 240000;       // 240s 预算保护（300s 超时留收尾），到点用已拉到的数据出结果
const STALE_MS = 76 * 3600 * 1000;       // 客户端只读路径的过期线（覆盖周末 72h 空窗）
const TIMER_STALE_MS = 20 * 3600 * 1000; // 定时任务的重算线：工作日 24h 间隔 > 20h，每晚必重算。
                                         // ⚠️ 不能复用 76h——否则定时任务也在 76h 内跳过，实际 5-6 天才算一次，
                                         // "生成中"死窗以更大尺寸回归（二轮审查 P2）

exports.main = async (event) => {
  const ev = event || {};
  const t0 = Date.now();
  const el = () => Date.now() - t0;
  try {
    // 客户端调用只读缓存；force 仅运维 invoke 生效——客户端原样传参若能触发全量重算，
    // 等于任何人都能打 4000+ 次东财请求（NAT 同一出口 IP，会连坐全部东财依赖）
    const { OPENID } = cloud.getWXContext();
    const clientCall = !!OPENID;
    const force = !!ev.force && !clientCall;

    if (!force) {
      const cached = await readCache();
      const staleMs = clientCall ? STALE_MS : TIMER_STALE_MS;
      if (cached && Date.now() - cached.computedAt < staleMs) {
        return { code: 0, cached: true, data: cached };
      }
      // 缓存缺失/过期：客户端只读路径直接告知未就绪（定时任务会补），运维路径继续重算
      if (clientCall) {
        return { code: 1, msg: "回测数据生成中，请稍后再来" };
      }
    }

    const fromDate = td.bjDateStr(-TEMP_DAYS);
    const tempRows = await readTempRows(fromDate);
    if (tempRows.length === 0) {
      return { code: 1, msg: "温度窗口内无数据" };
    }
    // 按基金归组：date 升序的信号序列
    const byFund = {};
    tempRows.forEach((r) => {
      if (!r.fundCode || !r.date || !r.signal || r.signal === "nodata") return;
      (byFund[r.fundCode] = byFund[r.fundCode] || []).push({ date: r.date, signal: r.signal });
    });
    const codes = Object.keys(byFund);
    Object.values(byFund).forEach((arr) => arr.sort((a, b) => (a.date < b.date ? -1 : 1)));

    // 逐基金拉净值并即时累加分桶（预算内能处理多少算多少，如实记录 fundCount）
    const agg = initAgg();
    let fundsProcessed = 0, sampleCount = 0;
    let dateFrom = null, dateTo = null;
    for (let i = 0; i < codes.length; i += NAV_CONCURRENT) {
      if (el() > BUDGET_MS) {
        console.warn(`[temperatureBacktest] 预算到点，已处理 ${fundsProcessed}/${codes.length} 只基金`);
        break;
      }
      const batch = codes.slice(i, i + NAV_CONCURRENT);
      const navLists = await Promise.all(batch.map((code) =>
        fd.fetchNAVHistory(code, NAV_DAYS).catch(() => [])));
      batch.forEach((code, j) => {
        // 官方日增长率（JZZZL，分红除息已调整）逐日复利——用未复权单位净值相除会在
        // 除息日算出假跌，污染"方法论可对账"页的统计口径
        const chgMap = {};
        const dateSet = new Set();
        (navLists[j] || []).forEach((row) => {
          if (row && typeof row.changeRate === "number") {
            chgMap[row.date] = row.changeRate;
            dateSet.add(row.date);
          }
        });
        const dates = [...dateSet].sort();
        (byFund[code] || []).forEach((sig) => {
          HORIZONS.forEach((k) => {
            const ret = forwardReturn(dates, chgMap, sig.date, k);
            if (ret == null) return;
            bucketPush(agg, sig.signal, k, ret);
            sampleCount++;
            if (!dateFrom || sig.date < dateFrom) dateFrom = sig.date;
            if (!dateTo || sig.date > dateTo) dateTo = sig.date;
          });
        });
        fundsProcessed++;
      });
      if (i + NAV_CONCURRENT < codes.length) {
        await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
      }
    }

    const data = {
      computedAt: Date.now(),
      dateFrom, dateTo,
      fundCount: fundsProcessed,
      fundTotal: codes.length,
      sampleCount,
      horizons: HORIZONS,
      // 只存聚合值（n/mean/median/posRate），不存 vals 原始数组：
      // 数万条原始值会逼近云库 512KB 文档上限，且客户端拉 1MB 冗余只为看四个统计量
      buckets: finalizeAgg(agg),
    };
    // 空结果（东财当晚全挂等）不落库；部分覆盖（预算打断只算了一部分基金）也不覆盖——
    // 公开页统计会静默降级 76h，宁可保留前一天的全量缓存（fundCount 如实，用户看到的
    // computedAt 说明数据时点）
    if (sampleCount === 0) {
      console.warn("[temperatureBacktest] 无有效样本，保留原缓存不覆盖");
      return { code: 2, msg: "无有效样本，保留原缓存", data: (await readCache()) || null };
    }
    const prevCache = await readCache();
    // 覆盖率下降保留旧缓存，但超过 48h 强制放行——否则基金池收缩（删持仓/清洗）后
    // 每轮都"低于上轮"，缓存永不更新、客户端全员"生成中"（三轮审查 P2）
    const staleEscaped = prevCache && prevCache.computedAt && Date.now() - prevCache.computedAt > 48 * 3600 * 1000;
    if (prevCache && (prevCache.fundCount || 0) > fundsProcessed && !staleEscaped) {
      console.warn(`[temperatureBacktest] 本轮覆盖 ${fundsProcessed} < 上轮 ${prevCache.fundCount}，保留原缓存`);
      return { code: 2, msg: "本轮覆盖率低于上轮，保留原缓存", data: prevCache };
    }
    await db.collection("app_config").doc(CACHE_DOC).set({ data }).catch(() => {});
    console.log(`[temperatureBacktest] funds=${fundsProcessed}/${codes.length} samples=${sampleCount} t=${el()}ms`);
    return { code: 0, cached: false, data };
  } catch (e) {
    console.error("temperatureBacktest 失败:", e.message);
    return { code: 500, msg: e.message };
  }
};

async function readCache() {
  try {
    const res = await db.collection("app_config").doc(CACHE_DOC).get();
    return (res.data && res.data.computedAt) ? res.data : null;
  } catch (e) { return null; }
}

// 近 TEMP_DAYS 天的温度行（只取需要字段，skip 分页）。
// ⚠️ 不能加 orderBy("date")：该集合没有 date 索引，十万行级排序会撞 32MB 内存上限直接 500
// （实测 2026-09-26）；表只在凌晨 3 点被定时任务写、本函数读几秒内完成，无分页边界漂移风险
async function readTempRows(fromDate) {
  const out = [];
  const PAGE = 1000;
  for (let skip = 0; skip < 200000; skip += PAGE) {
    const res = await db.collection("fund_temperatures")
      .where({ date: _.gte(fromDate) })
      .field({ fundCode: true, date: true, signal: true })
      .skip(skip).limit(PAGE).get();
    out.push(...(res.data || []));
    if ((res.data || []).length < PAGE) break;
  }
  return out;
}

function initAgg() {
  const agg = {};
  ["low", "mid", "high"].forEach((sig) => {
    agg[sig] = {};
    HORIZONS.forEach((k) => { agg[sig][k] = { n: 0, sum: 0, vals: [], pos: 0 }; });
  });
  return agg;
}

function bucketPush(agg, signal, k, ret) {
  const b = agg[signal] && agg[signal][k];
  if (!b) return;
  b.n++;
  b.sum += ret;
  b.vals.push(ret);
  if (ret > 0) b.pos++;
}

// 聚合收口：n/mean/median/posRate（中位数在这里算掉，vals 不落库）
function finalizeAgg(agg) {
  const out = {};
  ["low", "mid", "high"].forEach((sig) => {
    out[sig] = {};
    HORIZONS.forEach((k) => {
      const b = agg[sig][k];
      const vals = b.vals.slice().sort((a, z) => a - z);
      let median = null;
      if (vals.length) {
        median = vals.length % 2
          ? vals[(vals.length - 1) / 2]
          : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
      }
      out[sig][k] = {
        n: b.n,
        mean: b.n > 0 ? +(b.sum / b.n).toFixed(4) : null,
        median: median != null ? +median.toFixed(4) : null,
        posRate: b.n > 0 ? +((b.pos / b.n) * 100).toFixed(2) : null,
      };
    });
  });
  return out;
}

// 信号日 d 之后第 k 个交易日的净值涨跌%：官方日增长率逐日复利（分红除息已调整）。
// 任一天缺涨跌幅（净值未公布）→ 整个样本不计，绝不用估算值充数
function forwardReturn(dates, chgMap, d, k) {
  const pos = lowerBound(dates, d);
  if (pos + k > dates.length) return null;
  let prod = 1;
  for (let i = pos; i < pos + k; i++) {
    const r = chgMap[dates[i]];
    if (typeof r !== "number") return null;
    prod *= 1 + r / 100;
  }
  return +((prod - 1) * 100).toFixed(4);
}

function lowerBound(arr, d) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= d) lo = mid + 1; else hi = mid;
  }
  return lo;
}
