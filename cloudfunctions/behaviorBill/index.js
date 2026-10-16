const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");

/**
 * 行为成本账单（立场型护城河旗舰，年度报告 hero 同源）
 *
 * 按年分组的操作成本事实——全部历史数据陈述，零建议（合规红线 #2）：
 *   years[]   每年一组（倒序）：操作概览 / 归因分布（未记录单独计数）/ 赎回费演算 /
 *             行为特征（2026-10-16 新增：上涨日买入/下跌日卖出归类）
 *   months[]  按月聚合（2026-10-07 月度复盘新增，倒序最近 24 个月，只出聚合不出明细行）
 *   赎回费演算：每笔卖出按"先进先出"匹配买入批次 → 持有天数 →
 *             套 fund_redemption_fees 的费率分档 → 演算费用；持有不足首个
 *             降档天数计为短持。演算值非账单实付，客户端标注"以交易确认单为准"
 *
 * 口径要点：
 *   - FIFO 需要跨年买入批次配对，故读取该用户全部流水（个人量级几十条），
 *     一遍时间升序遍历同时产出按年聚合与配对费用
 *   - 买入批次不足（数据早于流水记录/导入残缺）的卖出 → uncomputed，不计费也不虚构
 *   - 费率分档缺失（货币/无分档）→ 该基金卖出不计费；费率恰为 0% 照常计入（费用 0 是事实）
 *   - 可传 { year } 只取单年（旧入参兼容）；不传返回全部年份
 *   - 用户校准（按笔，key=交易 _id）：用户按平台实际账单填入真实赎回费后，
 *     该笔优先用实际值（calibrated=true），总额随之更新；清空输入 = 删除校准回到估算
 */

const DAY = 86400000;
const toTs = (d) => Date.parse(String(d || "").slice(0, 10) + "T00:00:00+08:00");

