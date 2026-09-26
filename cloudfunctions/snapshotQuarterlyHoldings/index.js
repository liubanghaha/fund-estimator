const cloud = require("wx-server-sdk");
const fd = require("./_shared/fund-data");
const td = require("./_shared/trading-day");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/**
 * 季报持仓快照（漂移监测的数据底座）
 *
 * 每个工作日 04:00 检查一次：东财 jjcc 里一旦出现目标季度末的报告期（"截止至"日期），
 * 就把该期重仓股快照进 fund_quarterly_holdings，_id = fundCode_reportDate 幂等 upsert。
 * 行数按接口口径：季报为前十大，半年报/年报为全量持仓（快照如实保留，消费端自行取前 N）。
 *
 * 设计要点：
 *  - 基金池 = holdings 去重（与温度引擎同池，漂移监测和温度线看同一批基金）
 *  - 只认"目标季度"那张表：报告期没到 = 基金还没公布 = 不写（宁缺毋错，绝不把上期数据当本期）
 *  - 已有该期数据 → 跳过 HTTP，日常几乎零成本；一年只在季报公布窗口真正拉取
 *  - 错过发布窗口 = 该期数据永久缺失（东财只保留当期与前几期，季度滚动后拿不回），
 *    所以触发器按工作日天天查——这是漂移监测唯一"时间不可回放"的原始数据
 *
 * 文档形状：
 * { fundCode, reportDate("YYYY-MM-DD" 季度末), reportYear, reportMonth,
 *   holdings: [{rank, stockCode, stockName, navRatio}], count, fetchedAt, source: "jjcc" }
 */

const COLL = "fund_quarterly_holdings";
const STATUS_DOC = "quarterly_snapshot_status";
const PAGE = 1000;
const FETCH_CONCURRENT = 10;
const WRITE_CONCURRENT = 20;
const BATCH_SLEEP_MS = 300;

const QUARTER_END_DAY = { 3: "31", 6: "30", 9: "30", 12: "31" };

