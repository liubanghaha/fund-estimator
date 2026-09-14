
const api = require("../../../../utils/api");
const calc = require("../../../../utils/calculator");
const marketTime = require("../../../../utils/market-time");
const track = require("../../../../utils/track.js");

// v3：周/月/年收益改为「含当天」口径（旧算法写的周/月/年数字直接作废重算），并与首页当天收益对齐
const CACHE = "profit_detail_cache_v3";
const INTRADAY_CACHE_PREFIX = "intraday_v2_";
const IDX_HIST_CACHE = "idx_hist_cache";
const chartUtil = require("../../../../utils/chart");
const subscribe = require("../../../../utils/subscribe");

Page({
  data: {
    activeTab: "today",
    profitMode: "amount",
    todayChartLoading: false, // 切指数未命中预取时，图表区给加载反馈（否则几秒无反馈=像卡住）
    loading: true,
    loadError: false,
    empty: false,
    showBriefBanner: false,
    showJtbdSurvey: false, jtbdOptions: [],
    totalCost: 0,
    todayProfit: "0.00", todayProfitRate: "0.00",
    weekProfit: "0.00", monthProfit: "0.00", yearProfit: "0.00",
    // 周期内是否已有收盘数据（false → 摘要格显示 --，见 _periodFlags）
    weekHasData: false, monthHasData: false, yearHasData: false,
    weekProfitRate: "0.00", monthProfitRate: "0.00", yearProfitRate: "0.00",
    compareIndex: "000001", compareLabel: "上证指数",
    availableIndices: [
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "399006", name: "创业板指" },
      { code: "000300", name: "沪深300" },
    ],
    canvasHRpx: 0,
    asOfTime: "",
    amountVisible: true, // 金额隐藏跟随首页全局开关（隐私）
    reviewCard: null, // 当前 tab 的周期复盘（组合 vs 沪深300/强弱/操作）
    signVisible: false, showSignModal: false, signRendering: false, signPeriod: "week", signTitle: "周签",
    signTabLabel: { today: "今日", week: "本周", month: "本月", year: "本年" },
    signDays: { today: 3, week: 7, month: 25, year: 260 },
    earliestDate: "",
    calendarView: "day",
    selectedMonth: "", availableMonths: [], dayCalendar: [], weekCalendar: [],
    selectedYear: "", availableYears: [], monthCalendar: [], yearData: [],
  },

  async onBriefAuth() {
    const r = await subscribe.requestAuth("profit_calendar");
    if (r.ok) {
      this.setData({ showBriefBanner: false });
      wx.showToast({ title: "已订阅收盘播报", icon: "none", duration: 2000 });
    }
  },

  onBriefClose() {
    this.setData({ showBriefBanner: false });
    subscribe.dismissPrompt("profit_calendar"); // 手动关闭按拒绝处理，7 天内不再展示
  },

  // 召回退订横幅：一键关闭召回（双条照常），× 仅收起本次横幅
  onRecallOptOut() {
    subscribe.optOutRecall();
    this.setData({ showRecallOptOut: false });
    wx.showToast({ title: "已关闭，不再收到此类提醒", icon: "none" });
  },
  onRecallOptOutClose() {
    this.setData({ showRecallOptOut: false });
  },

  // JTBD 问卷：回答走统一埋点（trackReport 云函数），关闭也记 done 防打扰
  _jtbdDone() {
    this.setData({ showJtbdSurvey: false });
    try { wx.setStorageSync("jtbd_survey_done", Date.now()); } catch (e) { /* ignore */ }
  },
  onJtbdAnswer(e) {
    const answer = e.currentTarget.dataset.answer;
    track.track("jtbd_survey", { answer });
    this._jtbdDone();
  },
  onJtbdDismiss() {
    track.track("jtbd_survey", { answer: "dismissed" });
    this._jtbdDone();
  },

  onLoad(options) {
    // 金额隐藏跟随首页全局开关（隐私：金额 → ****，百分比保留）
    try { this.setData({ amountVisible: wx.getStorageSync("amountVisible") !== false }); } catch (e) { /* ignore */ }
    this.setData({ showBriefBanner: subscribe.canPrompt() && !subscribe.hasAuthed() });
    // 召回推送落地：查推送类型，召回类显示一键退订横幅（双条播报不受影响）
    if (options && options.src === "push" && options.lid) {
      subscribe.getPushKind(options.lid).then((kind) => {
        if (kind && kind.indexOf("recall_") === 0) this.setData({ showRecallOptOut: true });
      }).catch(() => {});
    }
    // JTBD 主 Job 验证（产品规划指标表）：仅在推送落地时机问一次，答/关都记 done 不再打扰
    if (options && options.src === "push") {
      try {
        if (!wx.getStorageSync("jtbd_survey_done")) {
          this.setData({ showJtbdSurvey: true, jtbdOptions: ["看盘中估值", "缓解看盘焦虑", "记录和管理持仓"] });
        }
      } catch (e) { /* ignore */ }
    }
    const { windowWidth } = wx.getWindowInfo();
    this._canvasW = windowWidth - 24;
    this._canvasH = Math.round(this._canvasW * 0.59);
    this._canvasHRpx = Math.round(this._canvasH * 750 / windowWidth);
    this.setData({ canvasW: this._canvasW, canvasH: this._canvasH, canvasHRpx: this._canvasHRpx });
        this._fromCache();
        this._adoptHomePortfolio(); // 首页刚刷过就以首页那份为准，避免两页当天收益不一致
    // 有缓存且过期 → 自动调起下拉刷新动画，让用户感知数据更新（onReady 后再调起）
    // 无缓存时 _fromCache 已直接拉取，无需动画
    // 交易日时钟：盘中 30s；盘后净值发布(最新日=最近交易日)即冻结；周末/节假日免拉
    const c = wx.getStorageSync(CACHE);
    const hasCache = c && c.d && c.d.length && c.idx && c.idx.length;
    if (hasCache && !marketTime.isCacheFresh(c, { estimateTtl: 30000 })) {
      this._pendingAutoRefresh = true;
    }
  },

  // 首次渲染完成后自动调起下拉刷新动画（过早调用 startPullDownRefresh 无效）
  onReady() {
    if (this._pendingAutoRefresh) {
      this._pendingAutoRefresh = false;
      // 静默刷新（与首页标准一致）：缓存已渲染，不拉起下拉动画——实时性由 30s 轮询兜底
      setTimeout(() => this._fetch(), 500);
    }
  },

  onShow() {
    // 每次显示同步主题色（返回/切换时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    // 金额隐藏开关也同步（首页切换后返回本页立即生效）
    try { this.setData({ amountVisible: wx.getStorageSync("amountVisible") !== false }); } catch (e) { /* ignore */ }
    // 周期签入口：周/月/年 tab 显示对应签（当天 tab 无签），签数据为"至今"口径
    this.setData({ signVisible: this.data.activeTab !== "today" });
    this._adoptHomePortfolio(); // 从首页切回来：若首页那份更新过，先把当天收益对齐再决定是否重拉
    if (this._first) { this._first = false; }
    else {
      // 交易日时钟判新鲜度：冻结态（盘后已发布净值/周末/节假日）不重复拉全量
      // 过期改静默刷新（转圈动画仅保留用户手动下拉）——30s 轮询兜实时性，转圈属多余等待感
      if (!marketTime.isCacheFresh(wx.getStorageSync(CACHE), { estimateTtl: 30000 })) {
        this._fetch();
      }
    }
    // 交易时段启动收益轮询
    if (this._isTradingNow()) this._startPolling();
  },

  onHide() {
    this._stopPolling();
  },

  onUnload() {
    this._destroyed = true;
    this._stopPolling();
  },

  onPullDownRefresh() {
    this._fetch().finally(() => wx.stopPullDownRefresh());
  },

  // ============ 缓存 + 拉取 ============

  _fromCache() {
    try {
      const c = wx.getStorageSync(CACHE);
      if (c && c.d && c.d.length && c.idx && c.idx.length) {
        this._allDaily = c.d;
        this._dailyChange = c.dc;
        // 当日条目只可能在真实交易日注入成功后才存在，属合法数据，留待 _fetch() 刷新验证
        this._indexDaily = c.idx;
        this._idxMap = c.im || {};
        this._totalCost = c.tc;
        this._cachedProfit = c.s ? { tp: c.s.tp, tpr: c.s.tpr } : null;
        this._tpDay = calc.formatDate(new Date(c.ts || 0)); // 缓存里的当天收益属于写入那天
        this._cacheApplied = true;
        this.setData({
          loading: false,
          totalCost: c.tc,
          todayProfit: c.s.tp, todayProfitRate: c.s.tpr,
          ...this._periodSummary(c.s.tpr, c.s.tp),
          earliestDate: c.ed || c.d[0] ? (c.ed || c.d[0].date) : "",
          availableMonths: c.cal.months || [], selectedMonth: c.cal.sm || "",
          availableYears: c.cal.years || [], selectedYear: c.cal.sy || "",
          dayCalendar: c.cal.days || [], monthCalendar: c.cal.mons || [], yearData: c.cal.yrs || [],
        });
        setTimeout(() => this._draw(), 150);
        // 缓存过期与否由 onLoad 的 TTL 判断统一决定（过期 → 自动下拉动画刷新），
        // 避免与下拉动画双重刷新
      }
    } catch (e) { /* ignore */ }
    this._first = true;
    if (!this._cacheApplied) this._quickFirstPaint(); // 无缓存首屏：轻量接口先画当天图
    // 缓存新鲜（盘中 30s TTL / 盘后净值发布即冻结 / 周末节假日全天）→ 免拉全量
    // （getPortfolio 全年聚合重）；当天分时不在免拉之列——分时缺失当天图会空白，仍按需轻拉
    if (this._cacheApplied &&
        marketTime.isCacheFresh(wx.getStorageSync(CACHE), { estimateTtl: 30000 })) {
      if (this.data.activeTab === 'today' && this._shouldRefetchIntraday()) this.fetchIntraday();
      // 免拉全量但轻量补一笔 portfolioLight：补 _totalMarket 供 30s 轮询换算今日收益。
      // 冻结期（周末/盘后）portfolioLight 返回空占位，quickFirstPaint 会直接 return 不动
      // 已渲染的正确值（_totalMarket 保持未定义 → 轮询被守卫挡住，冻结期本就不该变数）
      this._quickFirstPaint();
      this._ensureReview(this.data.activeTab); // 周期复盘（冻结期用首页缓存兜底数据链）
      return;
    }
    this._fetch();
  },

  // 无缓存首屏快速通道：portfolioLight（轻量，含分钟快照+当日收益+市值）先行渲染当天图，
  // 全年历史（日历/周月年）由 _fetch 后台补齐。此前当天图要等 getPortfolio 全年聚合完成
  // 后才拉指数分时，两跳串行网络导致首屏动辄数秒
  _quickFirstPaint() {
    api.portfolioLight().then((r) => {
      const d = r.result && r.result.data;
      if (!d) return;
      // 非交易时段 portfolioLight 返回空占位（todayProfitRate:null，无真实数据语义），
      // 直接应用会把冻结期缓存里正确的收益值（如周五收盘 -1.31%）洗成 0，
      // 并连锁污染图例与曲线末端对齐点（末端被对齐到 0 后画在 Y 轴顶端外，视觉上成"翘尾"）
      if (d.inTrading === false) return;
      if (d.intradaySnapshots && d.intradaySnapshots.length) {
        this._profitSnapshots = d.intradaySnapshots.slice().sort((a, b) => a.time.localeCompare(b.time));
      }
      this._totalMarket = parseFloat(d.totalAmount) || 0;
      const rate = parseFloat(d.todayProfitRate || 0);
      const ym = this._totalMarket > 0 ? this._totalMarket / (1 + rate / 100) : 0;
      this.setData({ loading: false, todayProfitRate: rate, todayProfit: (ym * rate / 100).toFixed(2) });
      this._updateAsOf();
      this._draw();
    }).catch(() => {});
  },

  // 今日复盘（盘后复盘卡）：组合 vs 沪深300、持仓当日强弱、今日操作笔数。
  // 自给自足数据链——组合利率取当前已渲染值；沪深300 走 _idx（带缓存）；强弱优先本轮 hs，
  // 周末/盘后冻结跳过 _fetch 时回退首页缓存。播报落地（21:30）的第二次消费内容
  // 周期复盘（随 tab）：组合同期收益 vs 沪深300 同期、当日强弱（仅今日）、期间操作笔数。
  // 数据链自给自足：沪深300 走 _idx 独立缓存；强弱优先本轮 hs，冻结期回退首页缓存。
  // 异步回调带 activeTab 守卫，快速切 tab 时迟到响应不覆盖新周期
  _ensureReview(tab, hs) {
    if (!tab) return;
    const RATES = { today: "todayProfitRate", week: "weekProfitRate", month: "monthProfitRate", year: "yearProfitRate" };
    const TAB_LABELS = { today: "今日", week: "本周", month: "本月", year: "本年" };
    const TAB_DAYS = { today: 3, week: 7, month: 25, year: 260 };
    const finish = (best, worst) => {
      // 周期内还没有收盘数据（如周一盘中）→ comboRate 置 null，卡片显示 -- 而不是 0%
      const hasData = tab === "today" ? true : !!this._periodFlags()[tab + "HasData"];
      const review = {
        tabLabel: TAB_LABELS[tab] || "",
        comboRate: hasData ? +(parseFloat(this.data[RATES[tab]]) || 0).toFixed(2) : null,
        hsRate: null, diffText: "", best, worst, opText: "",
      };
      const stale = () => this.data.activeTab !== tab; // 快速切 tab：迟到回调不得覆盖新周期复盘
      this.setData({ reviewCard: review });
      const applyHs = (rows) => {
        if (stale()) return;
        const list = rows || [];
        let hsRate;
        if (tab === "today") {
          // 今日基准 = 最新收盘 / 前一交易日收盘。TAB_DAYS 那套取窗口径对"今日"会放大成 4 个交易日累计
          // （4558.74→4480.08 = -1.73%），挂在"今日"下标就成了老数据
          if (list.length < 2 || !list[list.length - 2].close) return;
          hsRate = +((list[list.length - 1].close / list[list.length - 2].close - 1) * 100).toFixed(2);
        } else {
          // 周/月/年：与走势图、周期签同一口径——基线 = 周期起点前最后一个收盘，端点 = 收盘口径的最新收盘日
          // （按固定根数取窗口会变成"最近 8/26/261 个交易日"，本年那条基线甚至会跑到去年 8 月）
          const end = this._periodEnd();
          const cut = end ? list.filter((r) => r.date <= end) : list;
          const start = this._periodStart(tab);
          let base = null, last = null;
          for (const r of cut) { if (r.date < start) base = r; else last = r; }
          if (!base || !last || !(base.close > 0)) return;
          hsRate = +((last.close / base.close - 1) * 100).toFixed(2);
        }
        review.hsRate = hsRate;
        if (review.comboRate != null) {
          const diff = +(review.comboRate - hsRate).toFixed(2);
          review.diffText = diff === 0
            ? "持平"
            : (diff > 0 ? "跑赢 " : "跑输 ") + Math.abs(diff) + "%";
        }
        this.setData({ reviewCard: { ...review } });
      };
      if (this._idxMap && (this._idxMap["000300"] || []).length >= 2) {
        applyHs(this._idxMap["000300"]);
      } else {
        this._idx("000300", TAB_DAYS[tab] + 2).then(applyHs).catch(() => { /* 基准缺失仅不显示对比 */ });
      }
      api.transactionList().then((res) => {
        if (stale()) return;
        const txs = (res.result && res.result.code === 0 && res.result.data) || [];
        const n = txs.filter((t) => t.date && t.date >= this._periodStart(tab)).length;
        review.opText = n ? `${TAB_LABELS[tab]}操作 ${n} 笔` : "";
        this.setData({ reviewCard: { ...review } });
      }).catch(() => {
        if (stale()) return;
        this.setData({ reviewCard: { ...review } });
      });
    };
    const toRated = (list) => (list || [])
      .filter((h) => h.todayChangeRate != null && parseFloat(h.shares || h.amount || 0) > 0)
      .map((h) => ({ name: h.fundName, rate: +(parseFloat(h.todayChangeRate) || 0).toFixed(2) }))
      .sort((a, b) => b.rate - a.rate);
    try {
      if (hs) {
        const rated = toRated(hs);
        finish(rated[0] || null, rated.length > 1 ? rated[rated.length - 1] : null);
        return;
      }
      // 无本轮明细（冻结期跳过 _fetch / 切 tab）：当日强弱回退首页缓存，其余字段不依赖明细
      const pc = wx.getStorageSync("portfolio_cache");
      const rated = toRated(pc && pc.holdings);
      finish(tab === "today" ? (rated[0] || null) : null, tab === "today" && rated.length > 1 ? rated[rated.length - 1] : null);
    } catch (e) { /* 复盘数据异常不影响主页面 */ }
  },
  _periodStart(tab) {
    if (tab === "today") return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const bj = new Date(Date.now() + 8 * 3600000);
    if (tab === "week") return new Date(bj.getTime() - 86400000 * ((bj.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
    if (tab === "month") return bj.toISOString().slice(0, 7) + "-01";
    return bj.toISOString().slice(0, 4) + "-01-01";
  },

  // 周/月/年都要含当天：当天净值还没公布时，用"昨收市值 + 当天收益"补一个今日点
  // （当天收益盘中是估算、盘后随净值公布更新，所以这个点也随它更新）。
  // 非交易日不补（周末/节假日打开时，当天收益是上一交易日的冻结值）。
  // 补的点只用于计算与绘图，不写进缓存（估算值不能当"已公布净值"长期驻留）
  _withTodayClose(series, rate, amount) {
    const all = series || [];
    if (!all.length) return all;
    const today = calc.formatDate(new Date());
    if (all[all.length - 1].date >= today) return all;      // 今天已在序列里（净值已公布）
    // 只有"9:30 起（含盘后）"才补：9:30 前与周末/节假日，服务端 getPortfolio 的 displayDay 还停在
    // 最近交易日，那份"当天收益"属于上一交易日，补进今天会把那一交易日的涨跌算两遍
    // （marketPhase 的 9:30/15:00 边界与云端 openedToday 的 bjMin>=570 一致）
    if (marketTime.marketPhase() === "closed") return all;
    // 只有"当天收益"确实是今天取到的才补：隔夜打开缓存时它属于上一交易日，补进去会把那天算两遍
    if (this._tpDay !== today) return all;
    const lastVal = all[all.length - 1].value;
    if (!(lastVal > 0)) return all;
    // 今日收盘市值 = 昨收市值 + 当天收益，金额优先（与"当天收益"同源，保证本周金额与当天金额分毫不差）；
    // 金额缺失才退回按收益率折算
    const amt = parseFloat(amount);
    const tpr = parseFloat(rate);
    let todayVal = null;
    if (isFinite(amt) && amt !== 0) todayVal = lastVal + amt;
    else if (isFinite(tpr) && tpr !== 0) todayVal = lastVal * (1 + tpr / 100);
    if (todayVal == null) return all;
    return all.concat([{ date: today, value: +todayVal.toFixed(2) }]);
  },
  // 周/月/年收益：收盘口径序列「期末 / 期初 - 1」，并给出周期内是否已有收盘数据（false → 显示 --）
  _periodSummary(todayRate, todayAmount, baseSeries) {
    const series = this._withTodayClose(baseSeries || this._allDaily || [], todayRate, todayAmount);
    const now = new Date();
    const today = calc.formatDate(now);
    const calcPeriodRate = (startDate) => {
      let first = null, last = null, has = false;
      for (let i = 0; i < series.length; i++) {
        if (series[i].date >= startDate) {
          has = true;
          if (first === null) {
            for (let j = i - 1; j >= 0; j--) { if (series[j].date < startDate) { first = series[j].value; break; } }
            if (first === null) first = series[i].value;
          }
          last = series[i].value;
        }
      }
      if (!first || !last || first <= 0) return { rate: 0, amount: 0, has };
      return { rate: +((last / first - 1) * 100).toFixed(2), amount: +(last - first).toFixed(2), has };
    };
    const wr = calcPeriodRate(this._mon(now));
    const mr = calcPeriodRate(today.slice(0, 7) + "-01");
    const yr = calcPeriodRate(today.slice(0, 4) + "-01-01");
    return {
      weekProfit: wr.amount, weekProfitRate: wr.rate, weekHasData: wr.has,
      monthProfit: mr.amount, monthProfitRate: mr.rate, monthHasData: mr.has,
      yearProfit: yr.amount, yearProfitRate: yr.rate, yearHasData: yr.has,
    };
  },
  // 与首页的"当天收益"对齐：首页每次进入都会刷新组合数据，收益页盘后最长 30 分钟才刷一次，
  // 于是"首页刷新完马上点进收益页"会看到两个不同的数。同一接口只是时刻不同 → 取更新的那一份。
  // 盘后当天收益会随各基金净值陆续公布而变，这里跟着更新（含周/月/年与日历今日格）
  _adoptHomePortfolio() {
    try {
      const pc = wx.getStorageSync("portfolio_cache");
      if (!pc || !pc.ts || pc.todayProfit == null) return false;
      const mine = (wx.getStorageSync(CACHE) || {}).ts || 0;
      if (pc.ts <= mine) return false;                                  // 首页那份不比本页新
      if (String(pc.todayProfit) === String(this.data.todayProfit)) return false;
      const today = calc.formatDate(new Date());
      if (this._dailyChange) this._dailyChange[today] = parseFloat(pc.todayProfit) || 0;
      this._totalMarket = parseFloat(pc.totalAmount) || this._totalMarket;
      this._tpDay = calc.formatDate(new Date(pc.ts)); // 这份当天收益属于首页取数那天
      this.setData({
        todayProfit: pc.todayProfit, todayProfitRate: pc.todayProfitRate,
        ...this._periodSummary(pc.todayProfitRate, pc.todayProfit),
      }, () => { this._updateAsOf(); this._draw(); this._cal(); this._ensureReview(this.data.activeTab); });
      return true;
    } catch (e) { return false; }
  },
  // 当前收盘口径的市值序列（缓存直出路径也走它，图表与周/月/年收益都以它为准）
  _closingSeries() {
    return this._withTodayClose(this._allDaily || [], this.data.todayProfitRate, this.data.todayProfit);
  },
  // 收盘口径的端点日：周/月/年的沪深300 要截到同一天，两端才可比
  _periodEnd() {
    const s = this._closingSeries();
    return s.length ? s[s.length - 1].date : "";
  },
  // 周期内是否已有收盘数据：没有（如周一盘中，本周还没有任何收盘）时显示 --，
  // 不能把"还没收盘"当成 0% 展示（0 是"确认为零收益"的真值语义）
  _periodFlags(rate, amount) {
    // 缓存直出时 data 里的今日收益还是旧值，必须显式传入（否则会把"还没数据"误判成 false）
    const s = rate == null
      ? this._closingSeries()
      : this._withTodayClose(this._allDaily || [], rate, amount);
    const has = (tab) => s.some((r) => r.date >= this._periodStart(tab));
    return { weekHasData: has("week"), monthHasData: has("month"), yearHasData: has("year") };
  },

  // ==== 周期签（周签/月签/年签）：对应 tab 内生成"至今"数据卡，年度报告的工艺热身 ====
  onShowSignCard(e) {
    const period = (e && e.currentTarget && e.currentTarget.dataset.period) || "week";
    const TABS = { week: "周签", month: "月签", year: "年签" };
    const titles = { week: "本周收益", month: "本月收益", year: "本年收益" };
    const profits = { week: this.data.weekProfit, month: this.data.monthProfit, year: this.data.yearProfit };
    const rates = { week: this.data.weekProfitRate, month: this.data.monthProfitRate, year: this.data.yearProfitRate };
    this._signCanvas = null; // 新签作废旧 canvas：本张失败时不能保存到上一张
    this.setData({ showSignModal: true, signRendering: true, signPeriod: period, signTitle: TABS[period] || "周签" });
    const days = this.data.signDays[period] || 10;
    const start = this._periodStart(period);
    const applyRows = (rows) => {
      // 区间与基线按周期起点锚定：基线 = 起点前最后一个收盘（否则漏掉周期首日涨幅）
      // 指数也截到收盘口径的端点日，与组合的周/月/年收益同一天
      const end = this._periodEnd();
      const cut = end ? (rows || []).filter((r) => r.date <= end) : (rows || []);
      const inRange = cut.filter((r) => r.date >= start);
      const prev = cut.filter((r) => r.date < start).pop();
      const base = prev || inRange[0];
      const hsRate = (base && inRange.length && base.close > 0)
        ? +((inRange[inRange.length - 1].close / base.close - 1) * 100).toFixed(2) : null;
      const rangeText = inRange.length
        ? inRange[0].date.slice(5).replace("-", "/") + " ~ " + inRange[inRange.length - 1].date.slice(5).replace("-", "/")
        : "";
      api.transactionList().then((res) => {
        const txs = (res.result && res.result.code === 0 && res.result.data) || [];
        const ops = txs.filter((t) => t.date && t.date >= start).length;
        const pc = wx.getStorageSync("portfolio_cache");
        const fundCount = pc && pc.holdings ? pc.holdings.filter((h) => parseFloat(h.shares || h.amount || 0) > 0).length : 0;
        // 先收起 loading 让 canvas 挂载，再查询节点绘制（查询时 canvas 尚未渲染会拿到空节点）
        this.setData({ signRendering: false }, () => {
          wx.nextTick(() => {
            const query = wx.createSelectorQuery();
            query.select("#signCanvas").fields({ node: true, size: true }).exec((cres) => {
              if (!cres || !cres[0] || !cres[0].node) {
                this._signCanvas = null;
                wx.showToast({ title: "生成失败，请重试", icon: "none" });
                return;
              }
              this._signCanvas = cres[0].node;
              const shareCard = require("../../../../utils/shareCard");
              shareCard.drawWeeklyCard(cres[0].node, {
                title: titles[period] || "本周收益",
                rangeText,
                weekProfit: profits[period],
                weekProfitRate: rates[period],
                hsRate,
                opText: ops + " 笔",
                opLabel: `本${{ week: "周", month: "月", year: "年" }[period]}操作`,
                fundCount,
                earliestDate: this.data.earliestDate,
                amountVisible: this.data.amountVisible,
              }).then(() => this.setData({ signRendering: false }))
                .catch(() => this.setData({ signRendering: false }));
            });
          });
        });
      }).catch(() => { this.setData({ signRendering: false }); });
    };
    // 沪深300 同期日线：优先 _fetch 已拉的 _idxMap（全年），冻结期回退 _idx 独立缓存
    if (this._idxMap && (this._idxMap["000300"] || []).length >= 2) {
      applyRows(this._idxMap["000300"]);
    } else {
      this._idx("000300", days + 2).then(applyRows).catch(() => { this.setData({ signRendering: false }); wx.showToast({ title: "生成失败，请重试", icon: "none" }); });
    }
  },
  onSignClose() {
    this.setData({ showSignModal: false });
  },
  onSaveSign() {
    if (!this._signCanvas) return;
    wx.canvasToTempFilePath({
      canvas: this._signCanvas,
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
          fail: () => wx.showToast({ title: "保存失败，请授权相册权限", icon: "none" }),
        });
      },
      fail: () => wx.showToast({ title: "生成图片失败", icon: "none" }),
    });
  },
  noop() {},
  onShareAppMessage() {
    track.share({ sharePage: "profit" });
    return { title: "我的收益走势 · 韭菜估值宝", path: "/subpackages/analysis/pages/profit-detail/index" };
  },

  // 数据截至时间：取最新盘中快照的分钟（快照缺失则不显示，避免误导）
  _updateAsOf() {
    const snaps = this._profitSnapshots || [];
    const t = snaps.length ? (snaps[snaps.length - 1].time || "") : "";
    if (t && t !== this.data.asOfTime) this.setData({ asOfTime: t });
  },

  async _fetch() {
    if (this._fetching) return; // 防重入：下拉刷新/onShow 并发时只跑一个
    this._fetching = true;
    try {
      // 指数分时与全量聚合并行：此前等 getPortfolio 完成后才拉分时，当天图首屏多等一整轮网络
      if (this.data.activeTab === 'today' && this._shouldRefetchIntraday()) this.fetchIntraday();
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const calendarDays = Math.ceil((now - yearStart) / 86400000);
      const historyDays = Math.ceil(calendarDays * 5 / 7) + 10;
      const idxMap = {};
      const idxTasks = this.data.availableIndices.map(i => this._idx(i.code, historyDays));
      const [pfRes, ...idxResults] = await Promise.all([
        api.getPortfolio(historyDays),
        ...idxTasks,
      ]);
    this.data.availableIndices.forEach((i, n) => { idxMap[i.code] = idxResults[n] || []; });
      this._idxMap = idxMap;
      if (!pfRes.result || pfRes.result.code !== 0) {
        // 已有数据时静默失败并保留当前展示，避免刷新失败把页面打成全屏错误
        if (this._allDaily && this._allDaily.length) {
          wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none' });
          this.setData({ loading: false });
        } else {
          if (!this._cacheApplied) wx.showToast({ title: '数据加载失败', icon: 'none' });
          this.setData({ loading: false, loadError: true });
        }
        return;
      }
      const d = pfRes.result.data;

      // getPortfolio 的日内快照为空（当天快照上游尚未写入）时不清空已有数据——
      // 避免与 _quickFirstPaint 竞态把已就绪的今日快照打回空；有数据时取更长的一份（更新）
      const newSnaps = (d.intradaySnapshots && d.intradaySnapshots.length)
        ? d.intradaySnapshots.slice().sort((a, b) => a.time.localeCompare(b.time))
        : [];
      if (newSnaps.length >= (this._profitSnapshots || []).length) {
        this._profitSnapshots = newSnaps;
      }

      const hs = d.holdings || [];
      if (!hs.length) { this.setData({ empty: true, loading: false }); return; }

      const totalCost = hs.reduce((s, h) => s + h.buyPrice * h.shares, 0);
      const navMap = d.navHistoryMap || {};
      const today = calc.formatDate(now);

      // 日变动
      const dc = {};
      hs.forEach(h => {
        let shares = parseFloat(h.shares || h.amount || 0);
        if (!shares && h.marketValue) { const cn = h.currentNav || h.buyPrice; if (cn > 0) shares = parseFloat(h.marketValue) / cn; }
        if (!shares) return;
        const hist = [...(navMap[h.fundCode] || [])].reverse();
        if (hist.length < 2) return;
        const sd = h.createTime ? calc.formatDate(h.createTime) : null;
        for (let i = 1; i < hist.length; i++) {
          if (sd && hist[i].date < sd) continue;
          const chg = (hist[i].nav - hist[i - 1].nav) * shares;
          if (!dc[hist[i].date]) dc[hist[i].date] = 0;
          dc[hist[i].date] += chg;
        }
      });
      Object.keys(dc).forEach(k => { dc[k] = +dc[k].toFixed(2); });
      const dcFinal = { ...dc };

      // 市值
      const dm = {};
      hs.forEach(h => {
        let s = parseFloat(h.shares || h.amount || 0);
        if (!s && h.marketValue) { const cn = h.currentNav || h.buyPrice; if (cn > 0) s = parseFloat(h.marketValue) / cn; }
        if (!s) return;
        (navMap[h.fundCode] || []).forEach(x => { if (!dm[x.date]) dm[x.date] = 0; dm[x.date] += x.nav * s; });
      });
      const allDaily = Object.entries(dm).map(([dt, v]) => ({ date: dt, value: +v.toFixed(2) })).sort((a, b) => a.date.localeCompare(b.date));
      // 去掉最后一天不完整数据（部分基金净值未公布会导致市值虚降）
      if (allDaily.length >= 2) {
        const lastCnt = hs.reduce((c, h) => c + ((navMap[h.fundCode || ''] || []).some(x => x.date === allDaily[allDaily.length - 1].date) ? 1 : 0), 0);
        const prevCnt = hs.reduce((c, h) => c + ((navMap[h.fundCode || ''] || []).some(x => x.date === allDaily[allDaily.length - 2].date) ? 1 : 0), 0);
        if (lastCnt < prevCnt) allDaily.pop();
      }

      const lastDate = allDaily.length ? allDaily[allDaily.length - 1].date : "";
      // 用数据驱动判断：NAV 已公布到今日 + 有日内快照，两信号均为 false 才是非交易日
      // 不依赖 _isTradingNow()——它只看星期几，区分不了周五节假日
      // 快照可能回退到最近交易日（非交易日打开），snapDate 非今日时不算"今日快照"
      const hasTodaySnaps = (d.snapDate || today) === today && d.intradaySnapshots && d.intradaySnapshots.length > 0;
      // 数据驱动的"今日是否交易日"标志，供 _isTradingNow 复用（识别节假日/临时休市）；
      // 追加节假日表兜底：快照文档缺失时，真实交易日（周末/节假日由表排除）仍注入当日收益
      const isTradingDay = lastDate === today || hasTodaySnaps || marketTime.isTradingDay(today);
      this._isTodayTrading = isTradingDay;
      if (!isTradingDay) {
        Object.keys(idxMap).forEach(k => { idxMap[k] = (idxMap[k] || []).filter(d => d.date !== today); });
      }
      const tp = parseFloat(d.todayProfit) || 0;
      if (isTradingDay && tp !== 0) dcFinal[today] = tp;

      // 收益率：和走势图一致，用「期末市值 / 期初市值 - 1」。序列含当天（当天收益值，盘后随净值公布更新）
      this._tpDay = today; // 这份当天收益属于今天
      const summ = this._periodSummary(d.todayProfitRate, d.todayProfit, allDaily);
      const weekProfitRate = summ.weekProfitRate, monthProfitRate = summ.monthProfitRate, yearProfitRate = summ.yearProfitRate;
      const w = summ.weekProfit, m = summ.monthProfit, y = summ.yearProfit;

      this._allDaily = allDaily;
      this._dailyChange = dcFinal;
      this._indexDaily = idxMap[this.data.compareIndex] || [];
      this._totalCost = totalCost;
      this._totalMarket = parseFloat(d.totalAmount) || 0;
      this._cacheApplied = false;

      const earliestCreate = hs.reduce((min, h) => { if (!h.createTime) return min; const d = calc.formatDate(h.createTime); return d < min ? d : min; }, "9999-99-99");

      this.setData({
        loading: false,
        totalCost,
        todayProfitRate: parseFloat(d.todayProfitRate || 0),
        todayProfit: tp.toFixed(2),
        weekProfit: w, monthProfit: m, yearProfit: y,
        weekProfitRate, monthProfitRate, yearProfitRate,
        weekHasData: summ.weekHasData, monthHasData: summ.monthHasData, yearHasData: summ.yearHasData,
        earliestDate: earliestCreate === "9999-99-99" ? "" : earliestCreate,
      }, () => {
        this._draw(); this._cal();
        // 复盘卡在利率写入 data 之后再构建，否则 comboRate 读到上一轮的旧值
        if (this.data.activeTab === "today") this._ensureReview("today", hs);
      });
      this._updateAsOf();
      // 指数分时：交易时段实时拉新；非交易时段数据已定格，命中当天缓存即跳过（零网络）
      if (this.data.activeTab === 'today' && this._shouldRefetchIntraday()) this.fetchIntraday();

      const cal = this._calCached();
      const hasIndex = Object.values(idxMap).some(arr => arr && arr.length);
      if (hasIndex) {
        this._retryCount = 0;
        wx.setStorage({ key: CACHE, data: { d: allDaily, dc: dcFinal, idx: this._indexDaily, im: idxMap, ed: earliestCreate, tc: totalCost, s: { tp: tp.toFixed(2), tpr: parseFloat(d.todayProfitRate || 0), w, m, y, wr: weekProfitRate, mr: monthProfitRate, yr: yearProfitRate }, cal, ts: Date.now(), actualDate: allDaily.length ? allDaily[allDaily.length - 1].date : "" } });
      } else {
        this._retryCount = (this._retryCount || 0) + 1;
        if (this._retryCount <= 3) setTimeout(() => this._fetch(), 2000);
      }
    } catch (e) {
      // 已有数据时静默失败并保留当前展示
      if (this._allDaily && this._allDaily.length) {
        this.setData({ loading: false });
        wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none' });
      } else {
        this.setData({ loading: false, loadError: true });
        if (!this._cacheApplied) wx.showToast({ title: '数据加载失败', icon: 'none' });
      }
    } finally {
      this._fetching = false;
    }
  },

  onRetry() {
    this.setData({ loading: true, loadError: false });
    this._fetch();
  },

  // ============ 图 ============

  _data() {
    // 走势图与周/月/年收益同源：收盘口径序列（收盘后含今日收盘点，盘中停在上一收盘）
    const all = this._closingSeries(), idx = this._indexDaily || [];
    if (!all.length) return null;
    const now = new Date(), today = calc.formatDate(now);

    // 计算周期起止日期
    let st, ed;
    if (this.data.activeTab === "week") {
      st = this._mon(now);
      const [sy, sm, sd] = st.split('-').map(Number);
      const c = new Date(sy, sm - 1, sd); c.setDate(c.getDate() + 6);
      ed = calc.formatDate(c);
    } else if (this.data.activeTab === "month") {
      st = today.slice(0, 7) + "-01";
      const [y, m] = st.split('-').map(Number);
      ed = `${today.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      if (ed > today) ed = today;
    } else {
      st = today.slice(0, 4) + "-01-01";
      ed = today.slice(0, 4) + "-12-31";
      if (ed > today) ed = today;
    }

    // 生成周期内每一天
    const dates = [];
    {
      const [sy, sm, sd] = st.split('-').map(Number);
      const [ey, em, eday] = ed.split('-').map(Number);
      const cur = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, eday);
      while (cur <= end) { dates.push(calc.formatDate(cur)); cur.setDate(cur.getDate() + 1); }
    }
    if (dates.length < 1) return null;

    const pm = {}; all.forEach(d => { pm[d.date] = d; });
    // 指数线截到收盘口径的端点日：盘中不画今天的实时点，避免指数线比组合线多走一天
    const endDay = all[all.length - 1].date;
    const im = {}; idx.forEach(d => { if (d.date <= endDay) im[d.date] = d; });

    // 基准取周期开始前最后一个有数据的交易日，确保第一个点显示实际涨跌幅而非 0
    let ib = null, pb = null;
    for (let i = idx.length - 1; i >= 0; i--) { if (idx[i].date < st) { ib = idx[i].close; break; } }
    for (let i = all.length - 1; i >= 0; i--) { if (all[i].date < st) { pb = all[i].value; break; } }
    // 没找到前一天数据则兜底取周期内第一个有效值
    if (ib === null) { for (const d of dates) { if (im[d]) { ib = im[d].close; break; } } }
    if (pb === null) { for (const d of dates) { if (pm[d]) { pb = pm[d].value; break; } } }
    const hasP = pb !== null && pb > 0;

    const data = dates.map(d => {
      const i = im[d], p = pm[d];
      return {
        date: d,
        baseRate: (hasP && p) ? +((p.value / pb - 1) * 100).toFixed(2) : null,
        indexRate: (ib !== null && i) ? +((i.close / ib - 1) * 100).toFixed(2) : null
      };
    });

    // 计算滚动回撤
    const validValues = data.map(d => d.baseRate !== null ? { value: pb * (1 + d.baseRate / 100) } : null);
    let drawdowns = [];
    if (validValues.filter(v => v).length >= 2) {
      // 用市值序列计算回撤
      const mvData = all.filter(a => a.date >= st && a.date <= ed).map(a => ({ value: a.value }));
      if (mvData.length >= 2) {
        drawdowns = calc.calcRunningDrawdown(mvData);
      }
    }
    // 按日期映射回撤
    const ddMap = {};
    const mvDateData = all.filter(a => a.date >= st && a.date <= ed);
    drawdowns.forEach((dd, i) => { if (i < mvDateData.length) ddMap[mvDateData[i].date] = dd; });
    data.forEach(d => { d.drawdown = ddMap[d.date] != null ? ddMap[d.date] : null; });

    const hasIdx = ib !== null;
    const validProfit = data.filter(d => d.baseRate !== null);
    const validIdx = data.filter(d => d.indexRate !== null);
    if (validProfit.length === 0 && validIdx.length === 0) return null;

    return { data, hasP: validProfit.length > 0, noIdx: !hasIdx };
  },

  _draw() {
    if (this._destroyed) return; // 页面已卸载，不再绘制
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const isToday = this.data.activeTab === 'today';

    if (isToday) {
      // 快照和指数数据都缺失时才依赖当日缓存；任一数据源有数据即可绘制
      if ((this._profitSnapshots || []).length === 0 && (this._intradayRaw || []).length === 0) {
        const idx = this.data.compareIndex || '000001';
        this._todayCaches = this._todayCaches || {};
        if (!this._todayCaches[idx]) {
          const sc = wx.getStorageSync(INTRADAY_CACHE_PREFIX + idx);
          if (!sc || sc.date !== calc.formatDate(new Date())) return;
          this._todayCaches[idx] = sc;
        }
      }
      this._drawToday();
      return;
    }

    const r = this._data();

    const query = wx.createSelectorQuery();
    query.select('#profitCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const dpr = wx.getWindowInfo().pixelRatio;
      const cw = res[0].width || w;
      const ch = res[0].height || h;
      const targetW = cw * dpr, targetH = ch * dpr;
      // 历史走势图也用「从左到右画出来」的进场动画（与当天走势同款）；
      // 该图绘图区内有横向网格，刷白后由 restore 用页面自己的 _drawGrid 补回
      const drawFn = (target) => {
        const ctx = chartUtil._init(target, cw, ch);
        if (!r) { ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch); return; }
        this._drawHistory(ctx, cw, ch, r);
      };
      chartUtil.drawChartAnimated(canvas, {
        w: cw, h: ch,
        plot: { left: 52, right: 12, top: 40, bottom: 36 },
        animate: !this._histAnimated, duration: 1200,
        draw: drawFn,
        restore: (ctx) => {
          const g = this._chartDraw;
          if (g && g.yi) this._drawGrid(ctx, g.p, g.cw, g.ch, g.y0, g.y1, g.yi);
        },
      });
      this._histAnimated = true;
    });
  },

  _drawHistory(ctx, cw, ch, r) {
    const { data, hasP, noIdx } = r;
    const p = { t: 40, r: 12, b: 36, l: 52 };
    const pw = cw - p.l - p.r, ph = ch - p.t - p.b;
    const xi = data.length > 1 ? i => p.l + (pw / (data.length - 1)) * i : () => p.l + pw / 2;

    const drawAxis = (vals, marker, label) => {
      let mn = Math.min(...vals), mx = Math.max(...vals);
      if (mn > 0) mn = 0; if (mx < 0) mx = 0;
      const rg = mx - mn || 0.01, y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
      const yi = v => p.t + ph - ((v - y0) / (y1 - y0)) * ph;
      ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch);
      this._drawGrid(ctx, p, cw, ch, y0, y1, yi);

      const pc2 = data.filter(d => d.baseRate !== null);
      const profitColor = pc2.length >= 2 && pc2[pc2.length - 1].baseRate >= pc2[0].baseRate ? '#E4393C' : '#2E8B57';
      const fmt = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--';

      // 单有效点时画圆，确保 Canvas 刷新
      if (pc2.length === 1 && data.filter(d => d.indexRate !== null).length <= 1) {
        const cx = xi(data.indexOf(pc2[0])), cy = yi(pc2[0].baseRate);
        ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
        ctx.fillStyle = profitColor; ctx.fill();
        ctx.strokeStyle = '#FFF'; ctx.lineWidth = 1; ctx.stroke();
        const idxPt = data.find(d => d.indexRate !== null);
        if (idxPt) {
          const ix = data.indexOf(idxPt), iy = yi(idxPt.indexRate);
          ctx.beginPath(); ctx.arc(xi(ix), iy, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#1976D2'; ctx.fill();
          ctx.strokeStyle = '#FFF'; ctx.lineWidth = 1; ctx.stroke();
        }
      }

      if (marker === 'baseRate') {
        this._fillArea(ctx, data, 'baseRate', xi, yi, profitColor);
        this._line(ctx, data, 'baseRate', xi, yi, profitColor);
        ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillStyle = profitColor; ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText(label || '收益', p.l + 20, 12);
      } else if (marker === 'dual') {
        this._fillArea(ctx, data, 'baseRate', xi, yi, profitColor);
        this._fillArea(ctx, data, 'indexRate', xi, yi, '#1976D2');
        this._line(ctx, data, 'baseRate', xi, yi, profitColor);
        this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
        ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillStyle = profitColor; ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText('我的收益' + fmt(pc2[pc2.length - 1].baseRate), p.l + 20, 12);
        ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 22, 12, 4);
        const idxVals = data.map(d => d.indexRate).filter(v => v != null);
        ctx.fillStyle = '#666'; ctx.fillText(this.data.compareLabel + (idxVals.length > 0 ? ' ' + fmt(idxVals[idxVals.length - 1]) : ''), p.l + 20, 24);
      } else {
        this._fillArea(ctx, data, 'indexRate', xi, yi, '#1976D2');
        this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
        ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText(this.data.compareLabel, p.l + 20, 12);
      }
      ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) { const v = y1 - (y1 - y0) / 4 * i; ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v)); }
      ctx.textBaseline = 'top'; ctx.font = '11px sans-serif';
      const last = data.length - 1;
      if (data.length === 1) {
        ctx.textAlign = 'center';
        ctx.fillText(data[0].date.slice(5), xi(0), ch - p.b + 8);
      } else {
        const positions = [0, Math.floor(last / 2), last];
        const aligns = ['left', 'center', 'right'];
        positions.forEach((ix, i) => {
          ctx.textAlign = aligns[i];
          const x = i === 2 ? xi(ix) - 4 : i === 0 ? xi(ix) + 4 : xi(ix);
          ctx.fillText(data[ix].date.slice(5), x, ch - p.b + 8);
        });
      }
      this._chartDraw = { data, p, cw, ch, pw, ph, y0, y1, xi, yi, noIdx, hasP, compareLabel: this.data.compareLabel };
    };

    if (noIdx) { const vs = data.filter(d => d.baseRate !== null).map(d => d.baseRate); if (vs.length >= 2) drawAxis(vs, 'baseRate', ''); }
    else if (hasP) { const av = [...data.map(d => d.baseRate).filter(v => v !== null), ...data.map(d => d.indexRate)]; if (av.length >= 2) drawAxis(av, 'dual'); }
    else { drawAxis(data.map(d => d.indexRate), 'index'); }

    // 叠加回撤曲线
    const ddPts = data.filter(d => d.drawdown !== null);
    if (ddPts.length >= 2 && this._chartDraw) {
      const { xi, yi } = this._chartDraw;
      // 回撤面积填充
      ctx.beginPath();
      const firstDd = ddPts[0], lastDd = ddPts[ddPts.length - 1];
      const firstIdx = data.indexOf(firstDd), lastIdx = data.indexOf(lastDd);
      ctx.moveTo(xi(firstIdx), yi(0));
      ddPts.forEach((d, i) => { ctx.lineTo(xi(data.indexOf(d)), yi(d.drawdown)); });
      ctx.lineTo(xi(lastIdx), yi(0));
      ctx.closePath();
      const ddGrad = ctx.createLinearGradient(0, yi(0), 0, yi(Math.min(...ddPts.map(d => d.drawdown))));
      ddGrad.addColorStop(0, 'rgba(255,152,0,0.06)');
      ddGrad.addColorStop(1, 'rgba(255,152,0,0.12)');
      ctx.fillStyle = ddGrad;
      ctx.fill();
      // 回撤线
      ctx.beginPath();
      ddPts.forEach((d, i) => { const x = xi(data.indexOf(d)), y = yi(d.drawdown); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.strokeStyle = 'rgba(255,152,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // 图例
      const maxDd = -Math.min(...ddPts.map(d => d.drawdown));
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,152,0,0.6)'; ctx.fillRect(p.l + 4, hasP && !noIdx ? 34 : 22, 12, 4);
      ctx.fillStyle = '#999'; ctx.textAlign = 'left'; ctx.fillText('回撤 ' + maxDd.toFixed(1) + '%', p.l + 20, hasP && !noIdx ? 36 : 24);
    }
  },

  _drawGrid(ctx, p, cw, ch, y0, y1, yi) {
    ctx.strokeStyle = 'rgba(0,0,0,0.06)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 0; i <= 4; i++) {
      const v = y1 - (y1 - y0) / 4 * i;
      ctx.beginPath(); ctx.moveTo(p.l, yi(v)); ctx.lineTo(cw - p.r, yi(v)); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (y0 < 0 && y1 > 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(p.l, yi(0)); ctx.lineTo(cw - p.r, yi(0)); ctx.stroke();
      ctx.setLineDash([]);
    }
  },

  _line(ctx, data, f, xi, yi, c) {
    const pts = []; data.forEach((d, i) => { if (d[f] !== null) pts.push({ x: xi(i), y: yi(d[f]) }); });
    if (pts.length < 1) return;
    ctx.beginPath();
    pts.forEach((p, i) => { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
    ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke();
  },
  _fillArea(ctx, data, f, xi, yi, c) {
    const valid = data.filter(d => d[f] !== null);
    if (valid.length < 2) return;
    ctx.beginPath();
    valid.forEach((d, i) => { const x = xi(data.indexOf(d)), y = yi(d[f]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.lineTo(xi(data.lastIndexOf(valid[valid.length - 1])), yi(0));
    ctx.lineTo(xi(data.indexOf(valid[0])), yi(0));
    ctx.closePath();
    ctx.fillStyle = c === '#E4393C' ? 'rgba(228,57,60,0.06)' : c === '#1976D2' ? 'rgba(25,118,210,0.06)' : 'rgba(46,139,87,0.06)';
    ctx.fill();
  },


  _buildIntradayData() {
    try {
    const profitSnaps = this._profitSnapshots || [];
    const idxRaw = this._intradayRaw || [];

    const isTrading = (chinaTime) => {
      const [hh, mm] = chinaTime.split(':').map(Number);
      const total = hh * 60 + mm;
      return (total >= 570 && total <= 690) || (total >= 780 && total <= 900);
    };

    // 以指数分时为时间主轴（交易时段连续分钟），让「我的收益」rate 对齐到指数的时间点。
    // 快照 rate 可能有缺口（snapshotProfit 某些分钟未写入），缺失分钟用最近一次有效快照
    // 前值填充（ffill），使两条线时间点一致、锯齿对齐；避免红线在快照稀疏处大段直连。
    // 快照 time 由 snapshotProfit 写入，已是北京时间（getUTCHours()+8），与指数时间同一坐标系。
    // 快照点存双口径（rate=数据源一口径、rateSelf=自算口径，旧点为单值无 rateSelf）：
    // 按用户数据源偏好选值，切换源后整条曲线按所选源重绘
    const srcSelf = api.estimateSrc() === "self";
    const snapMap = {};
    profitSnaps.forEach(p => {
      if (!isTrading(p.time)) return;
      // 同一分钟多快照时取最后写入的一个
      snapMap[p.time] = (srcSelf && p.rateSelf != null) ? p.rateSelf : p.rate;
    });

    // 时间主轴：优先用指数分时的时间序列（连续、密集）；指数缺失时退回快照时间轴
    let axis;
    if (idxRaw.length) {
      axis = idxRaw.filter(d => isTrading(d.time)).map(d => d.time);
    } else {
      axis = profitSnaps.filter(p => isTrading(p.time)).map(p => p.time);
    }
    // 去重 + 排序
    axis = [...new Set(axis)].sort((a, b) => a.localeCompare(b));

    const idxMap = {};
    idxRaw.forEach(d => { if (isTrading(d.time)) idxMap[d.time] = d.changeRate; });

    let lastRate = null;
    const result = axis.map(t => {
      const rate = snapMap[t] != null ? snapMap[t] : lastRate; // 缺失分钟 → 前值填充
      if (rate != null) lastRate = rate;
      return { time: t, rate, indexRate: idxMap[t] != null ? idxMap[t] : null };
    });

    // 平滑「我的收益」分钟线：快照率 = 持仓股实时价加权估算，分钟噪声大，直接连线呈锯齿折线
    this._smoothRate(result);

    const hasRate = result.filter(d => d.rate != null).length;
    const hasIdx = result.filter(d => d.indexRate != null).length;
    if (hasRate > 20 && hasIdx > 20) this._saveTodayCache(result);

    // 末端口径对齐：快照分钟点与顶部「当天收益」卡（实时/盘后净值口径）天然存在时间差，
    // 差异明显时不替换会让图例与卡片对不上；用卡片当前值替换末端点使两处一致
    return this._alignEndWithOfficial(result);
    } catch(e) {
      return [];
    }
  },

  // 将曲线最后一个点替换为组合当前口径值（todayProfitRate），使图例与顶部摘要一致。
  // 盘中快照滞后 1~2 分钟、盘后快照=盘中估算 vs 卡片=正式净值，都靠此对齐；
  // 卡片与快照值一致时（差异 < 0.02）不生效，保持曲线原生走势。
  // 不可变：传入数组可能是 _todayCaches 的缓存对象，复制末端点生成新数组返回，不动缓存
  _alignEndWithOfficial(result) {
    if (!result || !result.length) return result;
    const rate = parseFloat(this.data.todayProfitRate);
    if (!(rate > -100 && rate < 100)) return result;
    const pts = result.filter(p => p.rate != null);
    if (!pts.length) return result;
    const last = pts[pts.length - 1];
    if (Math.abs(last.rate - rate) < 0.02) return result;
    const idx = result.indexOf(last);
    return result.slice(0, idx).concat([{ ...last, rate }]);
  },

  // 居中移动平均平滑（窗口 3 点）：首尾点保留原始值（首点是开盘基准，末点是最后一个真实快照）。
  // 快照率已是分钟粒度（组合内多基金加权），窗口过大（9 点）会抹平分钟起伏，过小则单点噪声显现。
  // 仅在时间连续的区段内平滑：相邻点时间差 > 30 分钟（午休/断点）即断开，避免跨时段混合。
  _smoothRate(result) {
    const WINDOW = 3, half = Math.floor(WINDOW / 2);
    const runs = [];
    let run = [];
    for (let i = 0; i < result.length; i++) {
      const d = result[i];
      if (typeof d.rate !== 'number') continue;
      if (run.length && this._toMin(d.time) - this._toMin(result[run[run.length - 1]].time) > 30) {
        runs.push(run);
        run = [];
      }
      run.push(i);
    }
    if (run.length) runs.push(run);
    runs.forEach((run) => {
      if (run.length < 3) return; // 点数太少不平滑，保持原始值
      for (let i = 1; i < run.length - 1; i++) {
        const lo = Math.max(0, i - half), hi = Math.min(run.length - 1, i + half);
        let sum = 0;
        for (let j = lo; j <= hi; j++) sum += result[run[j]].rate;
        result[run[i]].rate = +(sum / (hi - lo + 1)).toFixed(2);
      }
    });
  },

  // "HH:mm" → 当日分钟数
  _toMin(t) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  },

  _drawToday() {
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const compareLabel = this.data.compareLabel || '上证指数';
    const indexCode = this.data.compareIndex || '000001';

    // 盘中快照尚未产出（snapshotProfit 早盘首次跑需先补拉前日净值）：指数已就位但我的收益无数据。
    // 只要"指数已就绪但快照为空"就轻拉一次快照（20 秒节流），让绿线尽快出现，不等 30s 轮询兜底。
    // 注：原条件限于 _isTradingNow()，非盘中/缓存快照晚到时会先画出一条孤零零的指数蓝线，
    //     与我的收益绿线错开 1~2 秒；放宽后两条线接近同步出现。
    if ((this._profitSnapshots || []).length === 0 && (this._intradayRaw || []).length > 0) {
      const now = Date.now();
      if (!this._snapRetryTs || now - this._snapRetryTs > 20000) {
        this._snapRetryTs = now;
        api.portfolioLight().then((r) => {
          const d = r.result && r.result.data;
          if (!d || !d.intradaySnapshots || !d.intradaySnapshots.length) return;
          this._profitSnapshots = d.intradaySnapshots.slice().sort((a, b) => a.time.localeCompare(b.time));
          this._todayCaches = {};
          try { wx.removeStorageSync(INTRADAY_CACHE_PREFIX + indexCode); } catch (e) {}
          this._updateAsOf();
          this._draw();
        }).catch(() => {});
      }
    }

    this._todayCaches = this._todayCaches || {};
    // 收盘后只有"覆盖到收盘"的缓存可直接渲染；半截缓存跳过，
    // 交给下面的 _buildIntradayData 用完整分时重建（否则会先闪一版半截曲线）
    const trading = this._isTradingNow();
    const memCache = this._todayCaches[indexCode];
    if (memCache && memCache.data && memCache.data.length > 0
        && (trading || this._cacheCoversSession(memCache.data))) {
      this._renderToday(w, h, memCache.data, compareLabel);
      return;
    }

    const storageData = this._loadTodayCache(indexCode);
    if (storageData && (trading || this._cacheCoversSession(storageData))) {
      this._renderToday(w, h, storageData, compareLabel);
      return;
    }

    // 彻底同步：当天图首次渲染必须"快照(我的收益)+指数"都就绪，避免指数先到画出只有蓝线、
    // 快照后到再补绿线的错开。未就绪时挂起等待（两路任一更新会再走 _draw）。
    const hasSnap = (this._profitSnapshots || []).length > 0;
    const hasIdx = (this._intradayRaw || []).length > 0;
    if (!hasSnap || !hasIdx) {
      // 兜底：挂起超过 3s 仍未双就绪 → 用已就绪的单一数据源渲染，避免空白（如非交易日无快照）
      if (!this._todayRenderDeadline) this._todayRenderDeadline = Date.now() + 3000;
      if (Date.now() < this._todayRenderDeadline) return;
    }
    this._todayRenderDeadline = 0;
    const data = this._buildIntradayData();
    this._renderToday(w, h, data, compareLabel);
  },

  _renderToday(w, h, data, compareLabel) {
    // 统一入口：无论数据来自内存缓存/存储缓存/_buildIntradayData，盘后都做末端口径对齐
    // （缓存里可能是盘中保存的估算末端 0.62%，不对齐则图例永远与摘要卡 0.55% 差 7bp）
    data = this._alignEndWithOfficial(data);
    const query = wx.createSelectorQuery();
    query.select('#profitCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        // canvas 节点首帧未挂载：数据已就绪，但查询不到节点。延后重画而非丢弃，
        // 避免非交易时段首屏空白（此前静默 return 导致图被丢弃，要等下一次请求才补画）
        if (this._todayRenderRetry == null) this._todayRenderRetry = 0;
        if (this._todayRenderRetry < 5) {
          this._todayRenderRetry++;
          setTimeout(() => this._drawToday(), 120);
        }
        return;
      }
      this._todayRenderRetry = 0;
      // 用 selector 实测宽度（canvas 在 .chart-card 内被 margin/padding 收窄，
      // 沿用 windowWidth-24 会导致触摸坐标偏移约 10%）
      const rw = res[0].width || w;
      const rh = res[0].height || h;
      this._realW = rw;
      this._realH = rh;
      // 进场动画只在"首次出图/切回今日/换对比指数"时播放，30s 轮询刷新不重播（否则每 30 秒重画一次很烦）
      const animate = !this._todayAnimated;
      if (animate) this._todayAnimated = true;
      chartUtil.drawIntradayChartAnimated(res[0].node, {
        w: rw, h: rh, data,
        labelA: '我的收益', labelB: compareLabel,
        animate, duration: 1200,
      });
      // 快照存页级：chart._lastIntradayDraw 是模块单例，页面栈里两个图表页会互相覆盖（十字线错位）
      this._intradaySnap = chartUtil._lastIntradayDraw;
      // 预取其它指数分时：挂在"首次真正渲染"之后。原来挂在 fetchIntraday 尾部，
      // 但首屏命中分时缓存时不会走那里 → 预取静默失效 → 切指数仍要等请求
      if (!this._prefetchKicked) {
        this._prefetchKicked = true;
        setTimeout(() => this._prefetchIndices(), 200);
      }
    });
  },

  _saveTodayCache(data) {
    const indexCode = this.data.compareIndex || '000001';
    const today = calc.formatDate(new Date());
    const cache = { date: today, data, ts: Date.now() };
    this._todayCaches = this._todayCaches || {};
    this._todayCaches[indexCode] = cache;
    try { wx.setStorageSync(INTRADAY_CACHE_PREFIX + indexCode, cache); } catch (e) {}
  },

  _loadTodayCache(indexCode) {
    this._todayCaches = this._todayCaches || {};
    if (this._todayCaches[indexCode]) return null;
    try {
      const cached = wx.getStorageSync(INTRADAY_CACHE_PREFIX + indexCode);
      if (cached && cached.date === calc.formatDate(new Date()) && cached.data && cached.data.length > 0) {
        this._todayCaches[indexCode] = cached;
        return cached.data;
      }
    } catch (e) {}
    return null;
  },

  // 是否需要重新拉取指数分时：
  // 交易时段 → 数据在变，必须实时拉新。
  // 非交易时段 → 分时数据已定格，只要当天分时缓存（内存或 storage）已存在就无需重拉；
  //              缓存 miss 才拉一次补缓存，之后即可秒开。这样避免了非交易时段白等一次网络往返。
  _shouldRefetchIntraday() {
    if (this._isTradingNow()) return true;
    const code = this.data.compareIndex || '000001';
    this._todayCaches = this._todayCaches || {};
    const mem = this._todayCaches[code];
    if (mem && mem.data && mem.data.length) return !this._cacheCoversSession(mem.data);
    try {
      const cached = wx.getStorageSync(INTRADAY_CACHE_PREFIX + code);
      if (cached && cached.date === calc.formatDate(new Date()) && cached.data && cached.data.length) {
        return !this._cacheCoversSession(cached.data);
      }
    } catch (e) {}
    return true;
  },

  // 分时缓存是否覆盖到收盘。收盘后只有"完整到收盘"的缓存才算新鲜——
  // 原实现只看"有没有今日缓存"，于是盘中某刻存下的半截数据被当成终态：
  // 图表永久停在缓存时刻（2026-09-11 真机：曲线停在 14:15 / 14:23），切换指数也复用这份半截数据。
  _cacheCoversSession(data) {
    if (!data || !data.length) return false;
    const last = data[data.length - 1];
    return !!(last && last.time && last.time >= '14:55');
  },

  async fetchIntraday(indexCode, opts = {}) {
    if (this._fetchingToday) return false; // 已有请求在飞：明确告知调用方"这次没轮到"
    this._fetchingToday = true;
    const animate = !!opts.animate; // 切指数：数据到位后这一次绘制播进场动画；轮询：不播
    const code = indexCode || this.data.compareIndex;
    try {
      const ires = await api.fetchIndexIntradayTencent(code);
      if (ires && ires.code === 0 && ires.data && ires.data.length > 0) {
        this._intradayRaw = ires.data;
      }
      this._todayCaches = this._todayCaches || {};
      delete this._todayCaches[code];
      try { wx.removeStorageSync(INTRADAY_CACHE_PREFIX + code); } catch (e) {}
      if (animate) this._todayAnimated = false; // 这一次绘制播动画
      this._draw();
    } catch (e) {}
    this._fetchingToday = false;
    return true;
  },

  // ============ 日历 ============

  _cal() { try { const s = this._calCached(); if (s) this.setData({ availableMonths: s.months, selectedMonth: s.sm, availableYears: s.years, selectedYear: s.sy, dayCalendar: s.days, weekCalendar: s.weeks, monthCalendar: s.mons, yearData: s.yrs }); } catch (e) { console.warn('[profit-detail] 日历渲染异常:', e); } },
  _calCached() {
    const a = this._allDaily, c = this._dailyChange; if (!a || !c) return null;
    // 缓存：数据引用未变（同一次 fetch 的数据）时直接复用上次计算结果，避免切 Tab 全量重算
    if (this._calCache && this._calCache.ref === c) return this._calCache.result;
    const dm = this._calDm();
    const ms = [...new Set(Object.keys(dm).map(d => d.slice(0, 7)))].sort().reverse();
    const ys = [...new Set(Object.keys(dm).map(d => d.slice(0, 4)))].sort().reverse();
    const now = new Date(); const sm = ms[0] || calc.formatDate(now).slice(0, 7); const sy = ys[0] || String(now.getFullYear());
    const result = { months: ms, sm, years: ys, sy, days: this._days(c, sm, dm), weeks: this._weeks(c, sm, dm), mons: this._mons(c, sy, dm), yrs: this._yrs(c, dm) };
    this._calCache = { ref: c, result };
    return result;
  },

  _days(c, month, dm) { const [y, m] = month.split('-').map(Number); const fd = new Date(y, m - 1, 1).getDay(); const dim = new Date(y, m, 0).getDate(); const wks = []; let w = []; for (let i = 0; i < fd; i++) w.push({ day: '', empty: true }); const allKeys = (this._calDmCache && this._calDmCache.keys) || Object.keys(dm).sort(); for (let d = 1; d <= dim; d++) { const ds = `${month}-${String(d).padStart(2, '0')}`; const chg = c[ds]; const empty = chg === undefined; let prevMv = 0; for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= ds) { if (i > 0) prevMv = dm[allKeys[i - 1]]; break; } if (i === allKeys.length - 1) prevMv = dm[allKeys[i]]; } const rate = (prevMv > 0 && chg != null) ? +((chg / prevMv) * 100).toFixed(2) : 0; w.push({ day: d, date: ds, profit: empty ? null : chg, rate, empty }); if (w.length === 7) { wks.push(w); w = []; } } while (w.length > 0 && w.length < 7) w.push({ day: '', empty: true }); if (w.length === 7) wks.push(w); return wks; },
  _mons(c, year, dm) { const allKeys = (this._calDmCache && this._calDmCache.keys) || Object.keys(dm).sort(); return [1,2,3,4,5,6,7,8,9,10,11,12].map(m => { const pfx = `${year}-${String(m).padStart(2, '0')}`; let s = 0, h = false; for (const [d, chg] of Object.entries(c)) { if (d.startsWith(pfx)) { s += chg; h = true; } } const profit = +s.toFixed(2); const keys = allKeys.filter(k => k.startsWith(pfx)); const last = keys.length ? dm[keys[keys.length - 1]] : 0; let first = last; for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= pfx + '-01') { if (i > 0) first = dm[allKeys[i - 1]]; break; } } const rate = first > 0 ? +((last / first - 1) * 100).toFixed(2) : 0; return { month: m, date: pfx, profit, rate, empty: !h }; }); },
  _yrs(c, dm) { const allKeys = (this._calDmCache && this._calDmCache.keys) || Object.keys(dm).sort(); return [...new Set(Object.keys(c).map(d => d.slice(0, 4)))].sort().map(y => { let s = 0; for (const [d, chg] of Object.entries(c)) { if (d.startsWith(y)) s += chg; } const profit = +s.toFixed(2); const keys = allKeys.filter(k => k.startsWith(y)); const last = keys.length ? dm[keys[keys.length - 1]] : 0; let first = last; for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= y + '-01-01') { if (i > 0) first = dm[allKeys[i - 1]]; break; } } const rate = first > 0 ? +((last / first - 1) * 100).toFixed(2) : 0; return { date: y + '-12-31', profit, rate }; }); },

  // ============ 事件 ============

  onSummaryTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === 'today') this._todayAnimated = false; else this._histAnimated = false;
    this.setData({ activeTab: tab, signVisible: tab !== 'today' }, () => {
      this._draw();
      this._ensureReview(tab); // 切 tab 重建对应周期的复盘
    });
  },
  onCalendarTab(e) { this._cal(); this.setData({ calendarView: e.currentTarget.dataset.tab }); },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },
  onMonthChange(e) { const m = this.data.availableMonths[e.detail.value]; const c = this._calCached(); if (!c) return; this.setData({ selectedMonth: m, dayCalendar: this._days(this._dailyChange, m, this._calDm()), weekCalendar: this._weeks(this._dailyChange, m, this._calDm()) }); },
  onYearChange(e) { const y = this.data.availableYears[e.detail.value]; const c = this._calCached(); if (!c) return; this.setData({ selectedYear: y, monthCalendar: this._mons(this._dailyChange, y, this._calDm()) }); },
  // 周视图：选中月按自然周（周一开头）聚合。profit=周内每日盈亏相加；rate=周初（上周五收盘）→周末市值变化，与 _mons 口径一致
  _weeks(c, month, dm) {
    const allKeys = (this._calDmCache && this._calDmCache.keys) || Object.keys(dm).sort();
    const [y, m] = month.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    const segs = [];
    let ws = null, we = null, sum = 0, has = false;
    for (let d = 1; d <= dim; d++) {
      const ds = `${month}-${String(d).padStart(2, '0')}`;
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 1 || ws === null) {
        if (ws !== null) segs.push({ ws, we, sum, has });
        ws = ds; sum = 0; has = false;
      }
      we = ds;
      const chg = c[ds];
      if (chg !== undefined) { sum += chg; has = true; }
    }
    if (ws !== null) segs.push({ ws, we, sum, has });
    return segs.map(w => {
      let first = 0, last = 0;
      for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= w.ws) break; first = dm[allKeys[i]]; }
      for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] > w.we) break; last = dm[allKeys[i]]; }
      const rate = first > 0 ? +((last / first - 1) * 100).toFixed(2) : 0;
      return { ws: w.ws, range: `${+w.ws.slice(5, 7)}.${+w.ws.slice(8)}-${+w.we.slice(8)}`, profit: +w.sum.toFixed(2), rate, empty: !w.has };
    });
  },
  // 构建日期→市值映射（供 _days/_mons/_yrs 用），_allDaily 不变时缓存（含预排序 keys）
  // 返回 map（{ date: value }），keys 由 _days/_mons/_yrs 从 _calDmCache 读取
  _calDm() {
    if (this._calDmCache && this._calDmCache.ref === this._allDaily) return this._calDmCache.map;
    const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; });
    const sortedKeys = Object.keys(dm).sort();
    this._calDmCache = { ref: this._allDaily, map: dm, keys: sortedKeys };
    return dm;
  },
  onToggleMode() { this._cal(); this.setData({ profitMode: this.data.profitMode === 'amount' ? 'rate' : 'amount' }); },
  onSelectIndex(e) {
    const { code, name } = e.currentTarget.dataset;
    if (code === this.data.compareIndex) return;
    this._todayAnimated = false;
    this._histAnimated = false;
    this.setData({ compareIndex: code, compareLabel: name });
    if (this.data.activeTab === 'today') {
      // 优先用预取的分时：立即换线（不清 _intradayRaw，否则 _drawToday 判定"指数未就绪"会挂起 → 图表冻结数秒）
      const hit = (this._idxRawCache || {})[code];
      if (hit && hit.data && hit.data.length > 0) {
        this._intradayRaw = hit.data;
        this._fetchingToday = false;
        this._todayAnimated = false;
        this._draw();
        // 预取超过 1 分钟：等动画播完(1.2s)再后台补最新分钟，避免这次无动画重绘把动画盖掉
        if (Date.now() - hit.ts > 60000) setTimeout(() => this.fetchIntraday(code), 1500);
        return;
      }
      // 未命中预取：不要用旧指数数据重绘（那会把动画播在旧曲线上，随后新曲线"无动画"地突然出现），
      // 只给加载反馈，等数据到位后由 fetchIntraday 画这一次（带动画）
      this._fetchingToday = false;
      this.setData({ todayChartLoading: true });
      // 若有轮询请求正在飞，fetchIntraday 会直接返回 false（这次没轮到）→ 重试，
      // 否则新指数一直没数据、图表却显示着旧指数的曲线（开盘轮询最活跃，最容易撞上）
      const runFetch = (left) => {
        this.fetchIntraday(code, { animate: true }).then((did) => {
          if (did === false && left > 0) return setTimeout(() => runFetch(left - 1), 400);
          this.setData({ todayChartLoading: false });
        });
      };
      runFetch(5);
      return;
    }
    const data = this._idxMap ? this._idxMap[code] : null;
    if (!data || !data.length) { this._fetch(); return; }
    this._indexDaily = data;
    this._draw();
  },

  // 预取其它指数的当日分时：首次切换不必等请求（否则会"停顿几秒"再换线）。
  // 交易时段内预取超过 2 分钟视为过期，由 30 秒轮询逐只补新。
  async _prefetchIndices() {
    if (this._prefetching) return;
    this._prefetching = true;
    this._idxRawCache = this._idxRawCache || {};
    const cur = this.data.compareIndex || '000001';
    const list = (this.data.availableIndices || []).filter(i => i.code !== cur);
    for (const idx of list) {
      const hit = this._idxRawCache[idx.code];
      const stale = hit && this._isTradingNow() && Date.now() - hit.ts > 120000;
      if (hit && !stale) continue;
      try {
        const ires = await api.fetchIndexIntradayTencent(idx.code);
        if (ires && ires.code === 0 && ires.data && ires.data.length > 0) {
          this._idxRawCache[idx.code] = { data: ires.data, ts: Date.now() };
        }
      } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, 150)); // 略作错开，避免瞬时打满请求
    }
    this._prefetching = false;
  },

  onCanvasTouch(e) {
    const isToday = this.data.activeTab === 'today';

    if (isToday) {
      if (e.type === 'touchstart') {
        this._ctSY = e.touches[0].y; this._ctSX = e.touches[0].x;
        this._ctActive = false; this._ctTopCheck = e.touches[0].y < 100;
        return;
      }
      if (e.type === 'touchend') { this._ctActive = false; this._drawToday(); return; }
      if (!this._ctActive) {
        const dy = Math.abs(e.touches[0].y - this._ctSY), dx = Math.abs(e.touches[0].x - this._ctSX);
        if (this._ctTopCheck && e.touches[0].y > this._ctSY && dy > dx) return;
        if (dy > dx && dy > 8) return;
        if (dx > dy && dx > 8) this._ctActive = true;
      }
      if (!this._ctActive) return;
      const now = Date.now();
      if (this._ctT && now - this._ctT < 60) return;
      this._ctT = now;
      const query = wx.createSelectorQuery();
      query.select('#profitCanvas').fields({ node: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const dpr = wx.getWindowInfo().pixelRatio;
        // 不重建位图：setTransform 幂等重置变换（位图与页级快照 _intradaySnap 尺寸一致）
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        chartUtil._drawIntradayFast(ctx, this._intradaySnap);
        chartUtil.handleIntradayTouch(ctx, e, this._intradaySnap);
      });
      return;
    }

    const d = this._chartDraw;
    if (!d) return;

    if (e.type === 'touchstart') {
      this._ctSY = e.touches[0].y;
      this._ctSX = e.touches[0].x;
      this._ctActive = false;
      this._ctTopCheck = e.touches[0].y < 100; // 页面顶部区域，可能触发下拉刷新
      return;
    }
    if (e.type === 'touchend') {
      this._ctActive = false;
      this._draw();
      return;
    }
    if (!this._ctActive) {
      const dy = Math.abs(e.touches[0].y - this._ctSY);
      const dx = Math.abs(e.touches[0].x - this._ctSX);
      // 页面顶部纵向滑动 → 穿透给下拉刷新
      if (this._ctTopCheck && e.touches[0].y > this._ctSY && dy > dx) return;
      if (dy > dx && dy > 8) return;
      if (dx > dy && dx > 8) this._ctActive = true;
    }
    if (!this._ctActive) return;

    const now = Date.now();
    if (this._ctT && now - this._ctT < 60) return;
    this._ctT = now;

    const query = wx.createSelectorQuery();
    query.select('#profitCanvas').fields({ node: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getWindowInfo().pixelRatio;
      // 不重建位图：位图与 _chartDraw 快照尺寸一致，setTransform 幂等重置
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this._touchHistory(ctx, d, e.touches[0].x);
    });
  },

  _touchHistory(ctx, d, px) {
    chartUtil.cancelChartAnim(); // 触摸打断进场动画，避免十字线被动画帧刷白
    const { data, p, cw, ch, pw, ph, y0, y1, xi, yi, noIdx, hasP, compareLabel } = d;
    ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch);
    this._drawGrid(ctx, p, cw, ch, y0, y1, yi);

    let nearest = 0, minDist = Infinity;
    data.forEach((pt, i) => { const dist = Math.abs(xi(i) - px); if (dist < minDist) { minDist = dist; nearest = i; } });
    const pt = data[nearest], cx = xi(nearest);
    const tv = !noIdx && pt.indexRate != null ? pt.indexRate : pt.baseRate;
    const fmt = v => v != null ? (v > 0 ? '+' : '') + v + '%' : '--';

    if (noIdx) {
      const pc2 = pt.baseRate >= (data[0].baseRate || 0) ? '#E4393C' : '#2E8B57';
      this._fillArea(ctx, data, 'baseRate', xi, yi, pc2);
      this._line(ctx, data, 'baseRate', xi, yi, pc2);
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = pc2; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText('我的收益 ' + fmt(pt.baseRate), p.l + 20, 12);
    } else if (hasP) {
      const pc2 = pt.baseRate >= (data[0].baseRate || 0) ? '#E4393C' : '#2E8B57';
      this._fillArea(ctx, data, 'baseRate', xi, yi, pc2);
      this._fillArea(ctx, data, 'indexRate', xi, yi, '#1976D2');
      this._line(ctx, data, 'baseRate', xi, yi, pc2);
      this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = pc2; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText('我的收益 ' + fmt(pt.baseRate), p.l + 20, 12);
      ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 22, 12, 4);
      ctx.fillStyle = '#666'; ctx.fillText(compareLabel + ' ' + fmt(pt.indexRate), p.l + 20, 24);
    } else {
      this._fillArea(ctx, data, 'indexRate', xi, yi, '#1976D2');
      this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText(compareLabel + ' ' + fmt(pt.indexRate), p.l + 20, 12);
    }
    ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) { const v = y1 - (y1 - y0) / 4 * i; ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v)); }
    ctx.textBaseline = 'top'; ctx.font = '11px sans-serif';
    const last = data.length - 1;
    const positions = [0, Math.floor(last / 2), last];
    const aligns = ['left', 'center', 'right'];
    positions.forEach((ix, i) => {
      ctx.textAlign = aligns[i];
      const x = i === 2 ? xi(ix) - 4 : i === 0 ? xi(ix) + 4 : xi(ix);
      ctx.fillText(data[ix].date.slice(5), x, ch - p.b + 8);
    });
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, p.t); ctx.lineTo(cx, ch - p.b); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, yi(tv), 4, 0, 2 * Math.PI); ctx.fillStyle = '#FFF'; ctx.fill();
    ctx.strokeStyle = '#1976D2'; ctx.lineWidth = 1; ctx.stroke();

    // 回撤曲线（按住时也保留）
    const ddPts = data.filter(d => d.drawdown != null);
    if (ddPts.length >= 2) {
      const firstDd = ddPts[0], lastDd = ddPts[ddPts.length - 1];
      const firstIdx = data.indexOf(firstDd), lastIdx = data.indexOf(lastDd);
      ctx.beginPath();
      ctx.moveTo(xi(firstIdx), yi(0));
      ddPts.forEach((d, i) => { ctx.lineTo(xi(data.indexOf(d)), yi(d.drawdown)); });
      ctx.lineTo(xi(lastIdx), yi(0));
      ctx.closePath();
      const ddGrad = ctx.createLinearGradient(0, yi(0), 0, yi(Math.min(...ddPts.map(d => d.drawdown))));
      ddGrad.addColorStop(0, 'rgba(255,152,0,0.06)');
      ddGrad.addColorStop(1, 'rgba(255,152,0,0.12)');
      ctx.fillStyle = ddGrad; ctx.fill();
      ctx.beginPath();
      ddPts.forEach((d, i) => { const x = xi(data.indexOf(d)), y = yi(d.drawdown); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.strokeStyle = 'rgba(255,152,0,0.6)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      const ddVal = pt.drawdown != null ? Math.abs(pt.drawdown) : 0;
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,152,0,0.6)'; ctx.fillRect(p.l + 4, hasP && !noIdx ? 34 : 22, 12, 4);
      ctx.fillStyle = '#999'; ctx.textAlign = 'left'; ctx.fillText('回撤 ' + ddVal.toFixed(1) + '%', p.l + 20, hasP && !noIdx ? 36 : 24);
    }
  },

  // ============ 收益轮询 ============

  _isTradingNow() {
    // 固定北京时间（UTC+8）判断，避免设备时区偏差导致误判
    const bj = new Date(Date.now() + 8 * 3600000);
    const totalMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();

    // 今天是否交易日：优先用数据驱动标志（_fetch 算出，能准确识别临时休市），
    // 尚未算出时用交易日历兜底（含节假日表；表外年份退化为工作日）
    if (this._isTodayTrading != null) {
      if (!this._isTodayTrading) return false;
    } else if (!marketTime.isTradingDay(bj.toISOString().slice(0, 10))) {
      return false;
    }

    const afterOpen = totalMin >= 570;        // 9:30
    const beforeClose = totalMin <= 900;      // 15:00
    const isLunch = totalMin > 690 && totalMin < 780; // 11:31-12:59 午休
    return afterOpen && beforeClose && !isLunch;
  },

  _startPolling() {
    this._stopPolling();
    this._pollFundRate();
    this._pollTimer = setInterval(() => this._pollFundRate(), 30000);
  },

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  async _pollFundRate() {
    if (!this._isTradingNow()) { this._stopPolling(); return; }
    if (this._pollingNow) return;
    // 动画进行中只跳过"重绘/拉分时"（否则后台重绘会把动画盖掉），数据更新照常做
    const animating = chartUtil.isAnimating && chartUtil.isAnimating();
    this._pollingNow = true;
    try {
      const res = await api.portfolioLight();
      if (!res.result || res.result.code !== 0) return;
      const d = res.result.data;
      // 非交易时段（含客户端交易日表与服务端不一致的情形）服务端返回占位值，
      // 直接应用会把冻结的当天收益洗成 0，并顺着"含当天"的周/月/年一起算错
      if (d.inTrading === false || d.todayProfitRate == null) return;
      const rate = parseFloat(d.todayProfitRate || 0);
      // 今日收益 = 当前市值 - 昨日市值（_totalMarket 在 _fetch 时保存）
      // _fetch 未完成时市值基准未就绪，跳过本轮——否则金额被算成 0.00 而收益率有值（开盘瞬间进页面的错位显示）
      if (!(this._totalMarket > 0)) return;
      const totalMarket = this._totalMarket || 0;
      const yesterdayMarket = totalMarket > 0 ? totalMarket / (1 + rate / 100) : 0;
      const tp = (yesterdayMarket * rate / 100).toFixed(2);
      const changed = this.data.todayProfitRate !== rate || this.data.todayProfit !== tp;
      if (changed) {
        this.setData({
          todayProfitRate: rate, todayProfit: tp,
          // 周/月/年含当天：当天值一变就得重算（否则"本周金额 == 当天金额"盘中会散架）
          ...this._periodSummary(rate, tp),
        });
        if (this.data.activeTab === 'today' && !animating) this._draw();
      }
      const snaps = d.intradaySnapshots;
      if (snaps && snaps.length > (this._profitSnapshots || []).length) {
        this._profitSnapshots = snaps.slice().sort((a, b) => a.time.localeCompare(b.time));
        this._todayCaches = {};
        try { wx.removeStorageSync(INTRADAY_CACHE_PREFIX + (this.data.compareIndex || '000001')); } catch (e) {}
      }
      this._updateAsOf();
      if (this.data.activeTab === 'today' && !animating) {
        this.fetchIntraday();
        this._prefetchIndices(); // 顺带补新过期的指数预取（内部有节流与过期判断）
      }
    } catch (e) {}
    this._pollingNow = false;
  },

  _mon(d) { const c = new Date(d); c.setDate(c.getDate() - (c.getDay() === 0 ? 6 : c.getDay() - 1)); return calc.formatDate(c); },
  // 指数历史缓存：日频 K 线不付分钟级网络成本（盘中 5 分钟 TTL，收盘定格后冻结免拉）
  async _idx(code, days) {
    try {
      const all = wx.getStorageSync(IDX_HIST_CACHE) || {};
      const c = all[code];
      if (c && c.rows && c.rows.length >= days * 0.85 &&
          marketTime.isCacheFresh(c, { estimateTtl: 300000, finalAtClose: true })) {
        return c.rows;
      }
    } catch (e) { /* ignore */ }
    const tryAll = async () => {
      const results = await Promise.allSettled([
        api.fetchMarketIndex(code, days),
        api.fetchMarketIndexClient(code, days),
      ]);
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v && v.result && v.result.code === 0 && v.result.data && v.result.data.length > 0) {
            return v.result.data.map(d => ({ date: d.date, close: d.close }));
          }
          if (v && v.code === 0 && v.data && v.data.length > 0) {
            return v.data.map(d => ({ date: d.date, close: d.close }));
          }
        }
      }
      return null;
    };
    // 拉取失败不立即原样重试（大概率同样失败还双倍等待）：本轮直接放弃，
    // 下一轮 30s 轮询/onShow 自然重试
    const rows = (await tryAll()) || [];
    if (rows.length) {
      try {
        const all = wx.getStorageSync(IDX_HIST_CACHE) || {};
        all[code] = { rows, ts: Date.now() };
        wx.setStorageSync(IDX_HIST_CACHE, all);
      } catch (e) { /* ignore */ }
    }
    return rows;
  },
});
