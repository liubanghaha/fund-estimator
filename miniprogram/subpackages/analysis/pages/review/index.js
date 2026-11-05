// 复盘中心（2026-09-26 整合）：双 tab 页
//   回本中心 tab = 亏损持仓列表（首页缓存直出，秒开）+ 选中基金的明细（回本进度/历史修复分布/摊薄演算）
//   温度回测 tab = 全市场温度方法论对账（云函数 temperatureBacktest 预计算缓存，本页只读；onLoad 预取）
// 口径与详情页回本进度条同源（calc.selectNav）；全部为历史数据陈述/演算，
// 不做任何"建议加仓/减仓"类表述（合规红线 #2），措辞走温度偏低/适中/偏高（红线 #4）。
const api = require("../../../../utils/api");
const calc = require("../../../../utils/calculator");
const marketTime = require("../../../../utils/market-time");
const track = require("../../../../utils/track");

const _pad = (n) => (n < 10 ? "0" + n : "" + n);
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
const EP_EMPTY = { total: 0, fast: "--", med: "--", slow: "--", unrecovered: 0, maxDepth: "--", startDate: "--", endDate: "--", list: [] };

Page({
  data: {
    theme: "blue",
    activeTab: "recover", // recover=回本中心 | temp=温度回测 | goal=目标·排名
    amountVisible: true,
    // —— 目标 · 排名 ——
    goalLoaded: false, goal: null, goalInput: "", goalSaving: false, goalNowText: "",
    rankLoaded: false, rank: null,
    // —— 回本中心 ——
    fundCode: "",
    fundName: "",
    fundList: [],         // 全部亏损持仓（首页缓存直出：进度/缺口预计算，秒出）
    holding: null,        // { shares, cost } 选中基金的多笔加权合并；null = 未持有
    gapText: "--",
    ep: EP_EMPTY,
    epLoading: false,     // 修复分布的长序列还在拉（进度卡已出的两阶段状态）
    diluteAmount: "",
    dilute: null,
    currentNav: 0,
    loading: true,        // 选中基金明细的阶段一（估值+持仓）
    loadError: "",
    // —— 温度回测 ——
    tLoading: true,
    tNotReady: false,
    tError: "",
    tStats: null,
    // —— 月度复盘（懒加载：首次切到本 tab 才拉，getPortfolio 序列较重不进预取） ——
    mLoading: false,
    m: null,
  },

  onLoad(options) {
    options = options || {};
    const tab = options.tab === "temp" ? "temp"
      : options.tab === "monthly" ? "monthly"
      : options.tab === "goal" ? "goal"
      : "recover";
    this.setData({ theme: wx.getStorageSync("theme") || "blue", activeTab: tab });
    // 亏损持仓列表从首页缓存构建（同步、零网络），两个 tab 都会用到
    this._initRecovery(options, tab !== "recover"); // 非 recover tab 打开时只建列表、明细延后
    // 温度回测预取：与回本中心的加载并行，切 tab 时大概率已就绪
    this.fetchBacktest();
    // 月度复盘较重（getPortfolio 序列），不预取；但深链直开本 tab 时要拉
    if (tab === "monthly" && !this._monthlyLoaded) this.fetchMonthly();
    if (tab === "goal") this.loadGoalTab();
  },

  onShow() {
    // 跨天/加减仓后列表会陈旧：重建（纯同步零网络），当前选中保持（不在新列表则维持深链选中）
    if (this._recoveryInited) this.setData({ fundList: this._buildFundList(), multiClassHint: this._multiClassHint });
    // 选中基金的估算现值会过期：回前台超 60s 静默重拉明细
    if (this.data.activeTab === "recover" && this._loadedAt
        && Date.now() - this._loadedAt > 60000 && /^\d{6}$/.test(this.data.fundCode)) {
      this.fetchAll();
    }
  },

  onPullDownRefresh() {
    if (this.data.activeTab === "recover" && /^\d{6}$/.test(this.data.fundCode)) {
      this.fetchAll().finally(() => wx.stopPullDownRefresh());
    } else if (this.data.activeTab === "monthly") {
      this.fetchMonthly(() => wx.stopPullDownRefresh());
    } else {
      this.fetchBacktest(() => wx.stopPullDownRefresh());
    }
  },

  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    if (tab === "temp") {
      if (!this._btLoaded) this.fetchBacktest();
    } else if (tab === "monthly") {
      if (!this._monthlyLoaded) this.fetchMonthly();
    } else if (tab === "goal") {
      this.loadGoalTab();
    } else if (!this._recoveryLoaded) {
      this.fetchAll(); // 首次切回回本中心：补拉选中基金的明细
    }
  },

  // ==================== 回本中心 ====================

  // 亏损持仓列表：首页 portfolio_cache 按基金合并（与首页"全部"tab 的合计口径一致：
  // 金额逐笔相加、成本 = 市值 − 累计收益），只留亏损的、按亏损深度排序，进度/缺口预计算。
  // 深链 fundCode（详情页进入）必须进列表/选中——否则切换后只剩一只基金的数据（2026-09-26 用户实测）
  _safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s || ""; }
  },

  // 亏损持仓列表：首页 portfolio_cache 按基金合并（与首页"全部"tab 合计口径一致：
  // 金额逐笔相加、成本 = 市值 − 累计收益），只留亏损的、按亏损深度排序，进度/缺口预计算。
  // 纯同步零网络，onShow 时可反复重建（跨天/加减仓后防列表陈旧）
  _buildFundList() {
    const pc = wx.getStorageSync("portfolio_cache") || {};
    const byFund = {};
    (pc.holdings || []).forEach((h) => {
      if (!h || !h.fundCode) return;
      const num = (v) => parseFloat(v) || 0;
      const b = byFund[h.fundCode] || (byFund[h.fundCode] = {
        fundCode: h.fundCode, fundName: h.fundName || h.fundCode,
        marketValue: 0, totalReturn: 0, shares: 0, currentNav: 0,
      });
      b.marketValue += num(h.marketValue);
      b.totalReturn += num(h.totalReturn);
      b.shares += num(h.shares);
      if (!b.currentNav && num(h.currentNav) > 0) b.currentNav = num(h.currentNav);
    });
    const fundList = [];
    Object.values(byFund).forEach((b) => {
      const cost = b.marketValue - b.totalReturn;
      if (!(cost > 0) || !(b.currentNav > 0) || !(b.shares > 0)) return;
      const mvNow = b.currentNav * b.shares;
      const rate = (b.totalReturn / cost) * 100;
      if (rate >= 0) return; // 只列亏损的
      fundList.push({
        fundCode: b.fundCode,
        fundName: b.fundName,
        rate: +rate.toFixed(1),
        pct: Math.max(0, Math.min(100, Math.round((mvNow / cost) * 100))),
        gap: Math.max(0, (cost / mvNow - 1) * 100).toFixed(1),
        // 每份成本/现值：列表每行都展示，不再只给选中行（2026-10-21 用户反馈：
        // "为什么有些基金有这个有些没有"——成本在缓存里本来就有，不需要额外请求）
        costPerShare: (cost / b.shares).toFixed(4),
        nowPerShare: b.currentNav.toFixed(4),
      });
    });
    this._multiClassHint = this._hasSameFundMultiClass(byFund, fundList);
    return fundList.sort((a, b) => a.rate - b.rate);
  },

  // 同名多份额提示：同一只基金的 A/C 等份额类别，成本与净值各自独立，但本页只列亏损的那一类。
  // 用户会误以为"这只基金明明盈利，为什么进了回本中心"（2026-10-21 用户反馈：东方红新动力 A 盈利、C 亏损）。
  // 触发条件收窄：同名分组里至少有一类落在当前亏损列表中才提示，避免对只买一类的用户产生噪音。
  _hasSameFundMultiClass(byFund, fundList) {
    const losing = new Set(fundList.map((f) => f.fundCode));
    const groups = {};
    Object.values(byFund).forEach((b) => {
      // 去掉结尾的份额字母（A/C/E/I/D…）作为同名判定键
      const base = String(b.fundName || "").replace(/[A-Za-z]$/, "").trim();
      if (!base) return;
      (groups[base] || (groups[base] = new Set())).add(b.fundCode);
    });
    return Object.keys(groups).some(
      (k) => groups[k].size > 1 && Array.from(groups[k]).some((c) => losing.has(c))
    );
  },

  _initRecovery(options, deferFetch) {
    this._recoveryInited = true;
    let fundCode = options.fundCode || "";
    let fundName = options.fundName ? this._safeDecode(options.fundName) : "";
    const fundList = this._buildFundList();

    // 默认选中：深链基金优先；否则亏损最深的第一只。深链基金不在亏损列表（已扭亏/未持有）也照选
    if (!fundCode && fundList.length > 0) {
      fundCode = fundList[0].fundCode;
      fundName = fundList[0].fundName;
    }
    const hit = fundList.find((f) => f.fundCode === fundCode);
    const gapText = hit ? hit.gap : "--";
    this.setData({ fundCode, fundName, fundList, gapText, multiClassHint: this._multiClassHint });
    if (/^\d{6}$/.test(fundCode) && !deferFetch) {
      this.fetchAll();
    } else {
      this.setData({ loading: false }); // 延后加载（温度 tab 打开）或无持仓
    }
  },

  // 列表内"详情"入口：直接进基金详情页核对这只基金的独立数据（估值/净值/份额类别）。
  // 用户曾把同只基金的 A/C 两个份额误当成一笔（2026-10-21 反馈），给一条能自己核对的路。
  onGoDetail(e) {
    const code = (e.currentTarget.dataset.code || "").trim();
    const name = e.currentTarget.dataset.name || "";
    if (!/^\d{6}$/.test(code)) return;
    wx.navigateTo({
      url: `/subpackages/analysis/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name)}`,
    });
  },

  onSwitchFund(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name || "";
    if (!code || code === this.data.fundCode) return;    const hit = this.data.fundList.find((f) => f.fundCode === code);
    this._recoveryLoaded = false;
    this.setData({
      fundCode: code, fundName: name || (hit && hit.fundName) || "",
      loading: true, loadError: "",
      holding: null, dilute: null, diluteAmount: "",
      gapText: hit ? hit.gap : "--",
      ep: EP_EMPTY, epError: false, epLoading: true,
    });
    this.fetchAll();
  },

  // 两阶段加载：阶段一（估值+持仓，轻）→ 进度卡先出；阶段二（800 天净值长序列，重）→ 修复分布后到。
  // 概览接口（含 260 天历史+档案）在这里大半浪费，换成轻量估值接口（二轮性能反馈）
  async fetchAll() {
    const code = this.data.fundCode;
    this.setData({ loading: true, loadError: "", epLoading: true, epError: false, ep: EP_EMPTY });
    const [estRes, holdingRes] = await Promise.all([
      api.fetchFundEstimate(code).catch(() => null),
      api.holdingCheck(code).catch(() => null),
    ]);
    // 快速切换基金时丢弃过期回包
    if (code !== this.data.fundCode) return;
    // 网络/服务端失败 ≠ 未持有：失败给可重试的错误态（holdingCheck code 0 + data null 才是真"未持有"）
    const estOk = !!(estRes && estRes.result && estRes.result.code === 0);
    const holdOk = !!(holdingRes && holdingRes.result && holdingRes.result.code === 0);
    if (!estOk || !holdOk) {
      this.setData({ loading: false, loadError: "加载失败，下拉重试", epLoading: false });
      return;
    }
    try {
      const d = estRes.result.data;
      const currentNav = d ? calc.selectNav(d.nav, d.actualNav, d.estimatedNav) : 0;
      const holding = this._aggregateHolding(holdingRes && holdingRes.result, currentNav);
      let gapText = this.data.gapText;
      if (holding && currentNav > 0) {
        const cost = holding.cost;
        gapText = cost > currentNav ? ((cost / currentNav - 1) * 100).toFixed(1) : "0";
      }
      this.setData({ currentNav, holding, gapText, loading: false });
      this._recoveryLoaded = true;
      this._loadedAt = Date.now();
    } catch (e) {
      this.setData({ loading: false, loadError: (e && e.message) || "加载失败", epLoading: false });
      return;
    }
    // 阶段二：历史修复分布（重）。800 天净值按"基金 × 当日"本地缓存——
    // 交易日盘中历史数据不变（当日净值夜间才公布），同日复用后切走再切回是即时的；跨日自动失效
    const cacheKey = `review_nav_${code}`;
    const bjDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    let navList = null;
    try {
      const c = wx.getStorageSync(cacheKey);
      if (c && c.day === bjDay && c.list && c.list.length > 60) navList = c.list;
    } catch (e) { /* ignore */ }
    if (!navList) {
      const navRes = await api.fetchFundNAVHistory(code, 800).catch(() => null);
      navList = (navRes && navRes.result && navRes.result.code === 0 && navRes.result.data) || [];
      if (navList.length > 60) {
        try { wx.setStorageSync(cacheKey, { day: bjDay, list: navList }); } catch (e) { /* ignore */ }
      }
    }
    if (code !== this.data.fundCode) return;
    const navFailed = navList.length === 0; // 拉取失败/空回包：不能伪装成"样本期内没出现过回撤"
    this._calcEpisodes(navList);
    this.setData({ epLoading: false, epError: navFailed });
  },

  // 多笔持仓合并：shares/buyPrice 新 schema，amount/nav 旧 schema 兼容（与 getPortfolio 同式）。
  // OCR 批量导入在净值查询失败时会落 {shares:0, buyPrice:0, marketValue>0} 的残缺记录——
  // 详情页/getPortfolio 都有读时反推兜底，这里同样反推（否则明细判"未持有"自相矛盾）
  _aggregateHolding(res, currentNav) {
    const list = (res && Array.isArray(res.list) && res.list.length ? res.list : res && res.data ? [res.data] : [])
      .filter(Boolean);
    let totalShares = 0, costSum = 0;
    list.forEach((r) => {
      const buyPrice = parseFloat(r.buyPrice) || parseFloat(r.nav) || 0;
      let shares = parseFloat(r.shares) || 0;
      if (!shares && r.amount && buyPrice > 0) shares = parseFloat(r.amount) / buyPrice;
      const mv = parseFloat(r.marketValue) || 0;
      if (!shares && mv > 0 && currentNav > 0) shares = mv / currentNav;
      if (shares <= 0) return;
      if (buyPrice > 0) {
        totalShares += shares;
        costSum += shares * buyPrice;
      } else {
        const cost = mv - (parseFloat(r.holdingReturn) || 0);
        if (cost > 0) { totalShares += shares; costSum += cost; }
      }
    });
    return totalShares > 0 ? { shares: totalShares, cost: costSum / totalShares } : null;
  },

  // 回撤区间扫描（时间升序）：峰值→谷底→收复前高。修复天数 = 谷底日 → 收复日
  _calcEpisodes(history) {
    // 复权：官方日增长率逐日复利重构净值序列，消除分红除息日的假回撤与假"1 天修复"
    //（与温度回测的 JZZZL 口径同理；缺涨跌幅的日子用相邻净值比衔接，不伪造 0）
    const raw = (history || []).filter((d) => d && d.nav > 0).slice().reverse(); // 时间升序
    const chrono = [];
    let prev = null;
    raw.forEach((d) => {
      let nav = d.nav;
      if (prev) {
        if (typeof d.changeRate === "number") nav = prev.adj * (1 + d.changeRate / 100);
        else if (prev.nav > 0) nav = prev.adj * (d.nav / prev.nav);
        else nav = prev.adj;
      }
      chrono.push({ date: d.date, nav });
      prev = { nav: d.nav, adj: nav };
    });
    if (chrono.length < 30) {
      this.setData({ ep: { ...EP_EMPTY } });
      return;
    }
    const episodes = [];
    let peakNav = 0, troughNav = Infinity, troughDate = null;
    chrono.forEach((d) => {
      if (d.nav >= peakNav) {
        if (troughDate && troughNav < peakNav) {
          episodes.push({
            depth: ((peakNav - troughNav) / peakNav) * 100,
            troughDate,
            days: daysBetween(troughDate, d.date),
            recovered: true,
          });
        }
        peakNav = d.nav;
        troughNav = Infinity;
        troughDate = null;
      } else if (d.nav < troughNav) {
        troughNav = d.nav;
        troughDate = d.date;
      }
    });
    if (troughDate && troughNav < peakNav) {
      episodes.push({ depth: ((peakNav - troughNav) / peakNav) * 100, troughDate, days: null, recovered: false });
    }

    const gap = parseFloat(this.data.gapText) || 0;
    // 未持有/已盈利时参照线用"样本内当前回撤"（净值距样本最高点）
    let refGap = gap;
    if (!this.data.holding) {
      const peak = Math.max(...chrono.map((d) => d.nav));
      const last = chrono[chrono.length - 1].nav;
      refGap = peak > 0 ? Math.max(0, ((peak - last) / peak) * 100) : 0;
    }
    const hits = episodes
      .filter((e) => e.depth >= refGap && refGap > 0)
      .sort((a, b) => b.depth - a.depth);
    const recoveredDays = hits.filter((e) => e.recovered).map((e) => e.days).sort((a, b) => a - b);
    const med = recoveredDays.length
      ? (recoveredDays.length % 2 ? recoveredDays[(recoveredDays.length - 1) / 2] : Math.round((recoveredDays[recoveredDays.length / 2 - 1] + recoveredDays[recoveredDays.length / 2]) / 2))
      : null;
    const maxDays = recoveredDays.length ? recoveredDays[recoveredDays.length - 1] : 0;
    const list = hits.slice(0, 10).map((e, i) => ({
      idx: i,
      depth: e.depth.toFixed(1),
      daysText: e.recovered ? `${e.days} 天修复` : "未修复",
      pct: e.recovered && maxDays > 0 ? Math.max(8, Math.round((e.days / maxDays) * 100)) : 100,
      fail: !e.recovered,
    }));

    this.setData({
      ep: {
        total: hits.length,
        fast: recoveredDays.length ? recoveredDays[0] : "--",
        med: med != null ? med : "--",
        slow: recoveredDays.length ? recoveredDays[recoveredDays.length - 1] : "--",
        unrecovered: hits.filter((e) => !e.recovered).length,
        maxDepth: episodes.length ? Math.max(...episodes.map((e) => e.depth)).toFixed(1) : "0",
        startDate: chrono[0].date,
        endDate: chrono[chrono.length - 1].date,
        list,
      },
    });
  },

  // ---- 摊薄演算 ----
  onAmountInput(e) {
    this.setData({ diluteAmount: e.detail.value });
    this._recalcDilute();
  },

  onQuick(e) {
    const pct = parseFloat(e.currentTarget.dataset.pct);
    const { holding, currentNav } = this.data;
    if (!holding || !(currentNav > 0)) return;
    const marketValue = holding.shares * currentNav;
    this.setData({ diluteAmount: String(Math.round((marketValue * pct) / 100)) });
    this._recalcDilute();
  },

  _recalcDilute() {
    const { holding, currentNav } = this.data;
    const x = parseFloat(this.data.diluteAmount);
    if (!holding || !(currentNav > 0) || !(x > 0)) {
      this.setData({ dilute: null });
      return;
    }
    const newShares = x / currentNav;
    const newCost = (holding.cost * holding.shares + x) / (holding.shares + newShares);
    const gapFrom = ((holding.cost / currentNav - 1) * 100).toFixed(1);
    const gapTo = ((newCost / currentNav - 1) * 100).toFixed(1);
    this.setData({
      dilute: {
        amountText: x % 1 === 0 ? String(Math.round(x)) : x.toFixed(2),
        costText: holding.cost.toFixed(4),
        newCostText: newCost.toFixed(4),
        gapFrom,
        gapTo,
      },
    });
  },

  // ==================== 月度复盘 ====================

  // 报告月 = 最近一个"最后交易日已过"的月份：10/31（周六）看 → 10 月，11/1 看 → 也是 10 月，
  // 当月最后交易日当天盘中看 → 还是上月（当天数据没走完，不出半截月报）
  _reportMonth() {
    const bj = new Date(Date.now() + 8 * 3600000);
    let y = bj.getUTCFullYear(), m = bj.getUTCMonth() + 1;
    const lastCal = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let lastTd = null;
    for (let d = lastCal; d >= 1 && !lastTd; d--) {
      const ds = y + "-" + _pad(m) + "-" + _pad(d);
      if (marketTime.isTradingDay(ds)) lastTd = ds;
    }
    if (lastTd && marketTime.bjDateStr() > lastTd) return { y, m };
    return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  },

  // 三路并行：getPortfolio 序列（月收益/回撤，口径同年度报告页）+ behaviorBill 月桶（操作/归因/赎回费）
  // + 沪深300 月序列。懒加载不预取（getPortfolio 较重）
  async fetchMonthly(done) {
    this.setData({ mLoading: true });
    const { y, m: mm } = this._reportMonth();
    const pfx = y + "-" + _pad(mm);
    // 沪深300 同期对比已移除（类目合规，2026-11-05 审查 P1-3）
    const [pfRes, bbRes] = await Promise.all([
      api.getPortfolio(60, { withAnalysis: false }).catch(() => null),
      api.behaviorBill().catch(() => null),
    ]);
    track.track("monthly_review_open", { month: pfx });
    const pfOk = !!(pfRes && pfRes.result && pfRes.result.code === 0);
    if (!pfOk) {
      this.setData({ mLoading: false, m: null });
      this._monthlyLoaded = true;
      if (done) done();
      return;
    }
    const hs = pfRes.result.data.holdings || [];
    const navMap = pfRes.result.data.navHistoryMap || {};

    // 月内每日净值变动 dc 与市值 dm（纯净值变动口径，加减仓资金流不计入收益金额；
    // 持仓按 createTime 起算，与年度报告页同式）
    const dc = {}, dm = {};
    hs.forEach((h) => {
      let shares = parseFloat(h.shares || h.amount || 0);
      if (!shares && h.marketValue) {
        const cn = h.currentNav || h.buyPrice;
        if (cn > 0) shares = parseFloat(h.marketValue) / cn;
      }
      if (!shares) return;
      const hist = [...(navMap[h.fundCode] || [])].reverse();
      if (hist.length < 2) return;
      const sd = h.createTime ? calc.formatDate(h.createTime) : null;
      for (let i = 1; i < hist.length; i++) {
        if (sd && hist[i].date < sd) continue;
        if (!hist[i].date.startsWith(pfx)) continue;
        const chg = (hist[i].nav - hist[i - 1].nav) * shares;
        dc[hist[i].date] = +((dc[hist[i].date] || 0) + chg).toFixed(2);
        dm[hist[i].date] = (dm[hist[i].date] || 0) + hist[i].nav * shares;
      }
    });
    const dates = Object.keys(dm).sort();
    if (!dates.length) {
      this.setData({ mLoading: false, m: { empty: true, monthText: mm + " 月" } });
      this._monthlyLoaded = true;
      if (done) done();
      return;
    }

    let profit = 0;
    dates.forEach((dt) => { profit += dc[dt] || 0; });
    profit = +profit.toFixed(2);
    const startMv = (dm[dates[0]] || 0) - (dc[dates[0]] || 0);
    const rate = startMv > 0 ? +((profit / startMv) * 100).toFixed(2) : null;
    let cum = 0, peak = 0, maxDD = 0;
    dates.forEach((dt) => {
      cum += dc[dt] || 0;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    });

    // 操作/归因/赎回费（behaviorBill 按月桶；无流水月份该月桶不存在）
    const mb = ((bbRes && bbRes.result && bbRes.result.code === 0 && bbRes.result.data && bbRes.result.data.months) || [])
      .find((x) => x.month === pfx) || null;

    const sign = (v, suf) => (v > 0 ? "+" : "") + v.toFixed(2) + (suf || "");
    let hsText = ""; // 沪深300 对比已移除（类目合规）；保留空串占位，下游拼接无需改
    const reasons = mb ? mb.reasons.slice(0, 5) : [];
    const maxReason = reasons.length ? reasons[0].count : 1;
    const m = {
      monthText: mm + " 月",
      rangeText: dates[0].slice(5) + " ~ " + dates[dates.length - 1].slice(5) + " 收盘",
      profitText: sign(profit),
      cls: profit > 0 ? "up" : profit < 0 ? "down" : "",
      rateText: rate != null ? sign(rate, "%") : "--",
      hsText,
      ddText: maxDD > 0.5 ? maxDD.toFixed(0) + " 元" : "",
      hasOps: !!(mb && mb.trades.total > 0),
      opText: mb ? `操作 ${mb.trades.total} 笔（加仓 ${mb.trades.buy} / 减仓 ${mb.trades.sell}）` : "",
      reasons: reasons.map((r) => ({ reason: r.reason, count: r.count, barW: Math.max(6, Math.round(r.count / maxReason * 100)) })),
      untagged: mb ? mb.untagged : 0,
      hasFee: !!(mb && mb.trades.sell > 0),
      feeSellCount: mb ? mb.trades.sell : 0,
      feeText: mb ? mb.redemption.total.toFixed(2) + " 元" : "",
      shortText: mb && mb.redemption.shortCount > 0
        ? `${mb.redemption.shortCount} 笔持有不足 7 天、费用 ${mb.redemption.shortFee.toFixed(2)} 元` : "",
      uncomputedText: mb && mb.redemption.uncomputed > 0
        ? `另有 ${mb.redemption.uncomputed} 笔卖出因买入记录缺失未演算` : "",
    };
    this.setData({ mLoading: false, m });
    this._monthlyLoaded = true;
    if (done) done();
  },

  onRetryMonthly() {
    this.fetchMonthly();
  },

  // ==================== 温度回测 ====================

  fetchBacktest(done) {
    this.setData({ tLoading: true, tNotReady: false, tError: "" });
    wx.cloud.callFunction({ name: "temperatureBacktest" })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.code === 0 && r.data && r.data.buckets) {
          this._btLoaded = true;
          this.setData({ tLoading: false, tStats: this._format(r.data) });
        } else if (r.code === 1) {
          // 缓存未生成/过期（定时任务会补）：区别于真错误，文案是"再等等"
          this.setData({ tLoading: false, tNotReady: true, tError: r.msg || "回测数据还未生成" });
        } else {
          this.setData({ tLoading: false, tError: r.msg || "加载失败" });
        }
      })
      .catch((e) => {
        this.setData({ tLoading: false, tError: (e && (e.errMsg || e.message)) || "加载失败" });
      })
      .then(() => { if (done) done(); });
  },

  onRetryBacktest() {
    this.fetchBacktest();
  },

  // 云端聚合（n/mean/median/posRate 已算好）→ 用户能看懂的呈现：
  // 首屏一句人话结论（偏低组 vs 偏高组的相对差），每个窗口配对比条形图；
  // 中位/复利/信号日等统计术语不进主视图。全部数据驱动——某窗口没有区分度就如实说
  _format(d) {
    const sigLabel = { low: "温度偏低", mid: "温度适中", high: "温度偏高" };
    const sigCls = { low: "g-low", mid: "g-mid", high: "g-high" };
    const hLabel = { 5: "其后 5 个交易日", 10: "其后 10 个交易日", 20: "其后 20 个交易日" };
    const fmt = (v) => (v == null ? "--" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
    const rows = (d.horizons || [5, 10, 20]).map((k) => {
      const groups = ["low", "mid", "high"].map((sig) => {
        const b = (d.buckets[sig] && d.buckets[sig][k]) || {};
        const mean = typeof b.mean === "number" ? b.mean : null;
        return {
          key: sig,
          label: sigLabel[sig],
          cls: sigCls[sig],
          dim: (b.n || 0) < 10, // 样本 <10 的分组灰显：小样本均值没有参考价值
          mean, meanText: fmt(mean),
          posRate: b.posRate != null ? Math.round(b.posRate) : "--",
          n: b.n || 0,
        };
      });
      // 对比条形图：长度 = |均值| 占本行最大值的比例
      const means = groups.map((g) => (g.mean == null ? 0 : Math.abs(g.mean)));
      const maxAbs = Math.max(...means, 0.0001);
      groups.forEach((g) => { g.barW = g.mean == null ? 0 : Math.max(6, Math.round((Math.abs(g.mean) / maxAbs) * 100)); });
      // 相对结论（人话）：偏低组均值 − 偏高组均值，正 = 偏低组跌得少（或涨得多）
      const lo = groups.find((g) => g.key === "low");
      const hi = groups.find((g) => g.key === "high");
      let spreadText = "";
      if (lo && hi && lo.mean != null && hi.mean != null) {
        const diff = +(lo.mean - hi.mean).toFixed(2);
        if (Math.abs(diff) < 0.3) spreadText = "这个窗口里，温度和之后的涨跌没有明显关系";
        else if (diff > 0) spreadText = `温度偏低的一组，之后平均比温度偏高的一组${hi.mean < 0 ? "少跌" : "多涨"} ${diff.toFixed(1)} 个百分点`;
        else spreadText = `温度偏低的一组，之后平均比温度偏高的一组${lo.mean < 0 ? "多跌" : "少涨"} ${Math.abs(diff).toFixed(1)} 个百分点`;
      }
      return { h: k, label: hLabel[k] || `其后 ${k} 个交易日`, groups, spreadText };
    });

    // 首屏结论取 10 日窗口（样本与窗口长度的折中），并判断市场环境（三组全负 = 整体下跌期）
    const mid10 = rows.find((r) => r.h === 10) || rows[0];
    const lo10 = mid10.groups.find((g) => g.key === "low");
    const allNeg = rows[0].groups.every((g) => g.mean != null && g.mean < 0);
    return {
      rows,
      headline: {
        spreadText: mid10.spreadText,
        window: mid10.h,
        context: allNeg ? "这期间市场整体在跌" : "",
      },
      dateFrom: d.dateFrom || "--",
      dateTo: d.dateTo || "--",
      fundCountText: d.fundCount != null ? `${d.fundCount} 只${d.fundTotal && d.fundTotal > d.fundCount ? `（共 ${d.fundTotal} 只）` : ""}` : "--",
      sampleCountText: d.sampleCount != null ? `${d.sampleCount} 条` : "--",
      computedText: this._fmtTime(d.computedAt),
    };
  },

  _fmtTime(ts) {
    if (!ts) return "--";
    const t = new Date(ts + 8 * 3600 * 1000);
    return `${t.getUTCFullYear()}-${_pad(t.getUTCMonth() + 1)}-${_pad(t.getUTCDate())} ${_pad(t.getUTCHours())}:${_pad(t.getUTCMinutes())}`;
  },

  // ==================== 目标 · 排名（2026-11-06 全球调研 Top2/Top3） ====================

  // 目标进度：市值口径与首页资产卡同源（getPortfolio totalAmount / portfolio_cache）；
  // 排名：每日匿名分布任务产出的百分位（样本 <20 不出）
  loadGoalTab() {
    this.setData({ amountVisible: (wx.getStorageSync("amountVisible") === "" ? true : !!wx.getStorageSync("amountVisible")) });
    this.loadRank();
    try {
      const pc = wx.getStorageSync("portfolio_cache") || {};
      const total = parseFloat(pc.totalAmount) || 0;
      if (total > 0) this._portfolioTotal = total;
    } catch (e) { /* ignore */ }
    Promise.all([
      api.manageGoal("get").catch(() => null),
      this._portfolioTotal ? Promise.resolve(null) : api.getPortfolio(0, { withAnalysis: false, withEstimates: false, withNav60: false }).catch(() => null),
    ]).then(([goalRes, pfRes]) => {
      if (pfRes) {
        const d = pfRes.result && pfRes.result.data;
        const t = parseFloat(d && d.totalAmount) || 0;
        if (t > 0) this._portfolioTotal = t;
      }
      const g = goalRes && goalRes.result && goalRes.result.code === 0 ? goalRes.result.data : null;
      this._applyGoal(g);
    }).finally(() => this.setData({ goalLoaded: true }));
  },

  _applyGoal(g) {
    if (!g || !(g.targetAmount > 0)) {
      this.setData({ goal: null, goalNowText: this._portfolioTotal ? this._portfolioTotal.toFixed(2) : "" });
      return;
    }
    const now = this._portfolioTotal || 0;
    const target = g.targetAmount;
    const pct = target > 0 ? (now / target) * 100 : 0;
    const done = now >= target;
    this.setData({
      goal: {
        targetText: target.toFixed(2),
        nowText: now.toFixed(2),
        pctW: Math.min(100, +pct.toFixed(1)),
        done,
        gapText: done ? "0.00" : (target - now).toFixed(2),
        needRiseText: done ? "0.00" : ((target / Math.max(now, 0.01) - 1) * 100).toFixed(2),
        overText: done ? (now - target).toFixed(2) : "",
      },
    });
  },

  onGoalInput(e) { this.setData({ goalInput: e.detail.value }); },

  onSaveGoal() {
    const amt = parseFloat(this.data.goalInput);
    if (!isFinite(amt) || amt <= 0) { wx.showToast({ title: "请输入有效金额", icon: "none" }); return; }
    this.setData({ goalSaving: true });
    api.manageGoal("set", amt).then((res) => {
      if (res.result && res.result.code === 0) {
        this._applyGoal(res.result.data);
        this.setData({ goalInput: "" });
        wx.showToast({ title: "目标已保存", icon: "none" });
      } else {
        wx.showToast({ title: "保存失败", icon: "none" });
      }
    }).finally(() => this.setData({ goalSaving: false }));
  },

  onEditGoal() { this.setData({ goal: null, goalInput: "" }); },

  onRemoveGoal() {
    api.manageGoal("remove").then(() => {
      this._applyGoal(null);
      wx.showToast({ title: "目标已删除", icon: "none" });
    });
  },

  async loadRank() {
    try {
      const res = await api.rankPercentile();
      const d = res && res.result && res.result.code === 0 && res.result.data;
      if (!d || !(d.samples >= 20) || !isFinite(+d.pct) || !isFinite(+d.rate)) {
        this.setData({ rankLoaded: true, rank: null });
        return;
      }
      this.setData({
        rankLoaded: true,
        rank: {
          rateText: (d.rate > 0 ? "+" : "") + (+d.rate).toFixed(2) + "%",
          pct: d.pct,
          pctText: "超过 " + d.pct + "% 的持有人",
          samples: d.samples,
          coveredFunds: d.coveredFunds || 0,
          totalFunds: d.totalFunds || 0,
        },
      });
    } catch (e) {
      this.setData({ rankLoaded: true, rank: null });
    }
  },
});
