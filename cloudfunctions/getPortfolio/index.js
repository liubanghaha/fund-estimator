const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require("https");
const db = cloud.database();
const _ = db.command;
const fd = require("./_shared/fund-data");
const ft = require("./_shared/fund-temperature");
const td = require("./_shared/trading-day");

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { historyDays, testOpenid, withAnalysis, withNav60, src, debug } = event || {};
  const estSrc = src === "self" ? "self" : "sina"; // sina=数据源一（新浪实时估值）优先；self=数据源二（自算）优先
  const uid = testOpenid || OPENID;
  if (!uid) return { code: 400, msg: "无用户标识" };

  // 费用账单（收益页"费用后收益"卡）：独立轻 action，不进入主链路的估值聚合
  if (event && event.action === "feeSummary") {
    return await handleFeeSummary(uid);
  }

  const _startTime = Date.now();

  try {
    // 持仓查询：游标分页读全（_id > lastId，100/批，与 computeFundTemperature.getUniqueFundCodes 同款），
    // .limit(1000) 会静默截断超大持仓用户；.field() 投影避免全量文档传输
    const holdings = [];
    {
      const PAGE = 100;
      let lastId = "";
      while (true) {
        const res = await db.collection("holdings")
          .where(lastId ? { _openid: uid, _id: _.gt(lastId) } : { _openid: uid })
          .orderBy("_id", "asc") // 游标分页显式定序，不依赖底层默认序
          .field({ fundCode: true, fundName: true, shares: true, amount: true, buyPrice: true, nav: true, marketValue: true, holdingReturn: true, createTime: true, group: true, platform: true })
          .limit(PAGE)
          .get();
        const rows = res.data || [];
        holdings.push(...rows);
        if (rows.length < PAGE) break;
        lastId = rows[rows.length - 1]._id;
      }
    }

    if (holdings.length === 0) {
      return {
        code: 0,
        data: { holdings: [], platforms: [], totalAmount: "0.00", baseValue: "0.00", todayProfit: "0.00",
          todayProfitRate: "0.00", totalReturn: "0.00", totalReturnRate: "0.00", updateTime: "" },
      };
    }

    let updateTime = "";
    const navHistoryMap = {};

    // 批量请求估值（N 合 1），再并行获取东方财富最新净值与历史净值
    // 历史净值合并为一次请求（max(60, historyDays)），内存拆分 nav60，避免重复拉取
    const codes = [...new Set(holdings.map((h) => h.fundCode))];
    // 自算与数据源一互不依赖 → 并行，避免串行叠加延迟（新浪多批时会明显拖慢首页）；
    // 新浪给 15s 总预算：到点用已拿到的部分，宁缺不拖垮函数（getPortfolio 超时 60s）
    const [tiantianMap, sinaMap] = await Promise.all([
      computeSelfEstimates(codes, _startTime),
      fd.fetchSinaEstimates(codes, { budgetMs: 15000 }),
    ]);
    // withNav60=false（correlation-matrix 等仅需列表）跳过历史净值拉取，只取最新净值
    const needDays = historyDays || (withNav60 === false ? 0 : 60);
    // 分批限并发（8 只/批 + 150ms 间隔），避免瞬时大量外部请求被风控。
    // 按基金代码去重后再拉：同一基金在多个平台各一笔时，净值/历史只请求一次
    const CONCURRENT = 8;
    const uniqueCodes = [...new Set(holdings.map((h) => h.fundCode))];
    const navByCode = {};
    for (let i = 0; i < uniqueCodes.length; i += CONCURRENT) {
      const batch = uniqueCodes.slice(i, i + CONCURRENT);
      const batchResults = await Promise.all(batch.map(async (code) => {
        try {
          // 净值与历史净值并行拉取（needDays=0 时只取净值，避免串行翻倍耗时）
          let eastmoney, navHistoryAll = [];
          if (needDays > 0) {
            [eastmoney, navHistoryAll] = await Promise.all([
              fd.fetchLatestNavEastMoney(code),
              fd.fetchNAVHistory(code, needDays),
            ]);
          } else {
            eastmoney = await fd.fetchLatestNavEastMoney(code);
          }
          return {
            code, eastmoney,
            nav60: needDays > 0 ? (navHistoryAll || []).slice(0, 60) : [],
            navHistory: historyDays ? (navHistoryAll || []) : null,
          };
        } catch (e) {
          console.error(`获取基金 ${code} 失败:`, e);
          return { code, eastmoney: {}, nav60: [], navHistory: [] };
        }
      }));
      batchResults.forEach((r) => { navByCode[r.code] = r; });
      if (i + CONCURRENT < uniqueCodes.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }
    const resultsList = holdings.map((h) => {
      const n = navByCode[h.fundCode] || { eastmoney: {}, nav60: [], navHistory: [] };
      return {
        h, tiantian: tiantianMap[h.fundCode] || {},
        eastmoney: n.eastmoney, nav60: n.nav60, navHistory: n.navHistory,
      };
    });

    const enriched = [];

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

      // 数据所属日：当日 9:25 起（含盘后当晚）展示今日——集合竞价开盘价 9:25 定出，从这一刻起
      // 就有"今日估值"可展示，不必等到 9:30；盘中估算、晚间净值公布后精确。
      // 次日凌晨到 9:25 前与周末/节假日展示最近交易日——净值已确定，按精确口径（此前按 todayStr
      // 硬比导致午夜后把已确定净值误判为"今日未公布"，整组合退回自算估算口径）
      const now = new Date();
      const todayStr = fd.formatBJDate(now);
      const bjNow = new Date(now.getTime() + 8 * 3600000);
      const bjDay = bjNow.getUTCDay();
      const bjMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
      const openedToday = bjDay >= 1 && bjDay <= 5 && bjMin >= fd.OPEN_MIN && td.isTradingDay(todayStr);
      // lastTradingDay 含当天（9/10 凌晨直接传今天会返回 9/10），取"上一交易日"须从昨天回找
      const displayDay = openedToday ? todayStr : td.lastTradingDay(addDays(todayStr, -1));
      const estimateUpdated = eastmoney.actualDate === displayDay;
      // 估算源选择：sina=数据源一（新浪估值当日有效时覆盖自算）；self=数据源二（自算优先，新浪兜底）
      const sn = sinaMap[h.fundCode] || {};
      // 这里恒比 todayStr（今日估算的日期必须是今天）；不用 displayDay——9:25 前/周末新浪那份
      // 属于上一交易日，本就该丢弃，交给下面的"无今日估值"分支
      const sinaToday = sn.date != null && (_gdIsToday(sn.date, todayStr)) && sn.changeRate != null;
      let estRate = tiantian.estimatedChangeRate != null ? tiantian.estimatedChangeRate : (sinaToday ? sn.changeRate : null);
      let estSource = tiantian.estimatedChangeRate != null ? "self" : (sinaToday ? "sina" : "");
      if (estSrc === "sina" && sinaToday && tiantian.estimatedChangeRate != null) {
        estRate = sn.changeRate; estSource = "sina";
      }
      if (estRate != null) {
        console.log(`[enrich] ${h.fundCode} 估算 source=${estSource} rate=${estRate} todayStr=${todayStr} actualDate=${eastmoney.actualDate}`);
      }

      // 涨跌基准净值：今日收益与收益率的比较基准，必须与所用算式配对——
      //  - 估算模式（今日净值未公布）：估算涨跌幅的基准是「最新已公布净值」，即东财 list[0]
      //    （此刻它还不是"今日净值"）。用 list[1] 会晚一个交易日：001717 盘中 10:34 估算 4.43%
      //    时，基数取了 9-17 的 3.2510，而估算基准是 9-18 的 3.2780
      //  - 净值差口径（今日净值已公布）：差值基准是 list[1]（上一交易日）
      // 口径切换的唯一判据是 estimateUpdated（今日净值是否已公布），不再用"净值是否相等"当代理
      const actualNavSafe = eastmoney.actualNav != null && eastmoney.actualNav > 0 ? eastmoney.actualNav : null;
      const baseNav = estimateUpdated ? yesterdayNav : (actualNavSafe || yesterdayNav);
      // 基准市值（= 基准净值 × 份额）即收益率分母，先算好供下面各分支折算金额用。
      // 盘中市值本身就是基准净值算的、不含今日收益，所以分母≠市值−今日收益（那会把今日收益减两次，
      // 收益率被放大 1/(1−r/100)）
      const baseValue = baseNav != null && baseNav > 0 && shares > 0 ? baseNav * shares : 0;
      if (estimateUpdated && currentNav != null && yesterdayNav != null) {
        // 今日净值已公布 → 精确模式：净值差就是今日收益
        todayProfitAmount = currentNav !== yesterdayNav
          ? (currentNav - yesterdayNav) * shares
          // 只有一条已公布净值（968 互认基金走 MNF 兜底，没有前日净值可做差）：用官方涨幅 × 基准市值，
          // 与行内涨幅、详情页金额同口径（旧行为是金额 0 而涨幅非 0，同一行自相矛盾）
          : (eastmoney.actualChangeRate != null ? baseValue * eastmoney.actualChangeRate / 100 : 0);
        todayChangeRate = eastmoney.actualChangeRate || 0;
      } else if (!estimateUpdated && estRate != null && baseValue > 0) {
        // 今日净值未公布但拿得到今日估算（新浪估值或自主加权）；baseValue=0（完全取不到净值、
        // 份额为 0）时不给涨幅——否则出现"涨幅有值 / 金额 0 / 收益率 0.00%"的自相矛盾行
        todayProfitAmount = baseValue * estRate / 100;
        todayChangeRate = estRate;
      } else {
        // 今日既没有净值也拿不到估算（债券/968/货币等无覆盖标的）→ 未出估值：
        // 不能拿上一交易日涨幅冒充"今日"（列表显示 --、当日收益按 0 计，卡片与快照同口径）
        todayProfitAmount = 0;
        todayChangeRate = null;
      }

      if (estRate != null) { updateTime = estSource === "sina" ? (sn.time || "") : (tiantian.estimateTime || ""); }

      const costValue = buyPrice * shares;
      const marketValue = currentNav != null ? currentNav * shares : dbMarketValue;
      const totalReturn = marketValue - costValue;
      const totalReturnRate = costValue > 0 ? ((totalReturn / costValue) * 100) : 0;
      // 单只基金当日收益率：今日收益 / 基准市值（客户端当日收益列按此排序）
      const todayProfitRate = baseValue > 0 ? ((todayProfitAmount / baseValue) * 100) : 0;

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
        baseValue: baseValue.toFixed(2),   // 基准市值（基准净值 × 份额）：收益率分母，客户端聚合按它算
        todayChangeRate: todayChangeRate != null ? todayChangeRate.toFixed(2) : null,  // null = 今日未出估值（列表显示 --）
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

    // 组合合计口径 = 逐笔「已舍入到分」的值相加（与平台/分组汇总、客户端 _sumHoldings、收盘播报一致）。
    // 此前用未舍入的 shares×nav / buyPrice×shares 累加、最后统一舍入：与逐笔相加会差 1 分
    // （12 笔逐笔舍入残差累计 ≈ -0.006 元，刚好跨过进位边界），
    // 表现为「全部」资产卡与「账户」资产卡、账户汇总行对不上（单账户也一样）。
    const totalAmount = enriched.reduce((s, h) => s + (parseFloat(h.marketValue) || 0), 0);
    const totalReturn = enriched.reduce((s, h) => s + (parseFloat(h.totalReturn) || 0), 0);
    const totalTodayProfit = enriched.reduce((s, h) => s + (parseFloat(h.todayProfit) || 0), 0);
    // 收益率分母 = 逐笔基准市值之和（与客户端 _sumHoldings、分组/账户汇总、收盘播报的 base 同式）。
    // 不能用「市值 − 今日收益」反推：盘中市值就是基准净值算的，反推会把今日收益多减一次
    const totalBaseValue = enriched.reduce((s, h) => s + (parseFloat(h.baseValue) || 0), 0);
    const totalCost = totalAmount - totalReturn;
    const todayProfitRate = totalBaseValue > 0 ? ((totalTodayProfit / totalBaseValue) * 100) : 0;
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
      const _ = db.command;
      const tempCodes = [...new Set(enriched.map(h => h.fundCode))];
      const TEMP_FIELDS = { fundCode: true, date: true, signal: true, label: true, normPE: true, weightedPE: true, coverage: true, stocksWith52w: true, totalStocks: true, detailPEs: true };
      // 先按当日批量查（where-in 1-2 次覆盖全部持仓；原 while-skip 串行分页扫全部历史，
      // 持仓多时要 3-20 轮查询）。缺哪只再逐只取 date 最新一条兜底（每基金取最新——
      // 此前逐基金并发单查会间歇失败，失败的基金走 position 兜底编出温度，导致列表与详情页温度对不上）
      const tempRows = [];
      const missingTemps = [];
      {
        const BATCH = 100;
        for (let i = 0; i < tempCodes.length; i += BATCH) {
          const res = await db.collection("fund_temperatures")
            .where({ fundCode: _.in(tempCodes.slice(i, i + BATCH)), date: today })
            .field(TEMP_FIELDS)
            .get();
          tempRows.push(...(res.data || []));
        }
        tempRows.forEach(t => { if (t && !tempMap[t.fundCode]) tempMap[t.fundCode] = t; });
        for (const c of tempCodes) { if (!tempMap[c]) missingTemps.push(c); }
        // 缺失的逐只补最新一条（凌晨任务偶发失败/未跑到该基金），单只失败不拖垮整体
        for (const c of missingTemps) {
          try {
            const res = await db.collection("fund_temperatures")
              .where({ fundCode: c })
              .orderBy("date", "desc").limit(1)
              .field(TEMP_FIELDS)
              .get();
            const t = (res.data || [])[0];
            if (t) tempMap[t.fundCode] = t;
          } catch (e) { /* 单只失败跳过 */ }
        }
      }
      tempDebug.found = Object.keys(tempMap).length;
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
      // 只认交易日的"今日"快照：休市日库里可能残留历史假点（2026-09-25 中秋那批），
      // 直接返回会与 displayDay 的上一交易日口径同屏矛盾 → 交下方回退分支取最近交易日曲线
      if (td.isTradingDay(today) && snapRes.data && snapRes.data.length > 0) {
        intradaySnapshots = snapRes.data[0].points || [];
        snapDebug.points = intradaySnapshots.length;
      } else {
        // 非交易时段（周末/节假日）当天无快照 → 回退最近一个有快照的交易日（每天 1 条，limit 60 覆盖 30 天）；
        // 交易时段缺失不回退，交由下方"快照兜底"写当天新点，避免混合两日曲线
        const bj = new Date(Date.now() + 8 * 3600000);
        const bjMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
        // 节假日也算非交易时段（否则休市日会走"不回退"分支，今日曲线空白却显示 -- 的当日收益）
        const inTradingNow = bj.getUTCDay() >= 1 && bj.getUTCDay() <= 5 && fd.inTradingWindow(bjMin) && td.isTradingDay(today);
        if (!inTradingNow) {
          const start = fd.formatBJDate(new Date(Date.now() - 30 * 86400000));
          const fbRes = await db.collection("profit_snapshots")
            .where({ _openid: uid, date: _.gte(start) })
            .field({ date: true, points: true })
            .limit(60)
            .get();
          const rows = (fbRes.data || []).sort((a, b) => b.date.localeCompare(a.date));
          // 取最近一个"早于今天"的有快照日期：今天自己那份在休市日不可信（可能是历史假点），
          // 用 rows[0] 会因为它就是今天而整段不回退，曲线反而空白
          const lastRow = rows.find((r) => r.date < today);
          if (lastRow && lastRow.points && lastRow.points.length > 0) {
            intradaySnapshots = lastRow.points;
            snapDate = lastRow.date;
            snapDebug.fallback = lastRow.date;
            snapDebug.fallbackPoints = intradaySnapshots.length;
          }
        }
      }
    } catch (e) { snapDebug = { error: e.message }; }
    // 生产返回剥离 snapDebug（含 openid，改由日志观测）；event.debug===true 时才随返回携带
    console.log("[getPortfolio] 快照 debug:", JSON.stringify(snapDebug));

    // 资产配置：按行业聚合持仓穿透（correlation-matrix 等仅需列表的调用可传 withAnalysis:false 跳过）
    let assetAllocation = null;
    let healthScore = null;
    if (withAnalysis !== false) {
    try {
      // 行业聚合走 _shared 共享实现（与行情页 fetchMarketOverview 完全同口径）：
      // 权重取持仓档案市值（缺失回退 份额×档案净值），不依赖实时估值，避免穿透随估值可用性塌缩
      const agg = ft.aggregateUserIndustries(enriched, tempMap);
      if (agg.list.length > 0) {
        console.log(`[getPortfolio] 资产配置: 覆盖率=${agg.coverage}% industries=${agg.list.length}`);
        const list = agg.list;
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
          // 穿透覆盖率：基于全部持仓市值（行业明细只来自前十大重仓股 + 温度任务已覆盖的基金）
          coverage: agg.coverage,
          warning: maxPercent > 30 ? `单一行业「${maxName}」占比 ${maxPercent}%，建议分散配置` : null,
        };
      } else {
        console.log("[getPortfolio] 资产配置: 无有效数据");
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
        groupMap[g] = { name: g, count: 0, totalAmount: 0, todayProfit: 0, totalReturn: 0, baseValue: 0 };
      }
      groupMap[g].count++;
      groupMap[g].totalAmount += parseFloat(h.marketValue) || 0;
      groupMap[g].todayProfit += parseFloat(h.todayProfit) || 0;
      groupMap[g].totalReturn += parseFloat(h.totalReturn) || 0;
      groupMap[g].baseValue += parseFloat(h.baseValue) || 0;
    });
    // 收益率同口径：分母 = 逐笔基准市值之和，成本 = 市值 − 累计收益
    //（与总额、客户端 _sumHoldings、收盘播报一套式子；此前用 净值/(1+涨幅) 反推昨收、用 buyPrice×shares 当成本，
    //  与点进该分组后卡片上的收益率会差 0.01pp）
    const groups = Object.values(groupMap).map(g => {
      const cost = g.totalAmount - g.totalReturn;
      const tpr = g.baseValue > 0 ? ((g.todayProfit / g.baseValue) * 100) : 0;
      const trr = cost > 0 ? ((g.totalReturn / cost) * 100) : 0;
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

    // 平台维度汇总：平台是与基金分组并行的一级维度（顶部平台栏 / 账户汇总 / 资产卡按平台合计都用它）
    const platformMap = {};
    enriched.forEach(h => {
      const pk = h.platform || "未分配";
      if (!platformMap[pk]) {
        platformMap[pk] = { name: pk, count: 0, totalAmount: 0, todayProfit: 0, totalReturn: 0, baseValue: 0 };
      }
      const m = platformMap[pk];
      m.count++;
      m.totalAmount += parseFloat(h.marketValue) || 0;
      m.todayProfit += parseFloat(h.todayProfit) || 0;
      m.totalReturn += parseFloat(h.totalReturn) || 0;
      m.baseValue += parseFloat(h.baseValue) || 0;
    });
    const platforms = Object.values(platformMap).map(m => {
      const cost = m.totalAmount - m.totalReturn;
      return {
        name: m.name,
        count: m.count,
        totalAmount: m.totalAmount.toFixed(2),
        todayProfit: m.todayProfit.toFixed(2),
        todayProfitRate: m.baseValue > 0 ? ((m.todayProfit / m.baseValue) * 100).toFixed(2) : null,
        totalReturn: m.totalReturn.toFixed(2),
        totalReturnRate: cost > 0 ? ((m.totalReturn / cost) * 100).toFixed(2) : null,
      };
    });

    // ---- 快照兜底：定时任务（snapshotProfit）未写快照时，用户打开小程序也能留点 ----
    // 仅在交易日交易时段补（与定时任务语义一致，含节假日判断：休市日写会造"股市没开却有当日曲线"
    // 的假点，2026-09-25 中秋 + 2026-06-13 周六都这么留下过），距上一点 >= 1 分钟才写
    try {
      const _bj = new Date(Date.now() + 8 * 3600000);
      const _day = _bj.getUTCDay();
      const _min = _bj.getUTCHours() * 60 + _bj.getUTCMinutes();
      const _inTrading = _day >= 1 && _day <= 5 && fd.inTradingWindow(_min) && td.isTradingDay(today);
      if (_inTrading) {
        const _last = intradaySnapshots[intradaySnapshots.length - 1];
        // 时间解析防御：time 缺失/格式异常时 parseInt 得 NaN（.slice 对 null 会直接抛错）——NaN 时跳过本轮兜底写点
        const _lastMin = _last && typeof _last.time === "string"
          ? parseInt(_last.time.slice(0, 2)) * 60 + parseInt(_last.time.slice(3, 5))
          : -Infinity;
        if (!Number.isNaN(_lastMin) && _min - _lastMin >= 1) {
          const _time = `${String(_bj.getUTCHours()).padStart(2, "0")}:${String(_bj.getUTCMinutes()).padStart(2, "0")}`;
          const _rate = +todayProfitRate.toFixed(2);
          // 金额同点存一份（= 基准市值 × 收益率，与 rate 同口径）：客户端只有 2 位收益率，
          // 自己乘基准市值会差几十元（与首页金额对不上）
          const _point = { time: _time, rate: _rate, tp: +totalTodayProfit.toFixed(2) };
          // 文档级基准市值（周播报折算金额用，见 snapshotProfit.writePoints）
          const _docBase = { base: +totalBaseValue.toFixed(2) };
          const _doc = await db.collection("profit_snapshots").where({ _openid: uid, date: today }).get();
          if (_doc.data && _doc.data.length > 0) {
            // 与 snapshotProfit 定时器竞态：读到的文档可能已含同分钟点（read-then-push 双写），先检查再 push
            const _exists = (_doc.data[0].points || []).some(p => p.time === _time);
            if (_exists) {
              if (!intradaySnapshots.some(p => p.time === _time)) intradaySnapshots.push(_point);
            } else {
              await db.collection("profit_snapshots").doc(_doc.data[0]._id).update({
                data: { ..._docBase, points: _.push(_point) },
              });
              // update 分支同样同步本地数组，本次响应带上最新点
              if (!intradaySnapshots.some(p => p.time === _time)) intradaySnapshots.push(_point);
            }
          } else {
            await db.collection("profit_snapshots").add({
              data: { _openid: uid, date: today, ..._docBase, points: [_point] },
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
        platforms,
        totalAmount: totalAmount.toFixed(2),
        // 基准市值（逐笔基准净值 × 份额之和）：今日收益金额 = 基准市值 × 收益率，两个页面按它换算
        baseValue: totalBaseValue.toFixed(2),
        todayProfit: totalTodayProfit.toFixed(2),
        todayProfitRate: todayProfitRate.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
        updateTime,
        navHistoryMap: historyDays ? navHistoryMap : undefined,
        intradaySnapshots,
        snapDate,
        snapDebug: debug === true ? snapDebug : undefined,
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
          // 历史脏占比（合计 >100%）判为不可用：不加入 known，交由 1c 现拉修正
          if (fd.isValidHoldings(t.detailPEs)) {
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
          if (!known.has(d.fundCode) && fd.isValidHoldings(d.holdings)) {
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
    // 3-前置2：指数行情批量拉取（原循环内逐只 await 串行，N 只指数基金 = N 轮 RTT）——
    // 所有跟踪指数 code 去重并集，一次腾讯请求拉完，循环内从结果 map 取
    const indexCodes = [...new Set(Object.values(trackMap).filter(t => t && t.indexCode).map(t => t.indexCode))];
    const indexQuoteMap = indexCodes.length > 0 ? await fd.fetchIndexRealtimeBatch(indexCodes) : {};
    const timeStr = fd.formatBJTime();
    for (const code of codes) {
      // 3a) 指数优先：东财 INDEXCODE 覆盖所有指数基金（行业天然全覆盖），用指数实时涨跌幅估算
      let estChange = null;
      const track = trackMap[code];
      if (track && track.indexCode) {
        try {
          // 批量结果优先，批内未命中（网络丢包等）单拉兜底
          const idx = indexQuoteMap[track.indexCode] || await fd.fetchIndexRealtime(track.indexCode);
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


// GZTIME/数据日期是否属于今日：兼容 "YYYY-MM-DD HH:mm:ss"、"YYYY-MM-DD" 与 "MM-DD HH:mm:ss" 三种格式
function _gdIsToday(gztime, todayStr) {
  const gd = String(gztime || "").trim();
  return gd.slice(0, 10) === todayStr || gd.slice(0, 5) === todayStr.slice(5);
}

// 纯日期偏移（UTC 计算："YYYY-MM-DD" 无时区歧义）
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ========== 费用账单（收益页"费用后收益"卡）==========
// 口径：持有费用 = Σ(持仓市值 × 综合费率[管理+托管+销售])；加权费率 = 年费用 / 总市值。
// 费率来源：东财 FundDetailInformation（MGREXP/TRUSTEXP/SALESEXP），fund_fees 集合缓存 30 天（费率静态）
async function handleFeeSummary(openid) {
  try {
    const holdings = [];
    {
      const PAGE = 100;
      let lastId = "";
      while (true) {
        const res = await db.collection("holdings")
          .where(lastId ? { _openid: openid, _id: _.gt(lastId) } : { _openid: openid })
          .orderBy("_id", "asc")
          .field({ fundCode: true, fundName: true, shares: true, amount: true, nav: true, buyPrice: true, marketValue: true })
          .limit(PAGE).get();
        const rows = res.data || [];
        holdings.push(...rows);
        if (rows.length < PAGE) break;
        lastId = rows[rows.length - 1]._id;
      }
    }
    const held = holdings.filter((h) => (parseFloat(h.shares) || parseFloat(h.amount) || 0) > 0);
    if (!held.length) return { code: 0, data: { hasData: false } };
    const codes = [...new Set(held.map((h) => h.fundCode).filter(Boolean))];
    if (!codes.length) return { code: 0, data: { hasData: false } };

    // 集合可能不存在（首次使用）：先建通道，否则读抛错→全量现拉且缓存永不生效
    try { await db.createCollection("fund_fees"); } catch (e) { /* 已存在 */ }
    // 费率缓存 30 天，缺失现拉（并发 6，单基金失败费率记 0 不塌缩）
    const feeMap = {};
    const missing = [];
    try {
      const res = await db.collection("fund_fees").where({ fundCode: _.in(codes) }).get();
      const now = Date.now();
      (res.data || []).forEach((r) => {
        if (r.ts && now - r.ts < 30 * 86400000) feeMap[r.fundCode] = r;
        else missing.push(r.fundCode);
      });
    } catch (e) { missing.push(...codes); }
    codes.forEach((c) => { if (!feeMap[c] && missing.indexOf(c) < 0) missing.push(c); });
    const CONCURRENT = 6;
    for (let i = 0; i < missing.length; i += CONCURRENT) {
      const batch = missing.slice(i, i + CONCURRENT);
      await Promise.all(batch.map(async (code) => {
        const fees = await fetchFundFees(code);
        const doc = { fundCode: code, mgmt: fees.mgmt, trust: fees.trust, sales: fees.sales, ts: Date.now() };
        feeMap[code] = doc;
        try { await db.collection("fund_fees").doc(code).set({ data: doc }); } catch (e2) { /* 写缓存失败下次重拉 */ }
      }));
    }

    // 市值口径与主链路一致：最新净值 × 份额（无净值回退存储市值）
    let totalValue = 0, annualFee = 0;
    const items = [];
    for (const h of held) {
      let shares = parseFloat(h.shares) || 0;
      const buyPrice = parseFloat(h.buyPrice) || parseFloat(h.nav) || 0;
      if (!shares && h.amount && buyPrice > 0) shares = parseFloat(h.amount) / buyPrice;
      let mv = parseFloat(h.marketValue) || 0;
      try {
        let hit = navGetCache[h.fundCode];
        if (!hit || Date.now() - hit.ts > NAV_CACHE_TTL) {
          const r = await fd.fetchLatestNavEastMoney(h.fundCode);
          if (r && r.actualNav > 0) { hit = { ts: Date.now(), data: r }; navGetCache[h.fundCode] = hit; }
          else { hit = null; } // 失败不缓存，下次重试
        }
        const nav = hit && hit.data.actualNav > 0 ? hit.data.actualNav : null;
        if (nav != null && shares > 0) mv = nav * shares;
      } catch (e) { /* 回退存储市值 */ }
      if (!(mv > 0)) continue;
      const f = feeMap[h.fundCode] || {};
      const rate = (parseFloat(f.mgmt) || 0) + (parseFloat(f.trust) || 0) + (parseFloat(f.sales) || 0);
      const fee = mv * rate / 100;
      totalValue += mv;
      annualFee += fee;
      if (rate > 0) items.push({ fundName: h.fundName || h.fundCode, rate: +rate.toFixed(2), fee: +fee.toFixed(0), hasSales: (parseFloat(f.sales) || 0) > 0 });
    }
    if (!(totalValue > 0)) return { code: 0, data: { hasData: false } };
    items.sort((a, b) => b.fee - a.fee);
    return { code: 0, data: {
      hasData: annualFee > 0,
      totalRate: +(annualFee / totalValue * 100).toFixed(2), // 加权综合费率 %/年
      annualFee: +annualFee.toFixed(0),                      // 预计年费用（元）
      hasSales: items.some((i) => i.hasSales) || false,
      items: items.slice(0, 3),
      fundCount: held.length,
    } };
  } catch (e) {
    console.error("[getPortfolio] feeSummary 失败:", e.message || e);
    return { code: 0, data: { hasData: false } };
  }
}

// 费率查询（模块级缓存：同实例内同基金只打一次外呼；10 分钟 TTL，且只缓存成功结果——
// 失败时 fetchLatestNavEastMoney resolve({}) 是 truthy，永久缓存会让市值跨天用陈旧值）
const navGetCache = {}; // { [code]: { ts, data } }
const NAV_CACHE_TTL = 10 * 60 * 1000;
async function fetchFundFees(code) {
  return new Promise((resolve) => {
    const req = https.get(`https://fundmobapi.eastmoney.com/FundMApi/FundDetailInformation.ashx?FCODE=${code}&deviceid=wap&plat=Wap&product=EFund&version=2.0.0`, { headers: { Referer: "https://m.fund.eastmoney.com/" } }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const d = JSON.parse(body).Datas || {};
          resolve({ mgmt: parseFloat(d.MGREXP) || 0, trust: parseFloat(d.TRUSTEXP) || 0, sales: parseFloat(d.SALESEXP) || 0 });
        } catch (e) { resolve({ mgmt: 0, trust: 0, sales: 0 }); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ mgmt: 0, trust: 0, sales: 0 }); });
    req.on("error", () => resolve({ mgmt: 0, trust: 0, sales: 0 }));
  });
}