// 费率分档：持有天数 → 该档费率（%）。maxDays=null 为无上界的最后一档
function tierRate(tiers, days) {
  if (!tiers || !tiers.length) return null;
  for (const t of tiers) {
    if (t.maxDays != null && days < t.maxDays) return typeof t.rate === "number" ? t.rate : null;
  }
  const last = tiers[tiers.length - 1];
  return last && last.maxDays == null && typeof last.rate === "number" ? last.rate : null;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "未登录" };
  const ev = event || {};
  const now = new Date(Date.now() + 8 * 3600000);
  const onlyYear = parseInt(ev.year, 10) || 0;

  // 写路径：按笔校准（txId → 实际赎回费；null/空 = 清除校准，回到估算）
  if (ev.action === "saveCalibration") {
    const items = Array.isArray(ev.items) ? ev.items.slice(0, 100) : [];
    if (!items.length) return { code: 400, msg: "无校准项" };
    try { await db.createCollection("fee_calibrations"); } catch (e) { /* 已存在 */ }
    let saved = 0, removed = 0, failed = 0;
    for (const it of items) {
      if (!it || typeof it.txId !== "string" || !it.txId || it.txId.length > 64) continue;
      const id = `${OPENID}_${it.txId}`;
      try {
        const v = it.actualFee;
        if (v == null || v === "" || !isFinite(Number(v))) {
          await db.collection("fee_calibrations").doc(id).remove();
          removed++;
        } else {
          const fee = Math.max(0, +Number(v).toFixed(2));
          await db.collection("fee_calibrations").doc(id).set({ data: { _openid: OPENID, txId: it.txId, actualFee: fee, updatedAt: Date.now() } });
          saved++;
        }
      } catch (e) { failed++; }
    }
    return { code: 0, data: { saved, removed, failed } };
  }

  try {
    // 1) 全部流水（升序；FIFO 配对需要跨年买入批次，个人量级几十条，一次分页读完）
    const trades = [];
    for (let skip = 0; skip < 5000; skip += 1000) {
      const res = await db.collection("transactions")
        .where({ _openid: OPENID })
        .orderBy("date", "asc")
        .skip(skip).limit(1000).get();
      trades.push(...(res.data || []));
      if ((res.data || []).length < 1000) break;
    }
    trades.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

    // 1b) 费率分档：本流水涉及品种批量拉一次（fund_redemption_fees 由快照任务每日维护）
    const fundCodes = [...new Set(trades.map((t) => t.fundCode).filter(Boolean))];
    const tiersMap = {};
    for (let i = 0; i < fundCodes.length; i += 100) {
      const res = await db.collection("fund_redemption_fees")
        .where({ fundCode: _.in(fundCodes.slice(i, i + 100)), ok: true })
        .field({ fundCode: true, tiers: true })
        .get();
      (res.data || []).forEach((f) => { tiersMap[f.fundCode] = f.tiers || []; });
    }

    // 1c) 用户校准（按笔，key=txId）：存在则覆盖该笔估算值
    const calMap = {};
    try {
      const cres = await db.collection("fee_calibrations").where({ _openid: OPENID }).limit(1000).get();
      (cres.data || []).forEach((c) => { if (c.txId && typeof c.actualFee === "number") calMap[c.txId] = c.actualFee; });
    } catch (e) { /* 集合未建（首次使用）时忽略 */ }

    // 1d) 净值涨跌映射（行为特征归类用，2026-10-16）：有流水品种各拉一次历史净值，
    //     按笔数取最活跃的前 20 只防爆量；拿不到的品种其流水归入 unclassified，不虚构方向
    const codeCount = {};
    trades.forEach((t) => { if (t.fundCode) codeCount[t.fundCode] = (codeCount[t.fundCode] || 0) + 1; });
    const behaviorCodes = Object.keys(codeCount)
      .sort((a, b) => codeCount[b] - codeCount[a]).slice(0, 20);
    const changeMap = {}; // code -> { "YYYY-MM-DD": changeRate }
    await Promise.all(behaviorCodes.map(async (code) => {
      try {
        const hist = await fd.fetchNAVHistory(code, 300);
        const m = {};
        (hist || []).forEach((r) => { if (r && r.date && r.changeRate != null) m[r.date] = r.changeRate; });
        if (Object.keys(m).length) changeMap[code] = m;
      } catch (e) { /* 拉不到 → 该品种全部 unclassified */ }
    }));

    // 2) 一遍时间升序遍历：按年聚合（概览/归因）+ 按月聚合（月度复盘用，只出聚合不出明细行）
    //    + FIFO 配对（赎回费逐段套档）。归因分布只计有标签的——未记录单独计数（untagged），
    //    避免与角注意义重复
    const yearsData = {};
    const yearOrder = [];
    const monthsData = {};
    const byFund = {};
    const fundNames = {};
    for (const t of trades) {
      if (!t.date || !t.fundCode) continue;
      const y = t.date.slice(0, 4);
      const mKey = t.date.slice(0, 7);
      const shares = parseFloat(t.shares) || 0;
      const price = parseFloat(t.price) || 0;
      const amount = parseFloat(t.amount) || +(shares * price).toFixed(2);
      const type = t.type === "sell" ? "sell" : t.type === "buy" ? "buy" : null;

      const yd = yearsData[y] || (yearsData[y] = {
        year: +y,
        trades: { total: 0, buy: 0, sell: 0, buyAmount: 0, sellAmount: 0 },
        distMap: {}, tagged: 0, untagged: 0,
        rows: [], computed: 0, uncomputed: 0, feeTotal: 0, shortCount: 0, shortFee: 0, calibratedCount: 0,
        behavior: { chaseBuys: 0, chaseBuyAmount: 0, panicSells: 0, panicSellAmount: 0, classified: 0, unclassified: 0 },
      });
      const md = monthsData[mKey] || (monthsData[mKey] = {
        month: mKey,
        trades: { total: 0, buy: 0, sell: 0, buyAmount: 0, sellAmount: 0 },
        distMap: {}, tagged: 0, untagged: 0,
        redemption: { computed: 0, uncomputed: 0, total: 0, shortCount: 0, shortFee: 0, calibratedCount: 0 },
      });
      yd.trades.total++;
      md.trades.total++;
      if (t.reason) {
        yd.distMap[t.reason] = (yd.distMap[t.reason] || 0) + 1; yd.tagged++;
        md.distMap[t.reason] = (md.distMap[t.reason] || 0) + 1; md.tagged++;
      } else { yd.untagged++; md.untagged++; }
      if (type) {
        yd.trades[type]++;
        md.trades[type]++;
        if (amount > 0) {
          const k = type === "buy" ? "buyAmount" : "sellAmount";
          yd.trades[k] = +(yd.trades[k] + amount).toFixed(2);
          md.trades[k] = +(md.trades[k] + amount).toFixed(2);
        }
        // 行为特征归类（纯数据陈述）：交易当日净值上涨的买入=上涨日买入、下跌的卖出=下跌日卖出；
        // 当日无净值（非交易日/历史拉取失败/货基无涨跌）→ unclassified，不虚构方向
        if (amount > 0) {
          const chg = changeMap[t.fundCode] ? changeMap[t.fundCode][t.date] : undefined;
          if (chg == null) { yd.behavior.unclassified++; }
          else {
            yd.behavior.classified++;
            if (type === "buy" && chg > 0) { yd.behavior.chaseBuys++; yd.behavior.chaseBuyAmount += amount; }
            else if (type === "sell" && chg < 0) { yd.behavior.panicSells++; yd.behavior.panicSellAmount += amount; }
          }
        }
      }
      if (!t.fundName) fundNames[t.fundCode] = fundNames[t.fundCode] || t.fundCode;
      else fundNames[t.fundCode] = t.fundName;

      if (!type || !(shares > 0)) continue;

      // FIFO：卖出从最早未耗尽的买入批次扣份额，逐段按其买入日算持有天数套档
      const batches = (byFund[t.fundCode] = byFund[t.fundCode] || []);
      if (type === "buy") { batches.push({ ts: toTs(t.date), shares }); continue; }

      let need = shares;
      let fee = 0, matchedShares = 0, minDays = null;
      for (const b of batches) {
        if (b.shares <= 0 || need <= 0) continue;
        const use = Math.min(need, b.shares);
        const days = Math.max(0, Math.round((toTs(t.date) - b.ts) / DAY));
        const rate = tierRate(tiersMap[t.fundCode] || [], days);
        const partAmount = amount * (use / shares);
        if (rate != null) { fee += (partAmount * rate) / 100; matchedShares += use; }
        if (minDays == null || days < minDays) minDays = days;
        b.shares -= use;
        need -= use;
      }
      const estimated = matchedShares > 0; // 买入批次缺失（数据早于流水）→ 无法估算，仍列入行供用户按账单校准
      const estFee = estimated ? +fee.toFixed(2) : null;
      const calFee = calMap[t._id];
      const calibrated = typeof calFee === "number";
      const effFee = calibrated ? calFee : (estFee || 0); // 有效费用：校准值优先，其次估算
      const short = estimated && minDays != null && minDays < 7;
      if (estimated) { yd.computed++; md.redemption.computed++; } else { yd.uncomputed++; md.redemption.uncomputed++; }
      if (calibrated) { yd.calibratedCount++; md.redemption.calibratedCount++; }
      yd.feeTotal += effFee;
      md.redemption.total += effFee;
      if (short) { yd.shortCount++; yd.shortFee += effFee; md.redemption.shortCount++; md.redemption.shortFee += effFee; }
      yd.rows.push({
        txId: t._id, fundCode: t.fundCode, fundName: fundNames[t.fundCode] || t.fundCode,
        date: t.date, amount: +amount.toFixed(2), holdDays: minDays,
        fee: estFee, estimated, calibrated, actualFee: calibrated ? calFee : null,
        short,
      });
    }

    // 3) 收口：归因分布聚合、rows 按费用降序截前 20、年份倒序输出；
    //    指定 year 时只返回该年（旧入参兼容）
    const years = Object.keys(yearsData)
      .sort((a, b) => b.localeCompare(a))
      .map((y) => {
        const yd = yearsData[y];
        const reasons = Object.entries(yd.distMap)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count);
        const effOf = (r) => r.calibrated ? r.actualFee : (r.fee != null ? r.fee : -1);
        const sortedRows = yd.rows.sort((a, b) => effOf(b) - effOf(a)).slice(0, 20);
        return {
          year: yd.year,
          trades: {
            total: yd.trades.total, buy: yd.trades.buy, sell: yd.trades.sell,
            buyAmount: +yd.trades.buyAmount.toFixed(2), sellAmount: +yd.trades.sellAmount.toFixed(2),
          },
          reasons, tagged: yd.tagged, untagged: yd.untagged,
          redemption: {
            computed: yd.computed, uncomputed: yd.uncomputed,
            total: +yd.feeTotal.toFixed(2),
            shortCount: yd.shortCount, shortFee: +yd.shortFee.toFixed(2),
            calibratedCount: yd.calibratedCount,
            rows: sortedRows, rowTotal: sortedRows.length,
          },
          behavior: {
            chaseBuys: yd.behavior.chaseBuys,
            chaseBuyAmount: +yd.behavior.chaseBuyAmount.toFixed(2),
            panicSells: yd.behavior.panicSells,
            panicSellAmount: +yd.behavior.panicSellAmount.toFixed(2),
            classified: yd.behavior.classified,
            unclassified: yd.behavior.unclassified,
          },
        };
      })
      .filter((x) => !onlyYear || x.year === onlyYear);

    if (onlyYear && years.length === 0) return { code: 404, msg: `${onlyYear} 年无操作记录` };

    // 按月聚合（月度复盘用）：倒序取最近 24 个月，只出聚合桶不出明细行；指定 year 时按前缀过滤
    const months = Object.keys(monthsData)
      .sort((a, b) => b.localeCompare(a))
      .filter((mk) => !onlyYear || mk.startsWith(String(onlyYear)))
      .slice(0, 24)
      .map((mk) => {
        const md = monthsData[mk];
        return {
          month: md.month,
          trades: {
            total: md.trades.total, buy: md.trades.buy, sell: md.trades.sell,
            buyAmount: +md.trades.buyAmount.toFixed(2), sellAmount: +md.trades.sellAmount.toFixed(2),
          },
          reasons: Object.entries(md.distMap)
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count),
          tagged: md.tagged, untagged: md.untagged,
          redemption: {
            computed: md.redemption.computed, uncomputed: md.redemption.uncomputed,
            total: +md.redemption.total.toFixed(2),
            shortCount: md.redemption.shortCount, shortFee: +md.redemption.shortFee.toFixed(2),
            calibratedCount: md.redemption.calibratedCount,
          },
        };
      });

    return { code: 0, data: { years, months } };
  } catch (e) {
    console.error("behaviorBill 失败:", e.message);
    return { code: 500, msg: "行为成本账单生成失败" };
  }
};
