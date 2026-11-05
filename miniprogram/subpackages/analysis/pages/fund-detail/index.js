const api = require("../../../../utils/api");
const calc = require("../../../../utils/calculator");
const chart = require("../../../../utils/chart");
const marketTime = require("../../../../utils/market-time");
const subscribe = require("../../../../utils/subscribe");
const recent = require("../../../../utils/recent");
const track = require("../../../../utils/track");

const CACHE_PREFIX = "fund_detail_cache_";
// 持仓/档案（含调仓动向）缓存的数据版本号。后端修正了调仓动向计算（占比列定位/季度选择）后 +1，
// 旧版本缓存自动作废 → 重新进入页面即拉到新值，避免用户一直看到修复前的错误调仓动向。
// 3：修正同类排名的持久化标记（旧代码把"没拉过"写成"拉过了"，排名卡一消失就再也回不来）
// v4（2026-11-05）：调仓对比口径修正（半年报全量 78/50 行当上期 → 按 rank 截前十），
// 旧缓存里的 changeType/比率差是错口径算的（前十股票被标成"加仓"），必须作废重拉
// v5（2026-11-05）：去掉 ±0.5pp 阈值（变动按方向全标），旧缓存的 hold 需按新口径重算
const HOLDINGS_CACHE_VERSION = 5;