exports.main = async (event) => {
  // 安全：定时任务专用，拒绝客户端调用（防伪造快照/刷数据源）
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { code: -1, msg: "拒绝客户端调用" };
  const ev = event || {};
  const dryRun = !!ev.dryRun;   // 只查不写（部署后验证用）
  const force = !!ev.force;     // 跳过交易日判断
  // limit：只处理前 N 只（冒烟/灰度用，正常触发不传 = 全量）
  const limit = parseInt(ev.limit, 10) || 0;
  const t0 = Date.now();
  const el = () => Date.now() - t0;
  try {
    const today = td.bjDateStr();
    if (!dryRun && !force && !td.isTradingDay(today)) {
      return { code: 0, msg: `非交易日 ${today} 跳过` };
    }
    // 目标季度 = 最近一个"应该已发布"的季报期（1-3月→上年12月，4-6月→3月，7-9月→6月，10-12月→9月）。
    // getQuarterParams 只认 Date、传字符串会被静默忽略成 now——定时场景 today===now 无差，
    // 但别给它传别的日期参数
    const q = fd.getQuarterParams();
    const quarterEnd = `${q.year}-${String(q.month).padStart(2, "0")}-${QUARTER_END_DAY[q.month]}`;

    const codes = await getUniqueFundCodes();
    if (codes.length === 0) return { code: 0, msg: "无持仓基金" };

    // 运行状态落库：300s 函数 CLI 拉不到返回/日志，用 app_config 状态文档观测（同温度任务的做法）
    await writeStatus("running", { today, quarterEnd, fundCount: codes.length });

    // 已落库的最新报告期（fundCode → max(reportDate)）：已到目标期的直接跳过，省 HTTP
    const latest = await readLatestReportDates(codes);
    const staleCodes = codes.filter((c) => !(latest[c] && latest[c] >= quarterEnd));
    const fresh = codes.length - staleCodes.length;
    const needFetch = limit > 0 ? staleCodes.slice(0, limit) : staleCodes;

    let errors = 0, noReport = 0, written = 0;
    // 边拉边写 + 预算保护：东财变慢被 300s 杀掉时，已拉到的批次已落库（否则整轮全丢）；
    // 没拉到的基金次日 latest[c] 仍小于目标期，自动重试
    const FETCH_BUDGET_MS = 240000;
    const pendingWrite = [];
    for (let i = 0; i < needFetch.length; i += FETCH_CONCURRENT) {
      if (el() > FETCH_BUDGET_MS) {
        console.warn(`[snapshotQuarterlyHoldings] 预算到点，已处理 ${i}/${needFetch.length}，剩余次日重试`);
        break;
      }
      const batch = needFetch.slice(i, i + FETCH_CONCURRENT);
      const results = await Promise.all(batch.map((code) => fetchQuarterReport(code, q.year, q.month)));
      for (const r of results) {
        if (r.err) { errors++; continue; }
        if (!r.doc) { noReport++; continue; }
        pendingWrite.push(r.doc);
      }
      // 每 10 个批次（100 只）flush 一次写库，摊薄写放大的同时控制最坏损失
      if (pendingWrite.length >= FETCH_CONCURRENT * 10 || i + FETCH_CONCURRENT >= needFetch.length) {
        if (!dryRun && pendingWrite.length > 0) {
          written += await upsertAll(pendingWrite);
          pendingWrite.length = 0;
        }
      }
      if (i + FETCH_CONCURRENT < needFetch.length) {
        await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
      }
    }
    // 尾批不足 flush 阈值的落库（预算打断时也不丢已拉到的数据）
    if (!dryRun && pendingWrite.length > 0) {
      written += await upsertAll(pendingWrite);
      pendingWrite.length = 0;
    }

    if (dryRun) {
      await writeStatus("done", { today, quarterEnd, dryRun: true });
      return {
        code: 0, dryRun: true, today, quarterEnd,
        codes: codes.length,
        fresh,
        checked: needFetch.length,
        writeWould: pendingWrite.length, noReport, errors,
        sample: pendingWrite.slice(0, 3).map((d) => `${d.fundCode} ${d.reportDate} n=${d.count} 首仓=${d.holdings[0] ? d.holdings[0].stockName : "--"}(${d.holdings[0] ? d.holdings[0].navRatio : "--"}%)`),
        costMs: el(),
      };
    }

    const result = {
      code: 0, today, quarterEnd,
      codes: codes.length,
      fresh,
      checked: needFetch.length,
      written, noReport, errors,
      costMs: el(),
    };
    await writeStatus("done", result);
    console.log(`[snapshotQuarterlyHoldings] ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    console.error("snapshotQuarterlyHoldings 失败:", e.message);
    await writeStatus("error", { msg: e.message }).catch(() => {});
    return { code: 500, msg: e.message };
  }
};

async function writeStatus(status, extra) {
  return db.collection("app_config").doc(STATUS_DOC).set({
    data: { status, ...extra, updatedAt: Date.now() }
  }).catch(() => {});
}

// 持仓基金代码（去重，_id 游标分页 + 显式定序）——与温度引擎同池
async function getUniqueFundCodes() {
  const all = [];
  let lastId = "";
  while (true) {
    const q = db.collection("holdings").field({ fundCode: true }).orderBy("_id", "asc").limit(PAGE);
    const res = lastId ? await q.where({ _id: _.gt(lastId) }).get() : await q.get();
    if (!res.data || res.data.length === 0) break;
    all.push(...res.data);
    if (res.data.length < PAGE) break;
    lastId = res.data[res.data.length - 1]._id;
  }
  return [...new Set(all.map((h) => h.fundCode).filter(Boolean))];
}

// 集合内已有哪些报告期（按基金取最大 reportDate）
async function readLatestReportDates(codes) {
  const latest = {};
  for (let i = 0; i < codes.length; i += 100) {
    try {
      const res = await db.collection(COLL)
        .where({ fundCode: _.in(codes.slice(i, i + 100)) })
        .field({ fundCode: true, reportDate: true })
        .limit(PAGE).get();
      (res.data || []).forEach((d) => {
        if (d.fundCode && d.reportDate && (!latest[d.fundCode] || d.reportDate > latest[d.fundCode])) {
          latest[d.fundCode] = d.reportDate;
        }
      });
    } catch (e) { console.warn("[snapshotQuarterlyHoldings] 读已有报告期失败:", e.message); }
  }
  return latest;
}

/**
 * 拉单只基金的目标季度报告期。改编自 fetchFundProfile 的 fetchHoldings，
 * 差异：只要"截止至 = 目标季度末"的那张表，没公布就返回 null（不取历史表兜底——
 * 快照宁缺毋错，兜底会把上期数据写成本期）。
 */
function fetchQuarterReport(fundCode, year, month) {
  const https = require("https");
  const quarterEnd = `${year}-${String(month).padStart(2, "0")}-${QUARTER_END_DAY[month]}`;
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=${year}&month=${month}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve({ doc: null }); return; } // 无该期数据（新基金/ETF/未公布）
          const html = match[1].replace(/\\"/g, '"');

          // 找"截止至 = 目标季度末"且含「占净值」表头的表
          let targetTable = null;
          const tblRe = /<table[\s\S]*?<\/table>/g;
          let tblMatch;
          while ((tblMatch = tblRe.exec(html)) !== null) {
            const tbl = tblMatch[0];
            const before = html.slice(Math.max(0, tblMatch.index - 300), tblMatch.index);
            const endMatch = before.match(/截止至：[\s\S]*?(\d{4}-\d{2}-\d{2})/);
            if (!endMatch || endMatch[1] !== quarterEnd) continue;
            const thText = (tbl.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [])
              .map((t) => t.replace(/<[^>]+>/g, "").replace(/\s+/g, "")).join("|");
            if (thText.indexOf("占净值") === -1) continue;
            targetTable = tbl;
            break;
          }
          if (!targetTable) { resolve({ doc: null }); return; } // 目标期未公布

          const rows = parseHoldingsRows(targetTable);
          resolve({
            doc: {
              fundCode,
              reportDate: quarterEnd,
              reportYear: year,
              reportMonth: month,
              holdings: rows,
              count: rows.length,
              fetchedAt: Date.now(),
              source: "jjcc",
            },
          });
        } catch (e) { resolve({ doc: null, err: e.message }); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ doc: null, err: "timeout" }); });
    req.on("error", () => resolve({ doc: null, err: "network" }));
  });
}

// 解析单张持仓表：占比列必须按表头「占净值比例」定位（列数随基金类型/季度变化，固定下标会取错列）
function parseHoldingsRows(tableHtml) {
  const ratioCol = (() => {
    const thead = tableHtml.match(/<thead[\s\S]*?<\/thead>/);
    if (!thead) return -1;
    const ths = thead[0].match(/<th[^>]*>([\s\S]*?)<\/th>/g) || [];
    for (let i = 0; i < ths.length; i++) {
      const text = ths[i].replace(/<[^>]+>/g, "").replace(/\s+/g, "");
      if (text.indexOf("占净值") !== -1) return i;
    }
    return -1;
  })();
  const rows = [];
  const trRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      tds.push(tdMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (tds.length < 7 || tds.length > 10) continue;
    const n = tds.length;
    // 表头定位失败或值域异常时，回退"行内首个 0-100 的数"；均取不到 → null（不用错列数据）
    const ratioStr = (() => {
      if (ratioCol >= 1 && ratioCol < n) {
        const v = parseFloat(tds[ratioCol]);
        if (!isNaN(v) && v >= 0 && v <= 100) return tds[ratioCol];
      }
      for (let i = 1; i < n; i++) {
        const v = parseFloat(tds[i]);
        if (!isNaN(v) && v >= 0 && v <= 100) return tds[i];
      }
      return null;
    })();
    const ratio = ratioStr == null ? NaN : parseFloat(ratioStr);
    const rank = parseInt(tds[0], 10);
    if (!tds[1] || !tds[2]) continue;
    rows.push({
      rank: isNaN(rank) ? rows.length + 1 : rank,
      stockCode: tds[1],
      stockName: tds[2],
      navRatio: isNaN(ratio) ? null : ratio,
    });
  }
  return rows;
}

// 幂等 upsert（_id = fundCode_reportDate，重跑不产生垃圾文档）
async function upsertAll(docs) {
  let ok = 0;
  for (let i = 0; i < docs.length; i += WRITE_CONCURRENT) {
    const batch = docs.slice(i, i + WRITE_CONCURRENT);
    const results = await Promise.all(batch.map((d) =>
      db.collection(COLL).doc(`${d.fundCode}_${d.reportDate}`)
        .set({ data: d })
        .then(() => true).catch(() => false)));
    ok += results.filter(Boolean).length;
  }
  return ok;
}
