const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { historyDays, testOpenid, withAnalysis, withNav60 } = event || {};
  const uid = testOpenid || OPENID;
  if (!uid) return { code: 400, msg: "无用户标识" };
  const _startTime = Date.now();

  try {
    // 持仓查询：只取聚合所需字段（.field() 投影，避免全量文档传输）+ 1000 条上限（原默认 100 会截断大持仓用户）
    const res = await db.collection("holdings")
      .where({ _openid: uid })
      .field({ fundCode: true, fundName: true, shares: true, amount: true, buyPrice: true, nav: true, marketValue: true, holdingReturn: true, createTime: true, group: true })
      .limit(1000)
      .get();
    const holdings = res.data || [];

    if (holdings.length === 0) {
      return {
        code: 0,
        data: { holdings: [], totalAmount: "0.00", todayProfit: "0.00",
          todayProfitRate: "0.00", totalReturn: "0.00", totalReturnRate: "0.00", updateTime: "" },
      };
    }

    let totalCost = 0, totalYesterdayMarket = 0, totalTodayProfit = 0;
    let updateTime = "";
    const navHistoryMap = {};

    // 批量请求估值（N 合 1），再并行获取东方财富最新净值与历史净值
    // 历史净值合并为一次请求（max(60, historyDays)），内存拆分 nav60，避免重复拉取
    const codes = holdings.map((h) => h.fundCode);
    const tiantianMap = await computeSelfEstimates(codes, _startTime);
    // withNav60=false（correlation-matrix 等仅需列表）跳过历史净值拉取，只取最新净值
    const needDays = historyDays || (withNav60 === false ? 0 : 60);
    // 分批限并发（8 只/批 + 150ms 间隔），避免瞬时大量外部请求被风控
    const CONCURRENT = 8;
    const resultsList = [];
    for (let i = 0; i < holdings.length; i += CONCURRENT) {
      const batch = holdings.slice(i, i + CONCURRENT);
      const batchResults = await Promise.all(batch.map(async (h) => {
        try {
          const tiantian = tiantianMap[h.fundCode] || {};
          // 净值与历史净值并行拉取（needDays=0 时只取净值，避免串行翻倍耗时）
          let eastmoney, navHistoryAll = [];
          if (needDays > 0) {
            [eastmoney, navHistoryAll] = await Promise.all([
              fd.fetchLatestNavEastMoney(h.fundCode),
              fd.fetchNAVHistory(h.fundCode, needDays),
            ]);
          } else {
            eastmoney = await fd.fetchLatestNavEastMoney(h.fundCode);
          }
          return {
            h, tiantian,
            eastmoney,
            nav60: needDays > 0 ? (navHistoryAll || []).slice(0, 60) : [],
            navHistory: historyDays ? (navHistoryAll || []) : null,
          };
        } catch (e) {
          console.error(`获取基金 ${h.fundCode} 失败:`, e);
          return { h, tiantian: {}, eastmoney: {}, nav60: [], navHistory: [] };
        }
      }));
      resultsList.push(...batchResults);
      if (i + CONCURRENT < holdings.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    const enriched = [];
    let totalMarket = 0;

    for (const { h, tiantian, eastmoney, navHistory, nav60 } of resultsList) {
      // 向后兼容：旧数据用 amount/nav 字段（金额/净值），新数据用 shares/buyPrice
      let shares = h.shares || 0;
      let buyPrice = h.buyPrice || h.nav || 0;
      const dbMarketValue = h.marketValue || 0;
      const dbHoldingReturn = h.holdingReturn || 0;

      // 旧 schema { amount, nav } 修复：amount 是持仓金额不是份额
      if (!shares && h.amount && buyPrice > 0) {
        shares = parseFloat(h.amount) / buyPrice;
      }

      // 昨日净值兜底链：东方财富 day-1 → 东方财富当前 → 数据库存储值
      const yesterdayNav = eastmoney.yesterdayNav || eastmoney.actualNav || h.nav || null;
      const yesterdayNavSafe = yesterdayNav || 0;

      let currentNav = eastmoney.actualNav || tiantian.nav || null;
      // 单只基金数据源全挂时降级：用昨日净值兜底，仍拿不到则置 null，
      // 绝不能让一只失败基金拖垮整个持仓接口
      if (!currentNav || currentNav <= 0) {
        currentNav = yesterdayNavSafe > 0 ? yesterdayNavSafe : null;
      }
      let todayChangeRate = 0;
      let todayProfitAmount = 0;

      if (historyDays && navHistory) {
        navHistoryMap[h.fundCode] = navHistory;
      }

      // OCR 导入兜底：当 shares 或 buyPrice 为 0 时，用 OCR 提取的市值/收益反推
      if ((!shares || !buyPrice) && dbMarketValue > 0 && currentNav > 0) {
        if (!shares) shares = dbMarketValue / currentNav;
        if (!buyPrice && shares > 0) {
          buyPrice = currentNav - (dbHoldingReturn / shares);
          if (buyPrice <= 0) buyPrice = currentNav;
        }
      }

      // 今日净值是否已公布（北京时间 = UTC，净值日期无时区问题）
      const now = new Date();
      const todayStr = fd.formatBJDate(now);
      const estimateUpdated = eastmoney.actualDate === todayStr;
      if (!estimateUpdated && tiantian.estimatedChangeRate != null) {
        console.log(`[enrich] ${h.fundCode} 使用自主估算 estChangeRate=${tiantian.estimatedChangeRate} todayStr=${todayStr} actualDate=${eastmoney.actualDate}`);
      }

      if (!estimateUpdated && tiantian.estimatedChangeRate != null && yesterdayNav != null) {
        // 今日净值未公布 → 自主估算模式：用持仓股实时涨跌加权计算
        todayProfitAmount = yesterdayNav * tiantian.estimatedChangeRate / 100 * shares;
        todayChangeRate = tiantian.estimatedChangeRate;
      } else if (currentNav != null && yesterdayNav != null && currentNav !== yesterdayNav) {
        // 今日净值已公布 → 精确模式
        todayProfitAmount = (currentNav - yesterdayNav) * shares;
        todayChangeRate = eastmoney.actualChangeRate || 0;
      } else {
        todayChangeRate = eastmoney.actualChangeRate || 0;
      }

      totalYesterdayMarket += yesterdayNavSafe * shares;
      if (tiantian.estimateTime) updateTime = tiantian.estimateTime;

      const costValue = buyPrice * shares;
      const marketValue = currentNav != null ? currentNav * shares : dbMarketValue;
      const totalReturn = marketValue - costValue;
      const totalReturnRate = costValue > 0 ? ((totalReturn / costValue) * 100) : 0;
      // 单只基金当日收益率：今日收益 / 昨日市值（客户端当日收益列按此排序）
      const todayProfitRate = shares > 0 && yesterdayNav > 0 ? ((todayProfitAmount / (yesterdayNav * shares)) * 100) : 0;

      totalCost += costValue;
      totalMarket += marketValue;
      totalTodayProfit += todayProfitAmount;

      // 60 日位置信号
      let position = null, navHigh = null, navLow = null;
      if (nav60 && nav60.length >= 5) {
        const navs = nav60.map(d => d.nav || 0).filter(v => v > 0);
        if (navs.length >= 5) {
          const high = Math.max(...navs);
          const low = Math.min(...navs);
          navHigh = high;
          navLow = low;
          const range = high - low;
          if (range > 0 && currentNav != null) position = Math.round(((currentNav - low) / range) * 100);
        }
      }

      enriched.push({
        ...h,
        shares,
        buyPrice,
        currentNav: currentNav != null ? currentNav.toFixed(4) : null,
        marketValue: marketValue.toFixed(2),
        todayChangeRate: todayChangeRate.toFixed(2),
        todayProfit: todayProfitAmount.toFixed(2),
        todayProfitRate: todayProfitRate.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        estimateUpdated,
        actualDate: eastmoney.actualDate || null,  // 最新净值日：客户端按交易日冻结缓存用
        position,
        navHigh: navHigh != null ? navHigh.toFixed(4) : null,
        navLow: navLow != null ? navLow.toFixed(4) : null,
      });
    }

    const todayProfitRate = totalYesterdayMarket > 0 ? ((totalTodayProfit / totalYesterdayMarket) * 100) : 0;
    const totalReturn = totalMarket - totalCost;
    const totalReturnRate = totalCost > 0 ? ((totalReturn / totalCost) * 100) : 0;

    const today = fd.formatBJDate();

    // 按当日收益金额倒序排序
    enriched.sort((a, b) => parseFloat(b.todayProfit) - parseFloat(a.todayProfit));

    // 读取 PE 温度缓存（由 computeFundTemperature 凌晨定时写入）
    // 当前日期无记录时回退最近一个有温度的日期（凌晨任务偶发失败/未跑到时，
    // 两页仍读到同一份温度——此前列表页 position 兜底与详情页温度口径分裂致对不上）
    let tempMap = {};
    const tempDebug = {};
    try {
      const tempCodes = enriched.map(h => h.fundCode);
      // 逐基金取各自最新温度（并发 12 次单查，成本可控）：凌晨任务可能只跑完部分基金，
      // 每基金独立按 date desc 取最新——列表页永远与详情页（fetchFundEstimate 同逻辑）同源
      const tempRows = await Promise.all(tempCodes.map(async (c) => {
        try {
          const res = await db.collection("fund_temperatures")
            .where({ fundCode: c })
            .orderBy("date", "desc").limit(1)
            .field({ fundCode: true, date: true, signal: true, label: true, normPE: true, weightedPE: true, coverage: true, stocksWith52w: true, totalStocks: true, detailPEs: true })
            .get();
          return (res.data && res.data[0]) || null;
        } catch (e) { return null; }
      }));
      tempRows.forEach(t => { if (t) tempMap[t.fundCode] = t; });
      tempDebug.found = tempRows.filter(Boolean).length;
      // 缺失温度的基金不在请求内重计算（每只持仓股一个 HTTP，会拖垮用户请求）：
      // 首页有 position 兜底展示，凌晨定时任务会补全缺失温度

      enriched.forEach(h => {
        // 债基/货基不适用估值，清空所有估值相关字段
        if (/债|债券|纯债|转债|货币|货基/.test(h.fundName || "")) {
          h.peTemp = { signal: "nodata" };
          h.position = null;
          h.navHigh = null;
          h.navLow = null;
          return;
        }
        const t = tempMap[h.fundCode];
        if (t) {
          h.peTemp = {
            signal: t.signal,
            label: ft.sanitizeLabel(t.label),
            normPE: t.normPE,
            weightedPE: t.weightedPE,
            coverage: t.coverage,
            stocksWith52w: t.stocksWith52w,
            totalStocks: t.totalStocks,
          };
          // 主打行业定位优先级：基金名称（契约主题，基金公司自我定位最准）→ 持仓大类聚合（实际暴露）→ 不标
          const nameHit = ft.classifyMajorIndustry(h.fundName);
          if (nameHit && nameHit !== "其他") {
            h.peTemp.topIndustry = nameHit;
          } else if (t.detailPEs && t.detailPEs.length) {
            // 名称无行业指向（蓝筹/均衡类）→ 按重仓股大类聚合推断实际暴露
            if (t.detailPEs && t.detailPEs.length) {
              const agg = {};
              t.detailPEs.forEach(pe => {
                const cat = ft.classifyMajorIndustry(pe.industry, pe.name);
                agg[cat] = (agg[cat] || 0) + (pe.ratio || 0);
              });
              const topCat = Object.entries(agg)
                .filter(([k]) => k !== "其他")
                .sort((a, b) => b[1] - a[1])[0];
              if (topCat) h.peTemp.topIndustry = topCat[0];
            }
          }
        }
      });
    } catch (e) { console.warn("[getPortfolio] 读取 PE 温度失败:", e.message); }

    // 查询当天收益快照；非交易日/当天无快照时回退最近一个有快照的交易日（走势图对比完整分时）
    let intradaySnapshots = [];
    let snapDate = today;
    let snapDebug = {};
    try {
      const snapRes = await db.collection("profit_snapshots").where({ _openid: uid, date: today }).get();
      snapDebug = { openid: uid, date: today, found: snapRes.data ? snapRes.data.length : 0 };
      if (snapRes.data && snapRes.data.length > 0) {
        intradaySnapshots = snapRes.data[0].points || [];
        snapDebug.points = intradaySnapshots.length;
      } else {
        // 非交易时段（周末/节假日）当天无快照 → 回退最近一个有快照的交易日（每天 1 条，limit 60 覆盖 30 天）；
        // 交易时段缺失不回退，交由下方"快照兜底"写当天新点，避免混合两日曲线
        const bj = new Date(Date.now() + 8 * 3600000);
        const bjMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
        const inTradingNow = bj.getUTCDay() >= 1 && bj.getUTCDay() <= 5 && ((bjMin >= 570 && bjMin < 690) || (bjMin >= 780 && bjMin <= 900));
        if (!inTradingNow) {
          const start = fd.formatBJDate(new Date(Date.now() - 30 * 86400000));
          const fbRes = await db.collection("profit_snapshots")
            .where({ _openid: uid, date: _.gte(start) })
            .field({ date: true, points: true })
            .limit(60)
            .get();
          const rows = (fbRes.data || []).sort((a, b) => b.date.localeCompare(a.date));
          const lastRow = rows[0];
          if (lastRow && lastRow.date < today && lastRow.points && lastRow.points.length > 0) {
            intradaySnapshots = lastRow.points;
            snapDate = lastRow.date;
            snapDebug.fallback = lastRow.date;
            snapDebug.fallbackPoints = intradaySnapshots.length;
          }
        }
      }
    } catch (e) { snapDebug = { error: e.message }; }

    // 资产配置：按行业聚合持仓穿透（correlation-matrix 等仅需列表的调用可传 withAnalysis:false 跳过）
    let assetAllocation = null;
    let healthScore = null;
    if (withAnalysis !== false) {
    try {
      let enrichedCount = 0, withTempCount = 0, withDetailCount = 0;
      const industryMap = {};
      let totalWeight = 0;
      let totalHoldingsValue = 0, coveredHoldingsValue = 0; // 穿透覆盖率：有行业明细的持仓市值占比
      for (const h of enriched) {
        if (!h.peTemp || !h.peTemp.totalStocks) continue;
        enrichedCount++;
        const fundValue = (parseFloat(h.shares) || 0) * (parseFloat(h.currentNav) || 0);
        if (fundValue <= 0) continue;
        totalHoldingsValue += fundValue;
        withTempCount++;
        const t = tempMap[h.fundCode];
        if (!t || !t.detailPEs || !t.detailPEs.length) continue;
        withDetailCount++;
        coveredHoldingsValue += fundValue;
        for (const pe of t.detailPEs) {
          const w = fundValue * (pe.ratio / 100);
          const cat = ft.classifyIndustryLabel(pe.industry, pe.name);
          industryMap[cat] = (industryMap[cat] || 0) + w;
          totalWeight += w;
        }
      }
      if (totalWeight > 0) {
        console.log(`[getPortfolio] 资产配置: enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount} totalWeight=${totalWeight.toFixed(0)} industries=${Object.keys(industryMap).length}`);
        const list = Object.entries(industryMap)
          .map(([industry, w]) => ({ industry, raw: (w / totalWeight) * 100 }))
          .sort((a, b) => b.raw - a.raw);
        // 分离「其他」与真实行业；top20 只排真实行业，其余全合并到一个「其他」
        const realList = list.filter(i => i.industry !== "其他");
        const otherRaw = list.filter(i => i.industry === "其他").reduce((s, i) => s + i.raw, 0);
        const top10 = realList.slice(0, 20).map(i => ({ industry: i.industry, percent: +i.raw.toFixed(1) }));
        const overflow = realList.slice(20).reduce((s, i) => s + i.raw, 0);
        const totalOthers = otherRaw + overflow;
        if (totalOthers > 0.05) top10.push({ industry: "其他", percent: +totalOthers.toFixed(1) });
        // 归一化
        const sum = top10.reduce((s, i) => s + i.percent, 0);
        if (top10.length > 0 && Math.abs(sum - 100) > 0.01) {
          top10[0].percent = +(top10[0].percent + (100 - sum)).toFixed(1);
        }
        const maxReal = top10.find(i => i.industry !== "其他");
        const maxPercent = maxReal ? maxReal.percent : 0;
        const maxName = maxReal ? maxReal.industry : "";
        assetAllocation = {
          items: top10,
          // 穿透覆盖率：行业明细只来自前十大重仓股 + 温度任务已覆盖的基金，
          // 覆盖率低时穿透占比仅代表已覆盖部分，页面需明示
          coverage: totalHoldingsValue > 0 ? +((coveredHoldingsValue / totalHoldingsValue) * 100).toFixed(1) : null,
          warning: maxPercent > 30 ? `单一行业「${maxName}」占比 ${maxPercent}%，建议分散配置` : null,
        };
      } else {
        console.log(`[getPortfolio] 资产配置: 无有效数据 enriched=${enrichedCount} withTemp=${withTempCount} withDetail=${withDetailCount}`);
      }
    } catch (e) { console.error("[getPortfolio] 资产配置失败:", e.message, e.stack); assetAllocation = null; }

    // 持仓健康分
    try {
      const tempScores = [];
      enriched.forEach(h => {
        if (h.peTemp && h.peTemp.normPE > 0) tempScores.push(h.peTemp.normPE);
      });
      const avgNormPE = tempScores.length > 0 ? tempScores.reduce((a, b) => a + b, 0) / tempScores.length : null;
      // 与统一信号阈值 0.75/1.25 对齐
      const tempScore = avgNormPE != null
        ? (avgNormPE < 0.75 ? 90 : avgNormPE < 1.0 ? 70 : avgNormPE < 1.25 ? 50 : 30)
        : 50;
      const maxIndustry = assetAllocation && assetAllocation.items && assetAllocation.items.length > 0
        ? (assetAllocation.items.find(i => i.industry !== "其他") || assetAllocation.items[0]).percent : 0;
      const concScore = maxIndustry < 30 ? 90 : maxIndustry < 50 ? 70 : maxIndustry < 70 ? 50 : 30;
      const score = Math.round(tempScore * 0.5 + concScore * 0.5);
      const grade = score >= 80 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
      healthScore = { score, grade, avgNormPE: avgNormPE != null ? +avgNormPE.toFixed(2) : null, maxIndustry, tempScore, concScore };
    } catch (e) { console.error("[getPortfolio] 健康分计算失败:", e.message); }
    }

    // 分组维度汇总
    const groupMap = {};
    enriched.forEach(h => {
      const g = h.group || "未分组";
      if (!groupMap[g]) {
        groupMap[g] = { name: g, count: 0, totalAmount: 0, todayProfit: 0, totalReturn: 0, todayProfitRate: 0, totalReturnRate: 0, yesterdayMarket: 0, totalCost: 0 };
      }
      groupMap[g].count++;
      groupMap[g].totalAmount += parseFloat(h.marketValue) || 0;
      groupMap[g].todayProfit += parseFloat(h.todayProfit) || 0;
      groupMap[g].totalReturn += parseFloat(h.totalReturn) || 0;
      // 累计昨日市值和总成本用于计算分组收益率
      const shares = parseFloat(h.shares) || 0;
      const buyPrice = parseFloat(h.buyPrice) || 0;
      const currentNav = parseFloat(h.currentNav) || 0;
      const todayChangeRate = parseFloat(h.todayChangeRate) || 0;
      if (shares > 0 && currentNav > 0) {
        const yesterdayNav = todayChangeRate !== 0 ? currentNav / (1 + todayChangeRate / 100) : currentNav;
        groupMap[g].yesterdayMarket += yesterdayNav * shares;
        groupMap[g].totalCost += buyPrice * shares;
      }
    });
    const groups = Object.values(groupMap).map(g => {
      const tpr = g.yesterdayMarket > 0 ? ((g.todayProfit / g.yesterdayMarket) * 100) : 0;
      const trr = g.totalCost > 0 ? ((g.totalReturn / g.totalCost) * 100) : 0;
      return {
        name: g.name,
        count: g.count,
        totalAmount: g.totalAmount.toFixed(2),
        todayProfit: g.todayProfit.toFixed(2),
        todayProfitRate: tpr.toFixed(2),
        totalReturn: g.totalReturn.toFixed(2),
        totalReturnRate: trr.toFixed(2),
      };
    });

    // ---- 快照兜底：定时任务（snapshotProfit）未写快照时，用户打开小程序也能留点 ----
    // 仅在交易时段补（与定时任务语义一致），距上一点 >= 1 分钟才写（快照已分钟粒度，与新定时同步）
    try {
      const _bj = new Date(Date.now() + 8 * 3600000);
      const _day = _bj.getUTCDay();
      const _min = _bj.getUTCHours() * 60 + _bj.getUTCMinutes();
      const _inTrading = _day >= 1 && _day <= 5 && ((_min >= 570 && _min < 690) || (_min >= 780 && _min <= 900));
      if (_inTrading) {
        const _last = intradaySnapshots[intradaySnapshots.length - 1];
        const _lastMin = _last ? parseInt(_last.time.slice(0, 2)) * 60 + parseInt(_last.time.slice(3, 5)) : -Infinity;
        if (_min - _lastMin >= 1) {
          const _time = `${String(_bj.getUTCHours()).padStart(2, "0")}:${String(_bj.getUTCMinutes()).padStart(2, "0")}`;
          const _rate = +todayProfitRate.toFixed(2);
          const _doc = await db.collection("profit_snapshots").where({ _openid: uid, date: today }).get();
          if (_doc.data && _doc.data.length > 0) {
            // 与 snapshotProfit 定时器竞态：读到的文档可能已含同分钟点（read-then-push 双写），先检查再 push
            const _exists = (_doc.data[0].points || []).some(p => p.time === _time);
            if (_exists) {
              if (!intradaySnapshots.some(p => p.time === _time)) intradaySnapshots.push({ time: _time, rate: _rate });
            } else {
              await db.collection("profit_snapshots").doc(_doc.data[0]._id).update({
                data: { points: _.push({ time: _time, rate: _rate }) },
              });
              // update 分支同样同步本地数组，本次响应带上最新点
              if (!intradaySnapshots.some(p => p.time === _time)) intradaySnapshots.push({ time: _time, rate: _rate });
            }
          } else {
            await db.collection("profit_snapshots").add({
              data: { _openid: uid, date: today, points: [{ time: _time, rate: _rate }] },
            });
          }
          intradaySnapshots.sort((a, b) => a.time.localeCompare(b.time));
        }
      }
    } catch (e) { console.warn("[getPortfolio] 快照兜底失败:", e.message); }

    return {
      code: 0,
      data: {
        holdings: enriched,
        totalAmount: totalMarket.toFixed(2),
        todayProfit: totalTodayProfit.toFixed(2),
        todayProfitRate: todayProfitRate.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        updateTime,
        navHistoryMap: historyDays ? navHistoryMap : undefined,
        intradaySnapshots,
        snapDate,
        snapDebug,
        tempDebug,
        assetAllocation,
        healthScore,
        groups,
      },
    };
  } catch (e) {
    console.error("获取持仓失败:", e);
    return { code: 500, msg: "获取持仓失败" };
  }
};

// ---- 自主计算基金估算涨跌（取代已下线的天天基金 API） ----
// 持仓复用 snapshotProfit 建好的 DB 缓存：fund_temperatures.detailPEs（凌晨定时任务）→
// fund_holdings_cache（当日）→ 实时拉取兜底并写缓存。股票行情全局只拉一次，跨用户共享。
async function computeSelfEstimates(codes, startTime) {
  const map = {};
  if (!codes || codes.length === 0) return map;
  const _start = startTime || Date.now();
  const el = () => Date.now() - _start;

  // 仅工作日计算（周一至周五），不限时段
  // 盘中用实时股价，盘后用收盘价，净值公布后 enrichment 自动切到精确值
  if (!fd.isBJWeekday()) {
    console.log(`[computeSelfEstimates] 周末, 跳过自主估算`);
    return map;
  }
  const today = fd.formatBJDate();

  try {
    // 1. 持仓来源：温度表 detailPEs → fund_holdings_cache → 实时兜底（写入缓存）
    const holdingsMap = {};
    const known = new Set();

    // 1a) 温度表（凌晨 computeFundTemperature 已算好，含股票代码与占比）
    try {
      const BATCH = 100;
      for (let i = 0; i < codes.length; i += BATCH) {
        const res = await db.collection("fund_temperatures")
          .where({ fundCode: _.in(codes.slice(i, i + BATCH)), date: today })
          .field({ fundCode: true, detailPEs: true })
          .get();
        (res.data || []).forEach(t => {
          if (t.detailPEs && t.detailPEs.length > 0) {
            holdingsMap[t.fundCode] = t.detailPEs.map(p => ({ stockCode: p.code, navRatio: p.ratio }));
            known.add(t.fundCode);
          }
        });
      }
    } catch (e) { console.warn("[computeSelfEstimates] 读温度表持仓失败:", e.message); }

    // 1b) 当日持仓缓存（snapshotProfit/本函数先前兜底拉取的结果）
    try {
      const BATCH = 100;
      for (let i = 0; i < codes.length && el() < 30000; i += BATCH) {
        const res = await db.collection("fund_holdings_cache")
          .where({ fundCode: _.in(codes.slice(i, i + BATCH)), date: today })
          .get();
        (res.data || []).forEach(d => {
          if (d.holdings && d.holdings.length > 0 && !known.has(d.fundCode)) {
            holdingsMap[d.fundCode] = d.holdings.map(h => ({ stockCode: h.stockCode, navRatio: h.navRatio }));
            known.add(d.fundCode);
          }
        });
      }
    } catch (e) { console.warn("[computeSelfEstimates] 读持仓缓存失败:", e.message); }

    // 1c) 缺失的基金实时拉取，结果写当日缓存（每只基金每天只拉一次）
    const missing = codes.filter(c => !known.has(c));
    if (missing.length > 0 && el() < 30000) {
      const CONCURRENT = 10;
      let fetched = 0;
      for (let i = 0; i < missing.length && el() < 30000; i += CONCURRENT) {
        const batch = missing.slice(i, i + CONCURRENT);
        const results = await Promise.all(batch.map(async (code) => {
          try {
            const h = await fd.fetchTempHoldings(code);
            if (h && h.length > 0) {
              // _id=fundCode_date 幂等 upsert，避免并发重复 add 累积垃圾文档
              await db.collection("fund_holdings_cache")
                .doc(`${code}_${today}`)
                .set({ data: { fundCode: code, date: today, holdings: h } })
                .catch(() => {});
            }
            return { code, holdings: h, ok: h && h.length > 0 };
          } catch (e) { return { code, holdings: [], ok: false }; }
        }));
        results.forEach(r => {
          if (r.ok) {
            holdingsMap[r.code] = r.holdings.map(h => ({ stockCode: h.stockCode, navRatio: h.navRatio }));
            known.add(r.code); fetched++;
          }
        });
      }
      if (fetched > 0) console.log(`[computeSelfEstimates] 实时兜底拉取持仓 ${fetched} 只，仍缺 ${codes.length - known.size} 只 t=${el()}ms`);
    }

    // 2. 全量股票行情只拉一次（所有基金持仓股并集，限预算；超预算则跳过估算，走 position/精确模式兜底）
    const stockSet = new Set();
    for (const holdings of Object.values(holdingsMap)) {
      holdings.forEach(h => {
        if (h.stockCode && h.stockCode.length >= 4) stockSet.add(h.stockCode);
      });
    }
    let stockPriceMap = {};
    if (el() < 60000 && stockSet.size > 0) {
      stockPriceMap = await fd.fetchStockPricesTencent([...stockSet]);
    }

    // 3. 逐基金计算加权涨跌：指数基金优先用跟踪指数实时行情，否则持仓股加权
    // 3-前置：批量取跟踪指数（带 fund_index_cache 缓存，缺的补拉写回），一次请求完成，避免逐只 HTTP
    const trackMap = await fd.getTrackIndexBatchCached(db, codes);
    const timeStr = fd.formatBJTime();
    for (const code of codes) {
      // 3a) 指数优先：东财 INDEXCODE 覆盖所有指数基金（行业天然全覆盖），用指数实时涨跌幅估算
      let estChange = null;
      const track = trackMap[code];
      if (track && track.indexCode) {
        try {
          const idx = await fd.fetchIndexRealtime(track.indexCode);
          if (idx && idx.changeRate != null) estChange = idx.changeRate;
        } catch (e) { /* ignore */ }
      }

      // 3b) 持仓加权兜底：非指数基金 / 指数行情失败时，用持仓股实时涨跌加权
      if (estChange == null) {
        const holdings = holdingsMap[code];
        if (!holdings || holdings.length === 0) continue;
        let totalRatio = 0, weightedChange = 0;
        for (const h of holdings) {
          const price = stockPriceMap[h.stockCode];
          if (!price || price.changeRate == null) continue;
          totalRatio += h.navRatio;
          weightedChange += price.changeRate * h.navRatio;
        }
        if (totalRatio > 0) {
          estChange = +(weightedChange / totalRatio).toFixed(2);
          map[code] = {
            fundCode: code,
            fundName: "",
            nav: null,
            estimatedNav: null,
            estimatedChangeRate: estChange,
            estimateTime: timeStr,
            _coverage: +totalRatio.toFixed(1),
          };
        }
      } else {
        map[code] = {
          fundCode: code,
          fundName: "",
          nav: null,
          estimatedNav: null,
          estimatedChangeRate: estChange,
          estimateTime: timeStr,
          _coverage: 0,
        };
      }
    }
  } catch (e) {
    console.error("自主估算失败:", e.message);
  }

  return map;
}