Page({
  data: {
    fundCode: "", fundName: "", loading: true, errorMsg: "", loadError: false,
    nav: null, estimatedNav: null, estimatedChangeRate: null, estimateTime: "", estSource: "",
    // 涨跌幅文本（两位小数，WXML 不能用方法格式化）；由 updateDisplay 统一重算
    estimatedChangeRateText: "--", displayChangeRateText: "--",
    actualNav: "", actualDate: "", actualChangeRate: null,
    navHistory: [], displayHistory: [], displayCount: 5,
    todayReturn: null, weekReturn: null, monthReturn: null,
    threeMonthReturn: null, sixMonthReturn: null, yearReturn: null, threeYearReturn: null,
    profile: null, manager: null, holdings: [], quarterLabel: "", prevDataIncomplete: false,
    hasHolding: false, holdingId: null, holdingData: null, holdingRecords: [], followed: false, activeTab: "trend",
    chartLoading: false, // 切区间需补拉历史时图表区给加载反馈（否则数秒无反馈会被当成没反应）
    // 数据校准（修正份额/成本记录误差，无交易语义）
    showCalibrate: false, calShares: "", calPrice: "", calSaving: false,
    isTrading: false,
    priceLoading: false, // 首开时净值/估值还没到：显示"加载中…"而不是"-- + 未出估值"
    showEstimate: false, // 盘中且今日净值未公布：头部走估算口径（由 updateDisplay 计算）
    chartPeriod: '1M',
    chartTxMap: {},
    transactionList: [],
    noteTimeline: [],
    showTransactions: false,
    scrollToTx: "",
    quarterNet: 0,
    profileLoading: false, profileLoaded: false,
    // 定投回测
    showDCA: false, dcaAmount: '', dcaStartDate: '', dcaLoading: false, dcaResult: null,
    // 风险指标 + 费用 + 估值温度
    riskMetrics: null, showFee: false, feeData: null, totalFeeRate: '', peTemp: null,
    marketInd: null, // 市场级指标（债市温度/股债性价比），云函数随估值透传
    isBondFund: false, // 债券/货币基金：无个股估值口径，温度卡展示债市温度
    estimateAccuracy: null, estimateAccuracyText: '',
    accLog: [], accLogVisible: false, // R2 误差行点击展开的 30 天对账明细
    rebate: null,
    turnoverRates: [],
    sameTypeRank: null,
    // 同类排名是否已"确认"（含该基金确实无排名）：false 表示这次没拿到（超时/解析失败/老缓存缺字段），
    // 切档案 tab 时补拉一次。只由真正拿到响应的那次 fetchProfile 置位，绝不能在通用保存路径里硬编码
    rankFetched: false,
    showTurnover: false,
    scrollRefreshing: false,
    drift: null, driftExpanded: false,
    amountVisible: true, // 详情页金额不做隐藏（2026-09-26 用户拍板：隐藏开关只管首页列表）
  },

  onLoad(options) {

    if (!options.fundCode) {
      // 缺参（分享链接被截断等）：置错误态，避免页面永远停在"加载中"
      this.setData({ loading: false, loadError: true });
      return;
    }
    const fundName = options.fundName ? decodeURIComponent(options.fundName) : "基金详情";
    // 深链只带 fundCode（推送/分享落地页）时用占位，真实名字由 _backfillName 回填
    this._namePlaceholder = !options.fundName;
    this.setData({ fundCode: options.fundCode, fundName, isBondFund: this._bondFlag(fundName) });
    // 持仓态预填（防头部闪跳）：checkHolding 比概览晚到一拍，首帧会先渲染"单位净值"卡、
    // 约一秒后跳成"当日收益"卡。首页的 portfolio_cache 是同步本地存储、逐笔带 getPortfolio
    // 预计算字段——命中即按它预置持仓态（合计口径：金额逐笔相加、成本=市值−累计收益），
    // checkHolding/enrichHoldingData 回来后无缝覆盖。缓存超过 3 天不预填（防闪现陈旧数值）
    try {
      const pc = wx.getStorageSync("portfolio_cache") || {};
      const mine = (pc.holdings || []).filter((h) => h && h.fundCode === options.fundCode);
      const num = (v) => parseFloat(v) || 0;
      if (mine.length > 0 && pc.ts && Date.now() - pc.ts < 3 * 86400000) {
        // 当日收益只在缓存属于今天时预填：隔日缓存的 todayProfit 是那一天的口径，
        // 当"今日收益"展示是错语义（份额/成本/累计收益不受影响）
        const pcIsToday = marketTime.bjDateStr() === calc.formatDate(new Date(pc.ts));
        const shares = mine.reduce((s, h) => s + num(h.shares), 0);
        const marketValue = mine.reduce((s, h) => s + num(h.marketValue), 0);
        const totalReturn = mine.reduce((s, h) => s + num(h.totalReturn), 0);
        const todayProfit = mine.reduce((s, h) => s + num(h.todayProfit), 0);
        const cost = marketValue - totalReturn;
        const buyPrice = shares > 0 && cost > 0 ? cost / shares : num(mine[0].buyPrice);
        this._rawHoldings = mine;
        this._rawHolding = { ...mine[0], shares, buyPrice, marketValue, holdingReturn: totalReturn };
        this.setData({
          hasHolding: true,
          holdingId: mine[0]._id,
          holdingRecords: mine.map((r) => ({
            id: r._id,
            platform: r.platform || "未分配",
            group: r.group || "",
            shares: (num(r.shares) || num(r.amount) || 0).toFixed(2),
            marketValue: num(r.marketValue).toFixed(2),
            buyPrice: (num(r.buyPrice) || num(r.nav) || 0).toFixed(4),
            holdingReturn: num(r.holdingReturn).toFixed(2),
          })),
          holdingData: {
            shares: shares.toFixed(2),
            buyPrice: buyPrice.toFixed(4),
            marketValue: marketValue.toFixed(2),
            todayProfit: pcIsToday ? todayProfit.toFixed(2) : "",
            totalReturn: totalReturn.toFixed(2),
            totalReturnRate: cost > 0 ? ((totalReturn / cost) * 100).toFixed(2) : "0.00",
          },
        });
      }
    } catch (e) { /* ignore */ }
    // 导航栏标题用"基金名(代码)"：微信搜一搜按页面标题收录，基金名+代码是搜索主词
    // R5 来源归因：页面级 scene（搜一搜来的用户在详情页做了什么）
    try {
      track.track("page_enter", {
        page: "fund_detail",
        scene: (options && options.scene) || (wx.getLaunchOptionsSync() || {}).scene || 0,
        fundCode: options.fundCode,
      });
    } catch (e) { /* ignore */ }
    // R6 最近查看：进详情即记入（首页空态「最近查看」的数据源）
    recent.addFund(options.fundCode, fundName);
    wx.setNavigationBarTitle({ title: `${fundName}(${options.fundCode}) 估值` });
    this._firstLoad = true;
    this._t0 = Date.now(); // 详情页首开耗时埋点起点（perf_detail）
    const { windowWidth } = wx.getWindowInfo();
    const canvasW = windowWidth - 24;
    const canvasH = Math.round(canvasW * 0.53);
    this._canvasW = canvasW;
    this._canvasH = canvasH;
    this.setData({ canvasW, canvasH, canvasHRpx: Math.round(canvasH * 750 / windowWidth) });
    // 加减仓等操作后强制刷新，跳过缓存
    if (wx.getStorageSync("portfolio_force_refresh")) {
      wx.removeStorageSync("portfolio_force_refresh");
      this._skipCache = true;
    }
    // 缓存新鲜度走交易日时钟（盘中短 TTL、收盘净值发布即冻结、周末/节假日全天免拉）
    const cached = wx.getStorageSync(CACHE_PREFIX + options.fundCode);
    const cacheFresh = cached && cached.history && cached.history.length && marketTime.isCacheFresh(cached);
    // 温度按天轮换：温度任务每天凌晨更新 fund_temperatures，缓存里隔天的温度视为过期，
    // 否则周末冻结期间详情页会一直停留在旧温度，与每天实时拉取的列表页不一致
    const tempStale = !cached || cached.tempDate !== marketTime.bjDateStr();
    // 缓存缺失/过期时自动调起下拉刷新动画，让用户感知数据更新（onReady 后再调起）
    this._pendingAutoRefresh = !this._skipCache && (!cacheFresh || tempStale);
    // 立即加载（缓存秒开 + 过期则拉新），不依赖下拉动画链路，避免页面卡加载
    this.fetchAll();
  },

  // 深链缺名进入（推送/分享落地页）：接口带回真实基金名后回填头部与导航栏标题。
  // onLoad 的「基金详情」占位是真值，不摘掉会永远挡住 fundName: this.data.fundName || d.fundName 的回填
  _backfillName(name) {
    if (!this._namePlaceholder || !name || name === this.data.fundName) return;
    this._namePlaceholder = false;
    this.setData({ fundName: name, isBondFund: this._bondFlag(name) });
    wx.setNavigationBarTitle({ title: `${name}(${this.data.fundCode}) 估值` });
  },

  // 债券/货币基金判断：与 getPortfolio 温度列同一名称正则（两处必须同式，口径才不打架）
  _bondFlag(name) {
    return /债|债券|纯债|转债|货币|货基/.test(name || "");
  },

  // marketInd 派生字段：盈利收益率 = 100/PE（WXML 不支持方法调用，js 预格式化）
  _miDecorate(mi) {
    if (!mi) return null;
    if (mi.earningsYield == null && mi.csi300PE) mi.earningsYield = +(100 / mi.csi300PE).toFixed(2);
    return mi;
  },

  // 首次渲染完成后自动调起 scroll-view 下拉刷新动画（过早调起 refresher 未挂载，无效）
  onReady() {
    if (this._pendingAutoRefresh) {
      this._pendingAutoRefresh = false;
      // 走 onScrollRefresh 同一条链路：含 _fetchingAll 防重入与刷新动画收起
      setTimeout(() => this.onScrollRefresh(), 500);
    }
  },

  onShow() {
    // perf 计时补偿：把 onHide→onShow 的后台时长从 _t0 里剔除。此前 6% 的 perf_detail
    // 样本被切后台/锁屏污染（最慢 73 分钟），分布全是噪声
    if (this._t0 && this._hiddenAt) { this._t0 += Date.now() - this._hiddenAt; this._hiddenAt = 0; }
    // 每次显示同步主题色（返回/切换时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    // 金额隐藏开关也同步（首页切换后返回本页立即生效）

    // 60s 轻量定时器重算 isTrading：停留页面跨过 15:00 收盘点时，
    // 估值卡片能自动切回净值卡片（isTrading 只在 onShow 算会卡在"交易中"展示）
    this._startTradingTimer();
    if (this._firstLoad) { this._firstLoad = false; return; }
    const { fundCode } = this.data;
    if (!fundCode) return;
    const forceRefresh = wx.getStorageSync("portfolio_force_refresh");
    if (forceRefresh) {
      wx.removeStorageSync("portfolio_force_refresh");
      this._lastRefresh = 0;
    }
    const now = Date.now();
    // 30s 内不重复拉取非估值数据，仅刷新估值（但仍查 DB 确保持仓最新）
    if (this._lastRefresh && now - this._lastRefresh < 30000) {
      Promise.all([this.fetchEstimate(), this.checkHolding()]).then(() => {
        this.updateDisplay();
        this.enrichHoldingData();
      });
      return;
    }
    this._lastRefresh = now;
    this.refreshData();
  },

  onHide() {
    this._stopTradingTimer();
    // perf 计时：切后台起点（后台时长不计入首开耗时，见 onShow 补偿）
    if (this._t0) this._hiddenAt = Date.now();
  },

  onUnload() { this._stopTradingTimer(); },

  // isTrading 相关 data 的定时重算（updateDisplay 同时刷新涨跌口径与净值更新标记）
  _startTradingTimer() {
    if (this.data.loadError) return; // 缺参错误态无需定时重算
    this._stopTradingTimer();
    this._tradingTimer = setInterval(() => this.updateDisplay(), 60000);
  },
  _stopTradingTimer() {
    if (this._tradingTimer) { clearInterval(this._tradingTimer); this._tradingTimer = null; }
  },

  // 分享
  onShareAppMessage() {
    // path 带 fundName：落地页首帧直接渲染标题（原来只带 fundCode，要等 _backfillName 二次回填）
    return {
      title: (this.data.fundName || "基金") + "的估值与温度",
      path: "/subpackages/analysis/pages/fund-detail/index?fundCode=" + this.data.fundCode +
        (this.data.fundName ? "&fundName=" + encodeURIComponent(this.data.fundName) : ""),
    };
  },

  async refreshData() {
    try {
      await Promise.all([
        this.fetchEstimate(),
        this.checkHolding(),
        this.checkFollow(),
        this.fetchTransactions(),
      ]);
      this.updateDisplay();
      this.enrichHoldingData();
    } catch (e) { /* ignore */ }
  },

  async fetchAll() {
    if (this._fetchingAll) return; // 防重入：onLoad 与下拉动画可能并发触发
    this._fetchingAll = true;
    this.setData({ loading: true, errorMsg: "" });
    this._lastRefresh = Date.now();
    try {
      // 缓存优先：命中即先渲染；缓存新鲜则跳过重请求，仅做轻量校验
      const cached = this._readCache();
      const firstOpen = !(cached && cached.history && cached.history.length);
      if (firstOpen) this.setData({ priceLoading: true });
      const fresh = this._skipCache ? false : this._restoreCache();
      this._skipCache = false;
      if (!fresh) {
        if (cached && cached.history && cached.history.length) {
          // 已有缓存历史 → 轻量刷新：只拉估值接口（含最新净值/涨跌/温度），
          // 用最新一天净值合并进缓存历史；不重拉 260 天历史、不拉档案/持仓（季度级静态）
          const [estRes] = await Promise.all([
            api.fetchFundEstimate(this.data.fundCode).catch(() => null),
            this.checkFollow().catch(() => {}),
            this.checkHolding().catch(() => {}),
            this.fetchTransactions().catch(() => {}),
          ]);
          if (estRes && estRes.result && estRes.result.code === 0) {
            this._applyEstimate(estRes.result.data, cached);
          }
        } else {
          // 首次无缓存历史 → 全量概览（一次拿 260 天历史 + 估值 + 温度；档案/持仓由切 Tab 懒加载）
          // 概览很重（260 天历史），先并行打一发轻量估值：头部卡的净值/涨跌/温度先出数，
          // 历史与图表随后到（2026-10-22 反馈：第一次打开详情页慢，且期间显示"--/未出估值"）
          api.fetchFundEstimate(this.data.fundCode).then((r) => {
            // 传 { history: [] } 而不是 {}：_applyEstimate 里会读 cached.history[0] 判缓存断档
            if (r && r.result && r.result.code === 0) {
              this._applyEstimate(r.result.data, cached || { history: [] });
              // 头部卡出数耗时（首开全量路径）：判断"慢"到底慢在估值还是历史
              track.track("perf_detail", { stage: "est", ms: Date.now() - this._t0, firstOpen: 1 });
              // 估值已到就先撤整页遮罩：overview 均值 4.9s 才回，原实现 loading 压到 fetchAll
              // 末尾才释放，先出的头部数据被"加载中"挡住（首开感知 3.2s → 1.7s 量级）
              this.setData({ loading: false });
              // 撤遮罩同时刷新涨跌文案（WXML 绑定的是 estimatedChangeRateText 等派生字段，
              // _applyEstimate 只写了数值——不补这一步头部涨跌会停 "--" 到 overview 回来）
              this.updateDisplay();
            } else {
              track.track("perf_detail", { stage: "est_fail", ms: Date.now() - this._t0, firstOpen: 1 });
            }
          }).catch(() => { track.track("perf_detail", { stage: "est_err", ms: Date.now() - this._t0, firstOpen: 1 }); });
          const [overviewRes] = await Promise.all([
            // 概览失败只丢"历史+图表"，不影响已经拿到的估值/风险指标；不让它把整页打成错误态
            api.fetchFundOverview(this.data.fundCode).catch((e) => {
              track.track("perf_detail", { stage: "overview_err", ms: Date.now() - this._t0, msg: String((e && e.message) || e).slice(0, 80) });
              return null;
            }),
            this.checkFollow().catch(() => {}),
            this.checkHolding().catch(() => {}),
            this.fetchTransactions().catch(() => {}),
          ]);
          const overviewOk = !!(overviewRes && overviewRes.result && overviewRes.result.code === 0);
          track.track("perf_detail", {
            stage: "overview", ms: Date.now() - this._t0,
            ok: overviewOk ? 1 : 0,
          });
          // 失败只标记状态，由 WXML 决定形态：有数据→轻提示；没数据→整页错误+重试
          if (!overviewOk) this.setData({ errorMsg: "刷新失败" });
          if (overviewRes && overviewRes.result && overviewRes.result.code === 0) {
            const d = overviewRes.result.data;
            const actualCR = d.actualChangeRate != null ? d.actualChangeRate : this.data.actualChangeRate;
            const yesterdayNav = d.nav != null ? d.nav : this.data.nav;
            const actNavRaw = d.actualNav != null ? d.actualNav : parseFloat(this.data.actualNav);
            const displayCR = calc.selectChangeRate(yesterdayNav, actNavRaw, d.estimatedChangeRate, actualCR);
            this.setData({
              nav: d.nav, estimatedNav: d.estimatedNav,
              estimatedChangeRate: d.estimatedChangeRate, estimateTime: d.estimateTime, estSource: d.source || "",
              fundName: this.data.fundName || d.fundName || "",
              actualNav: d.actualNav ? d.actualNav.toFixed(4) : this.data.actualNav,
              actualChangeRate: actualCR,
              displayChangeRate: displayCR,
              peTemp: d.peTemp || this.data.peTemp,
          marketInd: this._miDecorate(d.marketInd) || this.data.marketInd,
          isBondFund: this._bondFlag(this.data.fundName || d.fundName),
              ...this._accuracyFields(d), ...this._rebateField(),
            });
            this._backfillName(d.fundName);
            if (d.history && d.history.length > 0) {
              this.setData({
                navHistory: d.history,
                displayHistory: d.history.slice(0, 5),
                displayCount: 5,
                actualNav: this.data.actualNav || (d.history[0].nav != null ? d.history[0].nav.toFixed(4) : ""),
                actualDate: d.history[0].date,
                actualChangeRate: this.data.actualChangeRate != null ? this.data.actualChangeRate : (d.history[0].changeRate || 0),
              });
              this.calcReturns(d.history);
            }
            // 缓存保存移到 fetchAll 末尾（需等 enrichHoldingData 设置持仓数据后）
          }
          // profile 在切 Tab 时懒加载，但基础数据已就绪
        }
      } else {
        // 缓存新鲜也静默轻量刷新估值：服务端口径修正/净值发布即时覆盖缓存旧值，防陈旧口径驻留
        const [estRes] = await Promise.all([
          api.fetchFundEstimate(this.data.fundCode).catch(() => null),
          this.checkFollow().catch(() => {}),
          this.checkHolding().catch(() => {}),
          this.fetchTransactions().catch(() => {}),
        ]);
        if (estRes && estRes.result && estRes.result.code === 0) {
          this._applyEstimate(estRes.result.data, cached);
        }
      }
      this.updateDisplay();
      this.enrichHoldingData();
      this._saveCache();
      // 后台预取档案/持仓：原本是"用户点持仓 tab 才发请求"（懒加载），
      // 第一次切过去必然干等一个云函数往返（冷启动时 0.4~1.5s）。
      // 这里在首屏数据就绪后静默拉一次，用户点开时数据已在内存里 → 秒开。
      if (!this.data.profile) this.fetchProfile().catch(() => {});
      // 首屏数据全部就绪的总耗时：按 首开/有缓存 分开统计，线上取分位数看真实分布
      track.track("perf_detail", {
        stage: "total",
        ms: Date.now() - this._t0,
        firstOpen: firstOpen ? 1 : 0,
        hasCache: cached && cached.history && cached.history.length ? 1 : 0,
      });
      if (this.data.loading) {
        this.setData({ loading: false, priceLoading: false }, () => this.drawChart());
      } else if (Date.now() >= (this._animUntil || 0)) {
        // 动画窗口内不重绘（见 _animUntil）；窗口过后照常静态重绘
        this.drawChart();
      }
    } catch (e) {
      console.error("[fund-detail] fetchAll 失败:", e);
      try {
        track.track("perf_detail", { stage: "fail", ms: Date.now() - this._t0, msg: String((e && e.message) || e).slice(0, 80) });
      } catch (te) { /* 埋点自身异常不能拖垮错误兜底 */ }
      this.setData({ loading: false, priceLoading: false, errorMsg: "刷新失败" });
    }
    this._fetchingAll = false;
  },

  // ============ 缓存 ============

  // 回本进度（陪伴线 B3）：只在"现值低于买入成本"时给，且只陈述事实（还差多少、净值要从 A 到 B）。
  // ⚠️ 现值必须与卡片同源 —— 直接用页面统一的 `calc.selectNav`（卡片算持有金额/累计收益用的就是它），
  //    不要自己写分支：`nav` 是涨跌基准（前一日净值），把它当现值会把亏损持仓判成已回本
  //    （001717 就这么漏过：基准 3.445 > 成本 3.428 被判盈利，而最新已公布净值 3.29 是亏的）。
  //    不做摊薄/加仓推演（那是另一件事）
  _rebateField(hdOverride) {
    const hd = hdOverride || this.data.holdingData;
    const cost = hd ? parseFloat(hd.buyPrice) : NaN;
    const now = calc.selectNav(this.data.nav, this.data.actualNav, this.data.estimatedNav);
    if (!(cost > 0) || !(now > 0) || now >= cost) return { rebate: null };
    return {
      rebate: {
        pct: Math.max(0, Math.min(100, Math.round((now / cost) * 100))),
        gap: (((cost / now) - 1) * 100).toFixed(1),
        cost: cost.toFixed(4),
        now: now.toFixed(4),
      },
    };
  },

  // 估算误差徽章（信任线：自曝误差）—— 文案在这里算好（WXML 不能调方法）。
  // 样本少也照实显示样本数（藏样本数就成了自欺）；还没有样本（台账刚起步）返回空文案不显示
  _accuracyFields(resp) {
    const acc = resp && resp.estimateAccuracy !== undefined ? resp.estimateAccuracy : this.data.estimateAccuracy;
    if (!acc || (!acc.samples && !(acc.self && acc.self.samples))) {
      return { estimateAccuracy: acc || null, estimateAccuracyText: "", accSelfText: "", accLog: [] };
    }
    const fmt = (v) => {
      const n = +v;
      if (!isFinite(n)) return "--";
      return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
    };
    // 两源各一行汇总（2026-11-05 按用户要求拆分；老数据只有源一，源二自 11-05 起积累）
    const sina = acc.sina || (acc.samples ? { samples: acc.samples, meanAbsDiff: acc.meanAbsDiff, hitRate: acc.hitRate } : null);
    const self = acc.self || null;
    const lineOf = (label, s) => {
      if (!s || !s.samples) return "";
      const tail = s.hitRate != null ? ` · 方向命中 ${s.hitRate}%` : "";
      return `${label} · 近 ${acc.days || 30} 天误差 ±${s.meanAbsDiff}pp${tail}（${s.samples} 个样本）`;
    };
    const accLog = (Array.isArray(acc.log) ? acc.log : []).map((r) => ({
      date: (r.date || "").slice(5),
      actText: fmt(r.actualRate),
      d1Text: fmt(r.diff).replace("%", "pp"),
      d1Cls: r.diff > 0 ? "down" : r.diff < 0 ? "up" : "",
      d2Text: fmt(r.diffSelf).replace("%", "pp"),
      d2Cls: r.diffSelf > 0 ? "down" : r.diffSelf < 0 ? "up" : "",
      hasSelf: r.diffSelf != null && isFinite(+r.diffSelf),
    }));
    // 超过 9 行（约 405rpx）就固定高度改为内部滚动：30 天明细直接铺满正文会把
    // 下面的风险指标/定投整块顶走，用户要划很久才能回去（2026-10-22）
    const accLogStyle = accLog.length > 9 ? "height:405rpx" : "";
    return {
      estimateAccuracy: acc,
      estimateAccuracyText: lineOf("数据源一", sina),
      accSelfText: lineOf("数据源二", self),
      accHasSelf: !!(self && self.samples),
      accLog, accLogStyle, accLogCapped: accLog.length > 9,
    };
  },

  // 轻量估值刷新落账：fetchFundEstimate 结果 → 页面字段 + 合并进历史（cached 为当前缓存对象）
  _applyEstimate(e, cached) {
    const actualCR = e.actualChangeRate != null ? e.actualChangeRate : this.data.actualChangeRate;
    // 净值与净值日期必须成对更新：只拿到 actualNav 而没拿到 actualDate 时若各自兜底，
    // 会出现「净值是今天的、日期停在昨天」的混合态，进而让当日涨幅判成无数据、显示 "--"
    // （2026-10-21 用户反馈：收盘后净值已更新，详情页当日涨幅仍是 --）
    const hasNavPair = !!(e.actualDate && e.actualNav);
    this.setData({
      nav: e.nav != null ? e.nav : this.data.nav,
      // !== undefined 而非 != null：服务端明确回 null（今日无估值，如 source=nav 的债券/968）
      // 时要让旧估值/时间一起清掉，否则卡片1 会出现"涨幅估算 -- + 盘中估算角标"的混搭
      estimatedNav: e.estimatedNav !== undefined ? e.estimatedNav : this.data.estimatedNav,
      estimatedChangeRate: e.estimatedChangeRate !== undefined ? e.estimatedChangeRate : this.data.estimatedChangeRate,
      estSource: e.source || this.data.estSource,
      estimateTime: e.estimateTime !== undefined ? e.estimateTime : this.data.estimateTime,
      actualNav: hasNavPair ? e.actualNav.toFixed(4) : this.data.actualNav,
      actualChangeRate: actualCR,
      displayChangeRate: calc.selectChangeRate(
        e.nav != null ? e.nav : this.data.nav,
        e.actualNav != null ? e.actualNav : parseFloat(this.data.actualNav),
        e.estimatedChangeRate, actualCR),
      actualDate: hasNavPair ? e.actualDate : this.data.actualDate,
      priceLoading: false,
      peTemp: e.peTemp || this.data.peTemp,
      marketInd: this._miDecorate(e.marketInd) || this.data.marketInd,
      ...this._accuracyFields(e), ...this._rebateField(),
    });
    // 最新一天净值合并进历史（估值接口自带 actualDate/actualNav，无需单独拉历史接口）
    if (e.actualDate && e.actualNav) {
      const merged = this._mergeHistory(cached.history, [{
        date: e.actualDate, nav: e.actualNav,
        changeRate: e.actualChangeRate != null ? e.actualChangeRate : 0,
      }]);
      this.setData({
        navHistory: merged,
        displayHistory: merged.slice(0, 5),
        displayCount: 5,
      });
      this.calcReturns(merged);
      // 缓存断档（隔了多个交易日才进）→ 单点合并补不齐中间日期，后台全量补拉历史
      const newestBefore = cached.history[0] && cached.history[0].date;
      const dayBefore = (() => {
        const t = new Date(e.actualDate + "T00:00:00Z");
        t.setUTCDate(t.getUTCDate() - 1);
        return t.toISOString().slice(0, 10);
      })();
      if (newestBefore && newestBefore < marketTime.lastTradingDay(dayBefore)) {
        this.fetchHistory(300, { skipRedraw: true });
      }
    }
  },

  // 读缓存（不渲染），供 fetchAll 判断是否有历史可复用
  _readCache() {
    try { return wx.getStorageSync(CACHE_PREFIX + this.data.fundCode) || null; }
    catch (e) { return null; }
  },

  // 历史合并：新点覆盖旧点（含缓存已有的同日期），按日期倒序（最新在前）
  _mergeHistory(oldHist, newHist) {
    const map = {};
    (oldHist || []).forEach(h => { if (h && h.date) map[h.date] = h; });
    (newHist || []).forEach(h => {
      if (h && h.date && h.nav != null && h.nav > 0) map[h.date] = h;
    });
    return Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
  },

  _restoreCache() {
    try {
      const cached = wx.getStorageSync(CACHE_PREFIX + this.data.fundCode);
      if (!cached || !cached.history || !cached.history.length) return false;
      // 数据只在交易日变化：跨日/周末的缓存也直接渲染（旧值即最新值），不再有「加载中」空窗。
      // 是否后台刷新由 isCacheFresh 判断：盘中短 TTL、收盘净值发布(actualDate=今天)后冻结、周末全天免拉
      // 但"今日"字段（估算/涨跌展示/持仓当日收益）隔日就是上一交易日的值，开盘后不能直出：
      // 置 null 走 "--" 占位，等 fetchEstimate / checkHolding 回来再填（净值与净值日期不受影响）
      const cacheToday = marketTime.cacheIsToday(cached.ts);
      this._backfillName(cached.fundName);
      // 缓存里的个股涨跌可能是任意一天的（2026-10-26 用户反馈：持仓页显示了一周前的行情，
      // 10 只重仓股涨幅全红、实际当天多数在跌）。缓存没有可信日期就不当"今日"用：
      // 只有明确标记为今天的行情才保留，其余置 null 显示 "--"，等实时补拉回来再填
      const cachedHoldings = this._sanitizeQuotes(cached.holdings || []);
      this.setData({
        loading: false,
        fundName: this.data.fundName || cached.fundName || "",
        nav: cached.nav, estimatedNav: cacheToday ? cached.estimatedNav : null,
        estimatedChangeRate: cacheToday ? cached.estimatedChangeRate : null,
        estimateTime: cacheToday ? cached.estimateTime : "",
        actualNav: cached.actualNav, actualChangeRate: cached.actualChangeRate,
        actualDate: cached.actualDate, displayChangeRate: cacheToday ? cached.displayChangeRate : null,
        peTemp: cached.peTemp || null,
        marketInd: cached.marketInd || null,
        navHistory: cached.history,
        displayHistory: (cached.history || []).slice(0, 5),
        displayCount: 5,
        // 持仓区数据一并秒开（checkHolding 网络请求返回后会自动覆盖更新）
        holdingData: cacheToday ? (cached.holdingData || null) : null,
        // 前十大持仓/档案季频静态数据一并秒开（原先不入缓存，每次切 tab 都要懒加载打网络）
        holdings: cachedHoldings, exited: cached.exited || [],
        quarterLabel: cached.quarterLabel || '', prevDataIncomplete: !!cached.prevDataIncomplete,
        turnoverRates: cached.turnoverRates || [],
        // 旧版代码曾把档案接口超时的 profile:null 洗成空对象 {} 写入缓存；fundSizeText 只在
        // 档案成功处理后才存在，据此剔除脏数据让其自动重拉。profileLoaded 同步置位，
        // 否则缓存秒开时点档案 tab 不触发拉取、profileLoaded 恒为 false → 档案页空白
        profile: cached.profile && cached.profile.fundSizeText ? cached.profile : null,
        manager: cached.manager || null,
        sameTypeRank: cached.sameTypeRank || null,
        rankFetched: !!cached.rankFetched,
        profileLoaded: !!(cached.profile && cached.profile.fundSizeText),
      }, () => {
        // 档案在缓存里但排名还没确认（老缓存缺字段 / 上次拉取超时）→ 标脏，切档案 tab 补拉一次。
        // 不这样做的话，缓存命中的页面（profile 已存在 → onTabTap 守卫跳过请求）永远拿不到该字段。
        // 用 rankFetched 而非 sameTypeRank 判空：区分「还没拿到」与「该基金确实无排名（rankOk:true + rank:null）」
        if (cached.profile && cached.profile.fundSizeText && !cached.rankFetched) this._profileStale = true;
        this.calcReturns(cached.history);
        this.updateDisplay();
        // 缓存含原始持仓时直接用缓存数据计算持仓区，避免等 checkHolding 网络请求出现空白窗口
        if (cached.rawHolding) {
          this._rawHolding = cached.rawHolding;
          this.enrichHoldingData();
        }
        // 重仓股实时涨跌静默补拉（缓存里的行情是上次保存时刻的旧值，盘中在变）
        // 只在"盘中"或"确实缺当日行情"时才打这 10 个请求：收盘后个股涨跌已定格，
        // 缓存里就是当日最终值，没必要每次进页面重拉一遍
        // 只要不是"休市/盘前"就刷新：收盘后（afterClose）缓存里可能存的是当天盘中某一刻的涨跌，
        // 只有收盘终值才是对的，不能因为"日期是今天"就跳过
        const needQuoteRefresh = marketTime.marketPhase() !== "closed" ||
          cachedHoldings.some(h => h.stockChangeRate == null);
        if (needQuoteRefresh) {
          // 注意传的是持仓对象数组：_fetchStockQuotes 内部读 h.stockCode，
          // 此前这里传的是股票代码字符串数组 → 全是 undefined → 静默空转（从 2026-08-30 缓存改造起就坏了）
          this._fetchStockQuotes(cachedHoldings).then(quotes => {
            if (!Object.keys(quotes).length) return;
            this.setData({ holdings: this._applyQuotes(cachedHoldings, quotes) });
          }).catch(() => {});
          // 客户端行情源（push2*.eastmoney.com）会被限流、偶发整体不可用，此时上面那次补拉会拿空。
          // 缓存的行情又已按"只认当日"清空了 —— 直接让云端补一次（云函数走腾讯行情，稳定）
          if (cachedHoldings.some(h => h.stockChangeRate == null)) {
            this.fetchProfile().catch(() => {});
          }
        }
        this.drawChart();
      });
      // 持仓/档案缓存超过 7 天，或缓存数据版本落后（后端修正调仓动向等计算）→ 视为陈旧：
      // 切 tab 时后台静默刷新 fetchProfile（旧值先显不转圈）。版本旧时主动重拉，立即用新值覆盖。
      const cacheVersionOk = cached.dataVersion === HOLDINGS_CACHE_VERSION;
      // 季报落后：本地缓存里还是上一季（如 10 月下旬仍存 2026年Q2）→ 与"版本旧"同等对待，立刻重拉。
      // 2026-10-27 用户反馈：季报早披露了，持仓页还停在上一个季度
      // 加 1 天节流：季报是陆续披露的，披露窗口内（如 10-01~10-25）每次进页面都判"落后"会反复请求，
      // 同一天只重拉一次就够
      const quarterBehindCache = !!(cached.quarterLabel && cached.quarterLabel !== this._expectedQuarterLabel() &&
        (Date.now() - (cached.ts || 0) > 86400000));
      this._profileStale = !cacheVersionOk || quarterBehindCache || !cached.ts || (Date.now() - cached.ts > 7 * 86400000);
      if (!cacheVersionOk || quarterBehindCache) {
        // 旧版本缓存（如含修复前错误调仓动向）：渲染旧值后立即重拉档案/持仓，覆盖为最新
        this.fetchProfile().catch(() => {});
      }
      return marketTime.isCacheFresh(cached);
    } catch (e) { return false; }
  },

  _saveCache() {
    try {
      wx.setStorageSync(CACHE_PREFIX + this.data.fundCode, {
        fundName: this.data.fundName,
        nav: this.data.nav, estimatedNav: this.data.estimatedNav,
        estimatedChangeRate: this.data.estimatedChangeRate, estimateTime: this.data.estimateTime,
        actualNav: this.data.actualNav, actualChangeRate: this.data.actualChangeRate,
        actualDate: this.data.actualDate, displayChangeRate: this.data.displayChangeRate,
        peTemp: this.data.peTemp,
        marketInd: this.data.marketInd,
        tempDate: marketTime.bjDateStr(),
        history: this.data.navHistory,
        holdingData: this.data.holdingData,
        rawHolding: this._rawHolding || this._lastRawHolding,
        // 持仓/档案季频静态数据入缓存：切持仓/档案 tab 秒出，不用每次懒加载打网络
        holdings: this.data.holdings, exited: this.data.exited,
        quarterLabel: this.data.quarterLabel, prevDataIncomplete: this.data.prevDataIncomplete,
        turnoverRates: this.data.turnoverRates, profile: this.data.profile, manager: this.data.manager,
        sameTypeRank: this.data.sameTypeRank,
        rankFetched: !!this.data.rankFetched,
        dataVersion: HOLDINGS_CACHE_VERSION,
        ts: Date.now(),
      });
      this._pruneCache();
    } catch (e) { /* ignore */ }
  },

  // 缓存 LRU：每基金一个 key 无清理会一直累积，超过 20 只时按缓存时间戳（ts）淘汰最旧的
  _pruneCache() {
    try {
      const keys = (wx.getStorageInfoSync().keys || [])
        .filter(k => k.indexOf(CACHE_PREFIX) === 0);
      if (keys.length <= 20) return;
      const items = keys
        .map(k => ({ k, ts: (wx.getStorageSync(k) || {}).ts || 0 }))
        .sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < items.length - 20; i++) wx.removeStorageSync(items[i].k);
    } catch (e) { /* ignore */ }
  },
  async checkFollow() {
    try {
      const res = await api.watchlistCheck(this.data.fundCode);
      if (res.result && res.result.code === 0 && res.result.data) {
        this.setData({ followed: !!res.result.data.followed });
      }
    } catch (e) { console.error("检查自选失败:", e); }
  },
  // R1 关注 CTA（未持仓用户）：零门槛直接加自选，不弹分组选择（搜索落地的第一动作
  // 不能被表单打断；分组整理留给之后在自选页做）。成功即拉起订阅授权（"存下东西"的
  // 时刻授权意愿最高），拒绝/频控静默。取消关注直连 remove。
  // 误差行点击开合：展开近 30 天逐日"估算 vs 实际"对账（数据随概览接口一次带回，无额外请求）
  onToggleAccLog() {
    this.setData({ accLogVisible: !this.data.accLogVisible });
  },

  async onFollowCta() {
    const { fundCode, fundName, followed } = this.data;
    try {
      if (followed) {
        const res = await api.watchlistRemove(fundCode);
        if (res.result && res.result.code === 0) {
          this.setData({ followed: false });
          wx.showToast({ title: "已取消关注", icon: "none" });
        } else {
          wx.showToast({ title: "操作失败", icon: "none" });
        }
        return;
      }
      const res = await api.watchlistAdd(fundCode, fundName);
      if (res.result && res.result.code === 0) {
        this.setData({ followed: true });
        recent.addFund(fundCode, fundName);
        wx.showToast({ title: "已关注", icon: "success" });
        subscribe.requestAuth("fund_detail_follow");
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "操作失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
  },

  // R2 净值更新提醒（"存下东西"后的回访钩子；拒绝/频控由 subscribe 内部静默处理）
  onRemindNav() {
    subscribe.requestAuth("fund_detail_nav");
  },

  // 估值/数据加载失败重试：清错误态重走 fetchAll
  onRetryDetail() {
    this.setData({ loading: true, loadError: false, errorMsg: "" });
    this.fetchAll();
  },

  async onToggleFollow() {
    const { fundCode, fundName, followed } = this.data;
    try {
      if (followed) {
        const res = await api.watchlistRemove(fundCode);
        if (res.result && res.result.code === 0) {
          this.setData({ followed: false });
          wx.showToast({ title: "已取消自选", icon: "none" });
        } else {
          wx.showToast({ title: "操作失败", icon: "none" });
        }
      } else {
        // 拉取分组列表，让用户选择
        let groups = [];
        try {
          const gRes = await api.watchlistGetGroups();
          if (gRes.result && gRes.result.code === 0) groups = gRes.result.data || [];
        } catch (e) { /* 忽略 */ }
        // ActionSheet 的 itemList 上限 6 条：分组多于 4 个时列表会变成 7+ 条，
        // 微信直接 fail 且无 fail 提示——表现就是"加自选点了没反应"（实测 5 个分组即触发）。
        // 超出部分截断，用户仍可走「新建分组」；上限是微信组件限制，全量分组选择器需自定义弹层
        const itemList = [...groups.slice(0, 4), "不分组", "新建分组"];
        wx.showActionSheet({
          itemList,
          success: async (r) => {
            const choice = itemList[r.tapIndex];
            let group = "";
            if (choice === "新建分组") {
              // 使用模态框输入
              const modalRes = await new Promise(resolve => {
                wx.showModal({
                  title: "新建分组", editable: true, placeholderText: "输入分组名称",
                  content: "",
                  success: res => resolve(res),
                });
              });
              if (!modalRes.confirm || !modalRes.content) return;
              group = modalRes.content.trim().slice(0, 20);
            } else if (choice !== "不分组") {
              group = choice;
            }
            // 加入自选
            const addRes = await api.watchlistAdd(fundCode, fundName);
            if (addRes.result && addRes.result.code === 0) {
              this.setData({ followed: true });
              // 设置分组
              if (group) {
                await api.watchlistSetGroup([fundCode], group).catch(() => {});
              }
              wx.showToast({ title: group ? `已加自选 · ${group}` : "已加自选", icon: "success" });
            } else {
              wx.showToast({ title: (addRes.result && addRes.result.msg) || "操作失败", icon: "none" });
            }
          },
        });
      }
    } catch (e) {
      wx.showToast({ title: "操作失败", icon: "none" });
    }
  },

  updateDisplay() {
    // isTrading 用 marketPhase（节假日表 + 9:25 边界，与全站口径一致）：
    // 旧写法"周几 && 9:00–15:30"用设备时间、不查节假日——工作日休市会把估算框照常显示出来
    const isTrading = marketTime.marketPhase() === "trading";
    const displayChangeRate = calc.selectChangeRate(
      this.data.nav, this.data.actualNav,
      this.data.estimatedChangeRate, this.data.actualChangeRate,
    );
    // 涨跌幅展示统一两位小数：估值源（新浪）原始值是 4 位（如 0.3822），会直接渲染成 +0.3822%。
    // WXML 不能调方法，所以在这里算好文本字段（与首页 _crText 的两位小数口径一致）
    const rateText = (v) => {
      const n = parseFloat(v);
      if (v == null || v === "" || isNaN(n)) return "--";
      if (Math.abs(n) < 0.005) return "0.00%"; // 开盘头几分钟估值常在 ±0.005% 内，别显示成 -0.00%
      return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
    };
    // 净值日（服务端给的是北京日期）→ 用北京日比较，别用设备本地日期（非 +8 时区会误判成未公布）
    const isNavUpdated = this.data.actualDate === marketTime.bjDateStr();
    // 估算口径只在「盘中 且 今日净值尚未公布 且 有估算净值」时成立：净值一公布就切回真值口径，
    // 否则主数字（有持仓时是当日收益）用真值算、旁边涨跌幅还挂估算值，两个数字对不上
    const showEstimate = !!(isTrading && !isNavUpdated && this.data.estimatedNav);
    // 今日既无净值也拿不到估算（债券/968/货币等无覆盖标的：服务端 source="nav" 回退成上一交易日涨幅）
    // → 头部不能拿上一交易日的涨幅当"今日"（首页当日收益列同样显示 --）。
    // 判据用 marketPhase（9:25 起才叫"今天"）：9:25 前与周末节假日仍展示最近交易日，全站口径一致。
    // 第二个条件是"估算值还没到位"（缓存直出窗口里 estSource 还是空串、估算值为 null）——
    // 只看 estSource 的话那段时间会算回上一交易日涨幅，"--" 只活一帧
    const noTodayEst = marketTime.marketPhase() !== "closed" && !isNavUpdated &&
      (this.data.estSource === "nav" || this.data.estimatedChangeRate == null);
    // R2 估值兜底文案：盘后/休市/未持仓时给出定格说明（估值卡不空白、不误标"今日"）
    let estFrozenText = "";
    if (!showEstimate && !(this.data.hasHolding && this.data.holdingData)) {
      if (isNavUpdated) estFrozenText = "今日净值已更新";
      else if (marketTime.marketPhase() === "afterClose") estFrozenText = "今日估值已收盘定格 · 今晚更新净值";
      else if (marketTime.isTradingDay(marketTime.bjDateStr())) estFrozenText = "今日估值 9:25 后更新";
      else estFrozenText = "休市中 · 估值已定格";
    }
    this.setData({
      isTrading, displayChangeRate, isNavUpdated, showEstimate, noTodayEst, estFrozenText,
      estimatedChangeRateText: noTodayEst ? "--" : rateText(this.data.estimatedChangeRate),
      displayChangeRateText: noTodayEst ? "--" : rateText(displayChangeRate),
    });
  },

  // 今日估算涨跌幅：只在"确有今日估值"时返回值（服务端 source==="nav" = 两源都拿不到今日估算，
  // 那个值是上一交易日的涨幅）。净值已公布时它是真今日涨幅；休市相位照常给最近交易日口径
  _todayEstRate() {
    const v = parseFloat(this.data.estimatedChangeRate);
    if (!isFinite(v)) return null;
    const usable = this.data.estSource !== "nav" || this.data.isNavUpdated || marketTime.marketPhase() === "closed";
    return usable ? v : null;
  },

  async fetchEstimate() {
    try {
      const res = await api.fetchFundEstimate(this.data.fundCode);
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        const actualCR = d.actualChangeRate != null ? d.actualChangeRate : this.data.actualChangeRate;
        const yesterdayNav = d.nav != null ? d.nav : this.data.nav;
        const actNavRaw = d.actualNav != null ? d.actualNav : parseFloat(this.data.actualNav);
        const displayCR = calc.selectChangeRate(yesterdayNav, actNavRaw, d.estimatedChangeRate, actualCR);
        this.setData({
          nav: d.nav, estimatedNav: d.estimatedNav,
          estimatedChangeRate: d.estimatedChangeRate, estimateTime: d.estimateTime, estSource: d.source || "",
          fundName: this.data.fundName || d.fundName || "",
          actualNav: d.actualNav ? d.actualNav.toFixed(4) : this.data.actualNav,
          actualChangeRate: actualCR,
          displayChangeRate: displayCR,
          peTemp: d.peTemp || this.data.peTemp,
          marketInd: this._miDecorate(d.marketInd) || this.data.marketInd,
          isBondFund: this._bondFlag(this.data.fundName || d.fundName),
          ...this._accuracyFields(d), ...this._rebateField(),
        });
        this._backfillName(d.fundName);
      }
    } catch (e) { console.error("获取估值失败:", e); }
  },

  async fetchHistory(days = 250, opts = {}) {
    try {
      const res = await api.fetchFundNAVHistory(this.data.fundCode, days);
      if (res.result && res.result.code === 0) {
        const history = res.result.data;
        if (history.length > 0) {
          // 服务端返回少于请求数-20 → 已到该基金历史上限（新基金）或服务端钳制（800 天）。
          // 容忍个别页拉取失败（差一页不置位，代价只是下次切区间多补一轮）
          if (days >= 800 || history.length < days - 20) this._historyMaxed = true;
          this.setData({
            navHistory: history,
            displayHistory: history.slice(0, 5),
            displayCount: 5,
            actualNav: this.data.actualNav || (history[0].nav != null ? history[0].nav.toFixed(4) : ""),
            actualDate: history[0].date,
            actualChangeRate: this.data.actualChangeRate != null ? this.data.actualChangeRate : (history[0].changeRate || 0),
          });
          this.calcReturns(history);
          // 补拉（缓存断档场景）完成后：重绘图表（此前只 setData 不重绘，
          // 断档数据按等间距 x 映射会把旧日期买入点压到图尾）+ 回写缓存避免下次再补。
          // opts.skipRedraw：调用方紧接着自己会重绘（如切区间），这里再画一次会与之重复——
          // drawChart 是异步的（createSelectorQuery 回调），两次绘制会排队执行，
          // 后者会把前者刚播的进场动画直接覆盖掉，表现为"切区间没有动画"
          if (this.data.activeTab === 'trend' && !opts.skipRedraw) this.drawChart();
          this._saveCache();
        }
      }
    } catch (e) { console.error("获取历史净值失败:", e); }
  },

  // 风格漂移卡数据（纯数据陈述，无引导性措辞）：重仓股新进/跌出名单（各截断 3 个）。
  // 港股加 (H) 标注：同一家公司可 A+H 双重上市（如中际旭创 300308.SZ / 03308.HK），
  // 不标注会出现"中际旭创 新进 + 中际旭创 跌出"的两行，看着像 bug
  _driftCard(holdings, exited, quarterLabel, prevIncomplete) {
    if (!holdings || holdings.length === 0 || prevIncomplete) return null;
    const clip = (arr) => arr.slice(0, 3).join("、") + (arr.length > 3 ? " 等" : "");
    // 同名 A+H 同时出现时（如中际旭创：Q3 新进 H 股、Q2 前十的 A 股跌出），
    // 两侧都打市场标记，否则会再被看成"同一只既新进又跌出"
    const newRows = holdings.filter(h => h.changeType === 'new');
    const exitRows = exited || [];
    const nameOf = (h) => h.stockName || "";
    const collide = new Set(
      newRows.map(nameOf).filter(n => n && exitRows.some(e => nameOf(e) === n))
    );
    const isHK = (h) => h.isHK || String(h.stockCode || "").length === 5;
    const label = (h) => {
      const name = nameOf(h);
      if (!name) return "";
      if (isHK(h)) return name + "(H)";
      return collide.has(name) ? name + "(A)" : name;
    };
    const news = newRows.map(label).filter(Boolean);
    const exitNames = exitRows.map(label).filter(Boolean);
    // 折叠态各显示前 3 只；点卡片展开显示全部（用户 2026-11-05 拍板）
    return {
      quarterLabel,
      stable: news.length === 0 && exitNames.length === 0,
      newsCount: news.length, newsText: news.length ? clip(news) : "", newsFull: news.join("、"),
      exitCount: exitNames.length, exitText: exitNames.length ? clip(exitNames) : "", exitFull: exitNames.join("、"),
      canExpand: news.length > 3 || exitNames.length > 3,
    };
  },

  onToggleDrift() {
    if (!this.data.drift || !this.data.drift.canExpand) return;
    this.setData({ driftExpanded: !this.data.driftExpanded });
  },

  fetchProfile() {
    // 防重入：版本旧触发(加载时) 与 切 tab 可能并发；在途时复用同一请求，
    // 避免切 tab 空转一次（转圈一闪而过、数据要等在途请求结束才出现）
    if (this._profilePromise) return this._profilePromise;
    this._profilePromise = (async () => {
      try {
        const res = await api.fetchFundProfile(this.data.fundCode);
        if (res.result && res.result.code === 0) {
          // 档案子请求超时时云函数仍返回 code:0 + profile:null；
          // 若洗成 {} 会作为真值写入缓存，切档案 tab 的 !profile 重试守卫从此失效 → 永久空白。
          // 视为失败：不覆盖已有值、不写缓存，下次切 tab 自动重试。
          const p = res.result.data.profile || null;
          if (p) {
            if (p.fundSize) { p.fundSizeText = (p.fundSize / 100000000).toFixed(2) + '亿'; }
            else { p.fundSizeText = '--'; }
            const riskMap = { '1': '低风险', '2': '中低风险', '3': '中风险', '4': '中高风险', '5': '高风险' };
            p.riskText = riskMap[p.riskLevel] || p.riskLevel || '--';
          }

          const holdings = res.result.data.holdings || [];
          // 先渲染持仓列表（今日涨跌显示 --），股票行情异步补拉
          const exited = res.result.data.exited || [];
          // rankOk 由云函数给出：true = 请求成功（含该基金确实无排名→rank:null），false = 拉取失败。
          // 旧版云函数没有该字段：拿不到排名时一律按"未确认"处理，下次切档案 tab 自然重试
          const rank = res.result.data.sameTypeRank || null;
          const rankFetched = rank != null || res.result.data.rankOk === true;
          // 清洗后的列表就是真正要展示的：没有"今天"日期的行情会被清成 null
          const sanitizedHoldings = this._sanitizeQuotes(holdings);
          const patch = { manager: res.result.data.manager, holdings: sanitizedHoldings, exited, quarterLabel: res.result.data.quarterLabel || '', prevDataIncomplete: !!res.result.data.prevDataIncomplete, feeData: null, showFee: false, turnoverRates: res.result.data.turnoverRates || [], sameTypeRank: rank, rankFetched };
          // 风格漂移卡（信任线，2026-11 调研增补）：纯客户端聚合两期季报重仓股变动
          // （changeType 由 fetchFundProfile 当期 vs 上期 jjcc 对比产出）。上期数据不完整时
          // 退出数不可信 → 整卡不显示（宁缺毋错）
          const drift = this._driftCard(sanitizedHoldings, exited, res.result.data.quarterLabel || '', !!res.result.data.prevDataIncomplete);
          if (drift) patch.drift = drift;
          if (p) patch.profile = p;
          this.setData(patch);
          if (!rankFetched) this._profileStale = true; // 排名这次没拿到：本次会话再切档案 tab 还能重试
          // 懒加载路径此前从不写缓存，导致持仓/档案每次切 tab 都要重新打网络（季频静态数据）
          if (p) this._saveCache();

          // 后台拉取股票行情（仅补清洗后仍为空的），不阻塞渲染。
          // 必须按清洗后的数组判断：老配置里 stockChangeRate 有值但没有 stockDate，
          // 用原数组判断会认为"不缺行情"从而永远不补拉，界面就定格在全 "--"
          // （2026-10-27 用户反馈：某只基金持仓今日涨跌全部显示 --）
          const missingQuotes = sanitizedHoldings.filter(h => h.stockChangeRate == null);
          if (missingQuotes.length > 0) {
            this._fetchStockQuotes(missingQuotes).then(quotes => {
              if (!Object.keys(quotes).length) return;
              this.setData({ holdings: this._applyQuotes(sanitizedHoldings, quotes) });
              this._saveCache(); // 行情补拉后更新缓存，下次秒出的就是带实时涨跌的版本
            });
          }
        }
      } catch (e) { console.error("获取基金档案失败:", e); }
      this._profilePromise = null;
    })();
    return this._profilePromise;
  },

  // 把行情结果合并进持仓列表：只接受"今天"的行情。
  // 集合竞价（9:25-9:30）/停牌/收盘后，行情源返回的仍是上一交易日收盘价，
  // 直接写进列表就又变成"旧数据当今日"（2026-10-26 用户反馈的同一类问题）
  _applyQuotes(list, quotes) {
    const today = marketTime.bjDateStr();
    return (list || []).map((h) => {
      const q = quotes && quotes[h.stockCode];
      const fresh = q && q.date === today && q.rate != null;
      return {
        ...h,
        stockChangeRate: fresh ? q.rate : (h.stockDate === today ? h.stockChangeRate : null),
        stockDate: fresh ? today : (h.stockDate === today ? h.stockDate : null),
        isHK: h.stockCode && h.stockCode.length === 5,
      };
    });
  },

  // 按当前日期"应该有"的季报标签（与云函数 getQuarterParams 同口径）：
  // 1-3月→上年Q4, 4-6月→本年Q1, 7-9月→Q2, 10-12月→Q3
  _expectedQuarterLabel() {
    const d = new Date(Date.now() + 8 * 3600000);
    const m = d.getUTCMonth() + 1;
    let y = d.getUTCFullYear(), mon;
    if (m >= 10) mon = 9;
    else if (m >= 7) mon = 6;
    else if (m >= 4) mon = 3;
    else { y -= 1; mon = 12; }
    return `${y}年Q${Math.ceil(mon / 3)}`;
  },

  _sanitizeQuotes(list) {
    const today = marketTime.bjDateStr();
    return (list || []).map((h) => {
      if (!h) return h;
      const fresh = h.stockDate === today;
      return fresh ? h : Object.assign({}, h, { stockChangeRate: null });
    });
  },

  _fetchStockQuotes(holdings) {
    const map = {};
    const tasks = [];
    holdings.forEach(h => {
      const code = h.stockCode;
      if (!code) return;
      let secid;
      if (code.length === 6) {
        secid = (code.startsWith("6") ? "1." : "0.") + code;
      } else if (code.length === 5) {
        secid = "116." + code;
      } else {
        return;
      }
      tasks.push(new Promise((resolve) => {
        wx.request({
          // f170=涨跌幅(万分位) f86=行情时间戳(秒)：带出日期才能在渲染时区分"今日"与"上一交易日"
          url: `https://push2his.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f170,f86`,
          header: { Referer: "https://quote.eastmoney.com/" },
          success(res) {
            try {
              const d = (res.data && res.data.data) || {};
              let qd = null;
              if (d.f86) {
                const t = new Date(d.f86 * 1000 + 8 * 3600000);
                qd = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
              }
              map[code] = d.f170 != null ? { rate: +(d.f170 / 100).toFixed(2), date: qd } : null;
            } catch (e) { /* ignore */ }
            resolve();
          },
          fail() { resolve(); },
        });
      }));
    });
    return Promise.all(tasks).then(() => map);
  },

  calcReturns(history) {
    const r = calc.calcPeriodReturns(history);
    const { displayChangeRate } = this.data;
    // 风险指标固定按"近一年"（最近 250 个交易日）计算：
    // 用全量 history 的话，用户切过一次"近三年"（800 点）口径就变成三年，与"近一年"标签不符
    const riskWindow = history.slice(0, 250);
    const dd = calc.calcMaxDrawdown(riskWindow);
    const vol = calc.calcVolatility(riskWindow);
    const sharpe = calc.calcSharpe(riskWindow);
    const riskMetrics = dd.drawdown != null ? {
      maxDrawdown: dd.drawdown,
      ddPeakDate: dd.peakDate, ddTroughDate: dd.troughDate,
      volatility: vol != null ? vol : '--',
      sharpe: sharpe != null ? sharpe : '--',
    } : null;
    // R8 水下时间/最长被套：官方日增长率逐日复利重构净值（消除分红除息假回撤，同 review 页
    // 口径），时间升序后扫描"低于运行峰值"的天数占比与最长连续段。窗口与风险指标一致（近一年）
    const underwaterMetrics = (() => {
      const chrono = [];
      let prevAdj = null;
      riskWindow.slice().reverse().forEach((d) => {
        let adj = d.nav;
        if (prevAdj != null) {
          if (typeof d.changeRate === "number") adj = prevAdj * (1 + d.changeRate / 100);
          else if (prevAdj > 0) adj = prevAdj * (d.nav / prevAdj);
          else adj = prevAdj;
        }
        if (!(adj > 0)) return;
        chrono.push({ date: d.date, adj });
        prevAdj = adj;
      });
      if (chrono.length < 60) return null; // 数据不足（新基金）整块不渲染
      let peak = 0, underDays = 0, maxStreak = 0, streak = 0, curStart = "", bestStart = "", bestEnd = "";
      chrono.forEach((p) => {
        if (p.adj > peak) peak = p.adj;
        if (p.adj < peak) {
          underDays++;
          streak++;
          if (!curStart) curStart = p.date;
          if (streak > maxStreak) { maxStreak = streak; bestStart = curStart; bestEnd = p.date; }
        } else { streak = 0; curStart = ""; }
      });
      const last = chrono[chrono.length - 1];
      const underwaterNow = last.adj < peak;
      return {
        pct: Math.round((underDays / chrono.length) * 100),
        maxStreak,
        range: bestStart ? `${bestStart.slice(5)} → ${bestEnd.slice(5)}` : "",
        underwaterNow,
        recoverPct: underwaterNow ? +(((peak / last.adj) - 1) * 100).toFixed(2) : null,
      };
    })();
    this.setData({
      todayReturn: displayChangeRate != null ? displayChangeRate : (r.day || 0),
      weekReturn: r.week, monthReturn: r.month, threeMonthReturn: r.threeMonth,
      sixMonthReturn: r.sixMonth, yearReturn: r.year, threeYearReturn: r.threeYear,
      riskMetrics, underwaterMetrics,
    });
  },

  _buildChartData() {
    const history = this.data.navHistory;
    if (history.length < 2) return null;

    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260, '3Y': 750 };
    const days = PERIOD_DAYS[this.data.chartPeriod] || 260;
    const sliced = history.slice(0, days);
    if (sliced.length < 2) return null;

    const data = [...sliced].reverse();
    const hd = this.data.holdingData;

    if (hd && hd.shares && parseFloat(hd.shares) > 0) {
      // 有持仓 → 收益走势（基于首日净值变化百分比）
      const baseNav = data[0].nav;
      if (!baseNav) return null;
      return {
        items: data.map(d => ({
          date: d.date,
          value: +((d.nav / baseNav - 1) * 100).toFixed(2),
        })),
        isReturn: true,
      };
    }

    // 无持仓 → 净值走势
    return {
      items: data.map(d => ({ date: d.date, value: d.nav })),
      isReturn: false,
    };
  },

  _getChartOpts() {
    const hd = this.data.holdingData;
    // 无持仓 → 净值走势：净值曲线用中性蓝（红绿表达的是涨跌，净值曲线本身无涨跌语义）
    if (!(hd && hd.shares && parseFloat(hd.shares) > 0)) {
      return { w: this._canvasW || 340, h: this._canvasH || 180, color: '#1976D2' };
    }
    const color = parseFloat(hd.totalReturn) >= 0 ? '#E4393C' : '#2E8B57';
    return { w: this._canvasW || 340, h: this._canvasH || 180, color };
  },

  drawChart() {
    const result = this._buildChartData();
    if (!result) return;
    const { items: data } = result;
    const w = this._canvasW || 340, h = this._canvasH || 180;
    const query = wx.createSelectorQuery();
    query.select('#navCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      // 用 selector 实测宽度（canvas 在 .chart-card 内被 margin/padding 收窄，
      // windowWidth-24 与触摸坐标系不一致会导致指示线错位）
      const rw = res[0].width || w;
      const rh = res[0].height || h;
      this._realChartW = rw;
      this._realChartH = rh;
      const opts = { w: rw, h: rh, ...this._getChartOpts(), data,
        padding: { top: 24, right: 24, bottom: 30, left: 52 },
        isReturn: result.isReturn };
      // 曲线与买卖点标记一起画到目标画布：标记必须烘进离屏图，随动画一起露出
      const paint = (target) => {
      const ctx = chart.drawLineChart(target, opts);
      if (!ctx) return null;
      // 快照存页级：chart._lastDraw 是模块单例，页面栈里两个图表页会互相覆盖，
      // 返回上一页再触摸会拿到别的页面的数据快照（十字线错位）
      this._lastDrawSnap = chart._lastDraw;

      // 必须与 drawLineChart 同一坐标系（opts.w/opts.h = 画布绘制尺寸）：
      // 用 rw/rh（节点实测=CSS×dpr）会在手机上放大 2-3 倍，买卖点画出画布不可见
      const p = opts.padding;
      const pw = opts.w - p.left - p.right, ph = opts.h - p.top - p.bottom;
      const vals = data.map(d => d.value);
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = max - min || 0.01;
      const yMin = min - range * 0.15, yMax = max + range * 0.15;
      const xp = (i) => p.left + (pw / (data.length - 1)) * i;
      const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
      this._paintTxDots(ctx, data, xp, yp);
      return ctx;
      };

      chart.drawChartAnimated(canvas, {
        // 必须用 opts.w/opts.h：上面 _getChartOpts() 在 w:rw 之后展开，已把 opts.w 覆盖成
        // _canvasW（=windowWidth-24），绘制坐标系以它为准；用 rw 会让刷白边界比绘图区右界
        // 少一个卡片内边距（约 24px），动画期间右端会露出一截曲线
        w: opts.w, h: opts.h,
        plot: opts.padding,
        animate: !this._chartAnimated, duration: 1200,
        draw: paint,
      });
      // 进场动画窗口：窗口内到来的重绘请求（缓存秒开后的估值/历史刷新）直接跳过，
      // 避免"画完再画一次"把 1.2s 进场动画拦腰截断（profit-detail 同款守卫）
      if (!this._chartAnimated) this._animUntil = Date.now() + 1300;
      this._chartAnimated = true;
      this._baseData = { data, opts, canvas, paint };
    });
  },

  // 买卖点标记绘制：正常绘制（drawChart.paint）与十字线快速重绘（onChartTouch）共用。
  // 坐标系由调用方给定（必须与 drawLineChart 一致），本方法只负责按 chartTxMap 画点
  _paintTxDots(ctx, data, xp, yp) {
    const txMap = this.data.chartTxMap || {};
    if (Object.keys(txMap).length === 0) return;
    data.forEach((d, i) => {
      const tx = txMap[d.date];
      if (!tx) return;
      const x = xp(i), y = yp(d.value);
      // 白色描边：买卖点画在红色曲线上也清晰可见（密集周期视图不融线）
      const dot = (r, fill) => {
        ctx.beginPath(); ctx.arc(x, y, r + 1, 0, 2 * Math.PI);
        ctx.fillStyle = '#FFFFFF'; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = fill; ctx.fill();
      };
      if (tx.buys > 0 && tx.sells > 0) {
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.fillStyle = '#FFFFFF'; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
        ctx.strokeStyle = '#2E8B57'; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI);
        ctx.fillStyle = '#E4393C'; ctx.fill();
      } else if (tx.buys > 0) {
        dot(2, '#E4393C');
      } else if (tx.sells > 0) {
        dot(2, '#2E8B57');
      }
    });
  },

  onChartTouch(e) {
    if (!this._baseData) return;
    const { data, opts, canvas } = this._baseData;

    if (e.type === 'touchstart') {
      this._touchSY = e.touches[0].y;
      this._touchSX = e.touches[0].x;
      this._touchActive = false;
      this._touchTopCheck = e.touches[0].y < 100;
      return;
    }

    if (e.type === 'touchend') {
      this._touchActive = false;
      this.drawChart();
      return;
    }

    if (!this._touchActive) {
      const dy = Math.abs(e.touches[0].y - this._touchSY);
      const dx = Math.abs(e.touches[0].x - this._touchSX);
      if (this._touchTopCheck && e.touches[0].y > this._touchSY && dy > dx) return;
      if (dy > dx && dy > 8) return;
      if (dx > dy && dx > 8) this._touchActive = true;
    }
    if (!this._touchActive) return;

    const now = Date.now();
    if (this._touchT && now - this._touchT < 60) return;
    this._touchT = now;

    // 不重建位图：setTransform 幂等重置变换（逐帧 canvas.width 赋值会清空并重建位图，低端机拖动掉帧）
    const dpr = wx.getWindowInfo().pixelRatio;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const p = opts.padding;
    const pw = opts.w - p.left - p.right, ph = opts.h - p.top - p.bottom;
    const vals = data.map(d => d.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;
    const xp = (i) => p.left + (pw / (data.length - 1)) * i;
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    const px = e.touches[0].x;
    let nearest = 0, minDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(xp(i) - px);
      if (dist < minDist) { minDist = dist; nearest = i; }
    });

    const pt = data[nearest];
    const cx = xp(nearest), cy = yp(pt.value);

    chart._drawFastLine(ctx, this._lastDrawSnap, opts);
    // 十字线快速重绘同样带上买卖点：快照只含折线，原来按住查看时点会消失（2026-10-06 用户反馈）
    this._paintTxDots(ctx, data, xp, yp);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, p.top); ctx.lineTo(cx, opts.h - p.bottom); ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.strokeStyle = opts.color || '#E4393C'; ctx.lineWidth = 1; ctx.stroke();

    const v = pt.value;
    const suffix = opts.isReturn ? '%' : '';
    const label = `${pt.date}  ${v != null ? (v >= 0 ? '+' : '') + v + suffix : '--'}`;
    ctx.font = '11px sans-serif';
    const tw = label.length * 7 + 8;
    const tx = Math.max(p.left + 4, Math.min(opts.w - p.right - tw - 8, cx - tw / 2));
    const ty = Math.max(p.top + 2, cy - 28);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(tx, ty, tw, 20);
    ctx.fillStyle = '#FFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tx + 4, ty + 10);
  },

  async onChartPeriod(e) {
    const period = e.currentTarget.dataset.period;
    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260, '3Y': 750 };
    const neededDays = PERIOD_DAYS[period] || 260;
    this.setData({ chartPeriod: period });
    if (!this._historyMaxed && this.data.navHistory.length < neededDays) {
      // 补拉期间给加载反馈：这几秒里图表若毫无变化，用户会以为"点了没反应/没有动画"
      this.setData({ chartLoading: true });
      try {
        // skipRedraw：下面统一绘制（带动画），避免与补拉后的内部重绘重复
        await this.fetchHistory(neededDays + 50, { skipRedraw: true });
      } finally {
        this.setData({ chartLoading: false });
      }
    }
    this._chartAnimated = false;
    this.drawChart();
  },

  async checkHolding() {
    try {
      const res = await api.holdingCheck(this.data.fundCode);
      if (!res.result || res.result.code !== 0) return;
      // 同一基金可能有多笔（多账户各一笔）：list 为新版返回，data 兼容旧版（单条）
      const list = res.result.list && res.result.list.length
        ? res.result.list
        : (res.result.data ? [res.result.data] : []);
      if (!list.length) {
        // DB 真相 = 已不持有（卖出后/深链进入）。必须显式清态：onLoad 的 portfolio_cache
        // 预填会置 hasHolding=true（3 天 TTL），不清的话"幽灵持仓卡"粘住整个页面生命周期，
        // holdingId 还指向已删记录（校准写 0 行却提示成功）。网络/服务端异常走上面的 return
        // 与 catch，不清（保留预填待重试）
        this._rawHoldings = null;
        this._rawHolding = null;
        this._lastRawHolding = null; // 不同步清的话 _saveCache 的 `rawHolding || _lastRawHolding` 会把幽灵持仓写回缓存
        this.setData({ hasHolding: false, holdingId: null, holdingData: null, holdingRecords: [] });
        return;
      }
      this._rawHoldings = list;
      this._rawHolding = this._aggregateHoldings(list); // 头部/我的持仓按合计口径（与单笔一致）
      this.setData({
        hasHolding: true,
        holdingId: list[0]._id,
        holdingRecords: list.map((r) => ({
          id: r._id,
          platform: r.platform || "未分配",
          group: r.group || "",
          shares: (parseFloat(r.shares) || parseFloat(r.amount) || 0).toFixed(2),
          marketValue: (parseFloat(r.marketValue) || 0).toFixed(2),
          buyPrice: (parseFloat(r.buyPrice) || parseFloat(r.nav) || 0).toFixed(4),
          holdingReturn: (parseFloat(r.holdingReturn) || 0).toFixed(2),
        })),
      });
      return;
    } catch (e) { console.error("checkHolding 客户端失败:", e); }
  },

  // 多笔 → 合计成"一笔"：份额相加、买入净值按份额加权、市值/收益相加。
  // 口径与单笔完全一致（enrichHoldingData 拿到合计后照原逻辑算），页面头部不会因为多账户而算错。
  // 旧 schema { amount, nav } 的 amount 是持仓金额不是份额（与 getPortfolio 同式修复）——
  // 直接 num(r.shares || r.amount) 累加会把金额当份额，回本进度可以差一倍
  _aggregateHoldings(list) {
    const num = (v) => parseFloat(v) || 0;
    const sharesOf = (r) => {
      const s = num(r.shares);
      if (s > 0) return s;
      const price = num(r.buyPrice) || num(r.nav);
      return price > 0 ? num(r.amount) / price : 0;
    };
    const shares = list.reduce((s, r) => s + sharesOf(r), 0);
    const cost = list.reduce((s, r) => s + (num(r.buyPrice) || num(r.nav)) * sharesOf(r), 0);
    const marketValue = list.reduce((s, r) => s + num(r.marketValue), 0);
    const holdingReturn = list.reduce((s, r) => s + num(r.holdingReturn), 0);
    return {
      _id: list[0]._id, fundCode: list[0].fundCode, fundName: list[0].fundName,
      createTime: list[0].createTime,
      shares, marketValue, holdingReturn,
      buyPrice: shares > 0 ? +(cost / shares).toFixed(4) : 0,
    };
  },

  // 明细行点开：对"这一笔"做修改/校准/加减仓/删除
  onRecordTap(e) {
    const id = e.currentTarget.dataset.id;
    const rec = (this.data.holdingRecords || []).find((r) => r.id === id);
    if (!id || !rec) return;
    const self = this;
    wx.showActionSheet({
      itemList: ["修改这笔", "校准这笔", "加减仓", "删除这笔"],
      success(res) {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
        } else if (res.tapIndex === 1) {
          self.setData({ holdingId: id }); // 校准走既有弹层，落到选中的这一笔
          self.onCalibrate();
        } else if (res.tapIndex === 2) {
          wx.setStorageSync("adjust_prefill_holding", id);
          wx.navigateTo({ url: "/pages/adjust-holding/index" });
        } else if (res.tapIndex === 3) {
          wx.showModal({
            title: "确认删除",
            content: `删除「${rec.platform}」这笔持仓？（其它平台不受影响）`,
            success(r) {
              if (!r.confirm) return;
              wx.showLoading({ title: "删除中..." });
              api.holdingRemove(id).then(() => {
                wx.hideLoading();
                wx.showToast({ title: "已删除", icon: "success" });
                self._rawHoldings = null; self._rawHolding = null;
                self.setData({ hasHolding: false, holdingData: null, holdingRecords: [] });
                self.fetchAll();
              }).catch(() => { wx.hideLoading(); wx.showToast({ title: "删除失败", icon: "none" }); });
            },
          });
        }
      },
    });
  },

  async fetchTransactions() {
    try {
      const res = await api.transactionList(this.data.fundCode);
      let txns = (res.result && res.result.data) || [];
      const map = {};
      // 季度净买入（最近90天）
      const now = new Date();
      const qStart = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
      const qStartStr = calc.formatDate(qStart);
      let quarterNet = 0;
      txns.forEach((tx) => {
        if (!tx.date) return;
        if (tx.date >= qStartStr) {
          const amt = parseFloat(tx.amount) || 0;
          if (tx.type === "buy") quarterNet += amt;
          else if (tx.type === "sell") quarterNet -= amt;
        }
        if (!map[tx.date]) map[tx.date] = { buys: 0, sells: 0 };
        if (tx.type === "buy") map[tx.date].buys++;
        else if (tx.type === "sell") map[tx.date].sells++;
      });
      txns = [...txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      // "当时为什么买/卖"时间线：最近 3 条带理由的交易（note 优先，其次 reason 归因枚举文字）
      const noteOf = (tx) => (tx.note || "").trim() || (tx.reason || "").trim();
      const noteTimeline = txns
        .filter((tx) => tx.date && noteOf(tx))
        .slice(0, 3)
        .map((tx) => ({
          date: tx.date, type: tx.type,
          typeText: tx.type === "buy" ? "买入" : "卖出",
          text: noteOf(tx),
        }));
      this.setData({ chartTxMap: map, transactionList: txns, quarterNet, noteTimeline });
    } catch (e) { console.error("获取交易记录失败:", e); }
  },

  enrichHoldingData() {
    if (!this._rawHolding) return;
    // 备份原始持仓供缓存保存（函数末尾会清空 _rawHolding）
    this._lastRawHolding = this._rawHolding;
    const raw = this._rawHolding;
    const { nav, estimatedNav, actualNav } = this.data;
    let yesterdayNav = parseFloat(nav || actualNav || estimatedNav || 0);
    if (!yesterdayNav) return;

    let shares = parseFloat(raw.shares || raw.amount || 0);
    let buyPrice = parseFloat(raw.buyPrice || raw.nav || 0);
    const dbMarketValue = parseFloat(raw.marketValue) || 0;
    const dbHoldingReturn = parseFloat(raw.holdingReturn) || 0;

    const currentNav = calc.selectNav(yesterdayNav, actualNav, estimatedNav);

    // OCR 导入兜底：shares/buyPrice 为 0 时用 DB 中的市值和收益反推
    if ((!shares || !buyPrice) && dbMarketValue > 0 && currentNav > 0) {
      if (!shares) shares = dbMarketValue / currentNav;
      if (!buyPrice && shares > 0) {
        buyPrice = currentNav - (dbHoldingReturn / shares);
        if (buyPrice <= 0) buyPrice = currentNav;
      }
    }

	    const marketValue = currentNav * shares;
	    // 今日收益：净值已公布用精确值，未公布用自主估算涨跌
	    let todayProfit;
	    if (currentNav !== yesterdayNav) {
	      todayProfit = (currentNav - yesterdayNav) * shares;
	    } else {
	      // 无今日估值（债券/968 等）→ 当日收益按 0 计，不拿上一交易日涨幅顶替（与首页一致）
	      const estRate = this._todayEstRate();
	      todayProfit = estRate ? yesterdayNav * estRate / 100 * shares : 0;
	    }
	    const costValue = buyPrice * shares;
	    const totalReturn = marketValue - costValue;
	    const totalReturnRate = costValue > 0 ? (totalReturn / costValue) * 100 : 0;

	    this._holdingParams = { shares, buyPrice };

	    this.setData({
	      holdingData: {
	        shares: shares.toFixed(2),
	        buyPrice: buyPrice.toFixed(4),
	        marketValue: marketValue.toFixed(2),
	        todayProfit: todayProfit.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
      },
      ...this._rebateField({ buyPrice: buyPrice.toFixed(4) }),
    });
    this._rawHolding = null;
  },

  recalcHoldingData() {
    if (!this._holdingParams) return;
    const { shares, buyPrice } = this._holdingParams;
    const { nav, estimatedNav, actualNav } = this.data;
    const yesterdayNav = parseFloat(nav || actualNav || estimatedNav || 0);
    if (!yesterdayNav) return;

    const currentNav = calc.selectNav(yesterdayNav, actualNav, estimatedNav);
    const marketValue = currentNav * shares;
    let todayProfit;
    if (currentNav !== yesterdayNav) {
      todayProfit = (currentNav - yesterdayNav) * shares;
    } else {
      const estRate = this._todayEstRate(); // 无今日估值 → 0，同首页口径
      todayProfit = estRate ? yesterdayNav * estRate / 100 * shares : 0;
    }
    const costValue = buyPrice * shares;
    const totalReturn = marketValue - costValue;
    const totalReturnRate = costValue > 0 ? (totalReturn / costValue) * 100 : 0;

    this.setData({
      holdingData: {
        shares: shares.toFixed(2),
        buyPrice: buyPrice.toFixed(4),
        marketValue: marketValue.toFixed(2),
        todayProfit: todayProfit.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
      },
      ...this._rebateField({ buyPrice: buyPrice.toFixed(4) }),
    });
  },

  onToggleTransactions() {
    const show = !this.data.showTransactions;
    this.setData({ showTransactions: show, scrollToTx: show ? "txSection" : "" });
  },
  onScrollRefresh() {
    // 防重入：已有 fetch 进行中直接收回动画，避免双刷
    if (this._fetchingAll) {
      this.setData({ scrollRefreshing: false });
      return;
    }
    this.setData({ scrollRefreshing: true });
    this.fetchAll().finally(() => {
      this.setData({ scrollRefreshing: false });
    });
  },
  onShowMore() {
    // 分页展示：默认 5 条（用户拍板），每次追加 20 条（displayHistory 独立于 navHistory）
    const n = this.data.displayCount + 20;
    this.setData({ displayCount: n, displayHistory: this.data.navHistory.slice(0, n) });
  },
  onShowLess() { this.setData({ displayCount: 5, displayHistory: this.data.navHistory.slice(0, 5) }); },
  async onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab }, () => {
      if (tab === 'trend') { this._chartAnimated = false; this.drawChart(); } // 切回走势：重播进场动画
    });
    if ((tab === 'holdings' || tab === 'profile') && (!this.data.profile || this._profileStale) && !this.data.profileLoading) {
      this._profileStale = false;
      this.setData({ profileLoading: true });
      await this.fetchProfile();
      this.setData({ profileLoading: false, profileLoaded: true });
    }
  },
  onRetryProfile() {
    if (this.data.profileLoading) return;
    this.setData({ profileLoading: true });
    this.fetchProfile().finally(() => this.setData({ profileLoading: false }));
  },

  // 同一基金多笔（多账户）时先选是哪一笔：卡片与头部是合计口径，但修改/校准只能落到某一笔。
  // 直接取第一笔会把"合计"和"某一笔"混在一屏里（修改回显不是总金额；校准会把合计份额写进第一笔）
  _pickHoldingRecord() {
    const list = this.data.holdingRecords || [];
    if (list.length <= 1) return Promise.resolve(list[0] || null);
    return new Promise((resolve) => {
      wx.showActionSheet({
        itemList: list.map((r) => `${r.platform} · ${r.shares} 份 · ¥${r.marketValue}`),
        success: (res) => resolve(list[res.tapIndex] || null),
        fail: () => resolve(null),
      });
    });
  },

  // ===== 数据校准（P0-3）：修正 OCR/推算的份额与成本误差，纯数字修正不产生交易记录 =====
  async onCalibrate() {
    const multi = (this.data.holdingRecords || []).length > 1;
    const rec = await this._pickHoldingRecord();
    if (multi && !rec) return; // 多笔时取消选择 = 放弃本次校准
    const h = this.data.holdingData || {};
    this._calId = (rec && rec.id) || this.data.holdingId;
    // 单笔：沿用卡片口径预填（含 OCR 缺份额时按市值反推的估算值）；多笔：只能用选中那一笔自己的数字
    this.setData({
      showCalibrate: true,
      calShares: String((multi && rec ? rec.shares : h.shares) || ""),
      calPrice: String((multi && rec ? rec.buyPrice : h.buyPrice) || ""),
      calLabel: multi && rec ? rec.platform : "",
    });
  },
  onCalSharesInput(e) { this.setData({ calShares: e.detail.value }); },
  onCalPriceInput(e) { this.setData({ calPrice: e.detail.value }); },
  onCalibrateCancel() { this.setData({ showCalibrate: false, calLabel: "" }); },
  async onCalibrateSave() {
    const shares = parseFloat(this.data.calShares);
    const buyPrice = parseFloat(this.data.calPrice);
    if (!(shares > 0) || !(buyPrice > 0)) { wx.showToast({ title: "请输入有效的份额与净值", icon: "none" }); return; }
    const calId = this._calId || this.data.holdingId;
    if (!calId) { wx.showToast({ title: "持仓数据未就绪", icon: "none" }); return; }
    this.setData({ calSaving: true });
    try {
      // 市值/收益按官方净值重算，口径与 add-holding/adjust-holding 一致
      const nav = parseFloat(this.data.actualNav || this.data.nav) || 0;
      const buyAmount = +(shares * buyPrice).toFixed(2);
      const marketValue = nav > 0 ? +(shares * nav).toFixed(2) : buyAmount;
      const holdingReturn = +(marketValue - buyAmount).toFixed(2);
      await api.holdingUpdate(calId, {
        shares: parseFloat(shares.toFixed(4)),
        buyPrice: parseFloat(buyPrice.toFixed(4)),
        buyAmount, marketValue, holdingReturn,
      });
      // 本地即时生效 + 首页等列表页走强制刷新
      if ((this.data.holdingRecords || []).length > 1) {
        // 多笔：合计口径随之变化，重新拉明细再算（不能拿单笔数字去改合计对象）
        await this.checkHolding();
        this.enrichHoldingData();
      } else {
        // 单笔：_rawHolding 会被 enrichHoldingData 尾部消费置空（旧写法此分支恒死——
        // 校准后卡片保持旧值，还把旧值回写缓存）。从唯一持仓行重建原始对象再套用校准值
        if (!this._rawHolding) {
          const rec = (this.data.holdingRecords || [])[0];
          const rShares = Number((rec && rec.shares) || this.data.holdingData.shares) || 0;
          const rPrice = Number((rec && rec.buyPrice) || this.data.holdingData.buyPrice) || 0;
          const rMv = Number(this.data.holdingData.marketValue) || 0;
          this._rawHolding = {
            shares: rShares, buyPrice: rPrice,
            buyAmount: +(rShares * rPrice).toFixed(2), marketValue: rMv,
            holdingReturn: +(rMv - rShares * rPrice).toFixed(2),
          };
        }
        Object.assign(this._rawHolding, { shares, buyPrice, buyAmount, marketValue, holdingReturn });
        this.enrichHoldingData();
      }
      wx.removeStorageSync("portfolio_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
      this._saveCache();
      this.setData({ showCalibrate: false, calLabel: "" });
      wx.showToast({ title: "已校准", icon: "success" });
    } catch (e) {
      console.error("数据校准保存失败:", e);
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
    this.setData({ calSaving: false });
  },
  onImportScreenshot() {
    wx.showActionSheet({
      itemList: ["从相册选择"],
      success: () => {
        wx.chooseMedia({
          count: 1, mediaType: ["image"], sourceType: ["album"], sizeType: ["compressed"],
          success: (mediaRes) => {
            if (!mediaRes.tempFiles || !mediaRes.tempFiles[0]) return; // iOS 取消/异常守卫
            this.doOCR(mediaRes.tempFiles[0].tempFilePath);
          },
        });
      },
    });
  },

  async doOCR(tempPath) {
    wx.showLoading({ title: "识别中..." });
    try {
      const up = await wx.cloud.uploadFile({ cloudPath: `holdings/${Date.now()}.jpg`, filePath: tempPath });
      const res = await api.ocrScreenshot(up.fileID);
      wx.hideLoading();
      if (res.result && res.result.code === 0 && res.result.data) {
        const d = res.result.data;
        const holdings = d.holdings || [];
        if (holdings.length === 0) {
          wx.hideLoading();
          wx.showModal({
            title: '未识别到基金信息',
            content: '请确认截图清晰度，或搜索基金代码手动添加',
            confirmText: '去搜索',
            cancelText: '好',
            success: (res) => {
              if (res.confirm) wx.navigateTo({ url: '/pages/search/index' });
            },
          });
          return;
        }
        // 取第一只基金，检查是否匹配当前详情页
        const h = holdings[0];
        if (h.fundName && h.fundName.includes(this.data.fundName)) {
          // 直接添加持仓
          wx.showModal({
            title: "识别结果",
            content: `${h.fundName}\n市值: ${h.marketValue || "--"}\n收益: ${h.holdingReturn || "--"}`,
            confirmText: "添加持仓",
            success: async (mr) => {
              if (!mr.confirm) return;
              wx.showLoading({ title: "添加中..." });
              await api.holdingAdd({
                fundCode: this.data.fundCode,
                fundName: this.data.fundName,
                buyPrice: parseFloat(h.buyPrice || 0),
                shares: parseFloat(h.shares || 0),
                marketValue: parseFloat(h.marketValue || 0),
                holdingReturn: parseFloat(h.holdingReturn || 0),
                buyAmount: parseFloat(h.buyAmount || 0),
              });
              wx.hideLoading();
              wx.showToast({ title: "添加成功", icon: "success" });
              wx.removeStorageSync("portfolio_cache");
              this.fetchAll();
            },
          });
        } else {
          // 识别到但名称不匹配
          wx.showModal({
            title: "识别结果",
            content: `识别到 ${holdings.length} 个基金，但名称与当前基金不匹配`,
            showCancel: false,
          });
        }
      } else {
        wx.hideLoading();
        wx.showModal({
          title: '识别失败',
          content: '服务暂不可用，可搜索基金代码手动添加',
          confirmText: '去搜索',
          cancelText: '知道了',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: '/pages/search/index' });
          },
        });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showModal({
        title: '识别失败',
        content: '网络异常，可搜索基金代码手动添加',
        confirmText: '去搜索',
        cancelText: '知道了',
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: '/pages/search/index' });
        },
      });
    }
  },

  async onAddHolding() {
    const { fundCode, fundName, hasHolding, holdingId } = this.data;
    if (hasHolding) {
      // 多笔（多账户）时先选改哪一笔：卡片显示的是合计，直接取第一笔会让人以为回显错了
      const rec = await this._pickHoldingRecord();
      const id = (rec && rec.id) || holdingId;
      if (!id) { wx.showToast({ title: "持仓数据未就绪", icon: "none" }); return; }
      wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
    } else {
      wx.navigateTo({ url: `/pages/add-holding/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName)}` });
    }
  },
  onCompare() {
    const { fundCode, fundName } = this.data;
    if (!fundCode || fundCode === "undefined") {
      wx.showToast({ title: "基金信息异常", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/subpackages/analysis/pages/fund-compare/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName || "")}`,
      fail: (err) => {
        console.error("跳转对比页失败:", err);
        wx.showToast({ title: err.errMsg || "跳转失败", icon: "none" });
	      },
	    });
	  },

  // 复盘中心·温度回测 tab（聚合统计，与单基金温度同源口径）
  onTempBacktest() {
    wx.navigateTo({ url: "/subpackages/analysis/pages/review/index?tab=temp" });
  },

  // 复盘中心·回本中心 tab（带当前基金上下文深链）
  onRecoveryCenter() {
    const { fundCode, fundName } = this.data;
    if (!fundCode || fundCode === "undefined") {
      wx.showToast({ title: "基金信息异常", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/subpackages/analysis/pages/review/index?tab=recover&fundCode=${fundCode}&fundName=${encodeURIComponent(fundName || "")}`,
    });
  },

  // ---- 定投回测 ----
  onToggleDCA() {
    // 易用化：首次展开即填好默认值（月投 1000 / 起始近3年），用户直接点"开始模拟"就能出结果
    if (!this.data.showDCA && !this.data.dcaStartDate) {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 3);
      this.setData({
        dcaAmount: this.data.dcaAmount || "1000",
        dcaStartDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      });
    }
    this.setData({ showDCA: !this.data.showDCA });
  },
  // 快捷周期：近1年/3年/5年 一键填充起始月
  onDCAPeriod(e) {
    const years = parseFloat(e.currentTarget.dataset.years);
    if (!years) return;
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    this.setData({ dcaStartDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` });
  },
  onDCAAmount(e) { this.setData({ dcaAmount: e.detail.value }); },
  onDCAStartDate(e) { this.setData({ dcaStartDate: e.detail.value }); },
  async onRunDCA() {
    const { fundCode, dcaAmount, dcaStartDate } = this.data;
    if (!dcaAmount || !dcaStartDate) {
      wx.showToast({ title: "请填写金额和起始时间", icon: "none" });
      return;
    }
    const [startYear, startMonth] = dcaStartDate.split("-");
    this.setData({ dcaLoading: true, dcaResult: null });
    try {
      const res = await wx.cloud.callFunction({
        name: "dcaBacktest",
        data: { fundCode, monthlyAmount: parseFloat(dcaAmount), startYear, startMonth, monthlyDay: 1 },
      });
      if (res.result && res.result.code === 0) {
        this.setData({ dcaResult: res.result.data, dcaText: this._dcaText(res.result.data) });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "回测失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "回测失败", icon: "none" });
    }
    this.setData({ dcaLoading: false });
  },
  // 结果解读：一句白话 + 单位投入价值（历史演算口径，合规注明不代表未来）
  _dcaText(d) {
    if (!d || !d.totalInvested) return "";
    const per = (d.currentValue / d.totalInvested).toFixed(2);
    return `按月定投 ${d.months} 期、每 1 元投入如今价值 ${per} 元（按年化 ${d.annualizedReturn}% 演算，历史数据不代表未来收益）`;
  },

  // ---- 费用黑洞 ----
  onToggleFee() {
    const show = !this.data.showFee;
    this.setData({ showFee: show });
    if (show && !this.data.feeData && this.data.profile) this.calcFeeData();
  },
  onToggleTurnover() {
    this.setData({ showTurnover: !this.data.showTurnover });
  },
  calcFeeData() {
    const p = this.data.profile;
    const mgmt = parseFloat(p.mgmtFee) || 0;
    const trust = parseFloat(p.trustFee) || 0;
    const sales = parseFloat(p.salesFee) || 0;
    const totalRate = mgmt + trust + sales;
    if (totalRate <= 0) return;
    const principal = 100000, annualReturn = 0.08;
    const calc = (years) => {
      const withFee = principal * Math.pow(1 + annualReturn - totalRate / 100, years);
      const noFee = principal * Math.pow(1 + annualReturn, years);
      const lost = noFee - withFee;
      return {
        withFee: Math.round(withFee).toLocaleString(),
        noFee: Math.round(noFee).toLocaleString(),
        lost: Math.round(lost).toLocaleString(),
        pct: (lost / noFee * 100).toFixed(1),
      };
    };
    this.setData({
      totalFeeRate: totalRate.toFixed(2) + ' (管理' + mgmt.toFixed(2) + '% + 托管' + trust.toFixed(2) + '%' + (sales > 0 ? ' + 销售' + sales.toFixed(2) + '%' : '') + ')',
      feeData: { yr5: calc(5), yr10: calc(10), yr20: calc(20) },
    });
  },

});
