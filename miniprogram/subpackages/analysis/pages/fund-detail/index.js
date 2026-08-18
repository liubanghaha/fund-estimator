const api = require("../../../../utils/api");
const calc = require("../../../../utils/calculator");
const chart = require("../../../../utils/chart");

const CACHE_PREFIX = "fund_detail_cache_";
const CACHE_TTL = 60000;  // 交易时段缓存有效期 60 秒
const CACHE_TTL_IDLE = 30 * 60 * 1000;  // 盘外缓存有效期 30 分钟：长时间未进入也能秒开

Page({
  data: {
    fundCode: "", fundName: "", loading: true, errorMsg: "",
    nav: null, estimatedNav: null, estimatedChangeRate: null, estimateTime: "",
    actualNav: "", actualDate: "", actualChangeRate: null,
    navHistory: [], displayHistory: [],
    todayReturn: null, weekReturn: null, monthReturn: null,
    threeMonthReturn: null, sixMonthReturn: null, yearReturn: null, threeYearReturn: null,
    profile: null, manager: null, holdings: [], quarterLabel: "", prevDataIncomplete: false,
    hasHolding: false, holdingId: null, holdingData: null, followed: false, activeTab: "trend",
    showAllHistory: false,
    isTrading: false,
    chartPeriod: '1M',
    chartTxMap: {},
    transactionList: [],
    showTransactions: false,
    scrollToTx: "",
    quarterNet: 0,
    profileLoading: false, profileLoaded: false,
    // 定投回测
    showDCA: false, dcaAmount: '', dcaStartDate: '', dcaLoading: false, dcaResult: null,
    // 风险指标 + 费用 + 估值温度
    riskMetrics: null, showFee: false, feeData: null, totalFeeRate: '', peTemp: null,
    turnoverRates: [],
    showTurnover: false,
    scrollRefreshing: false,
    showExited: false,
  },

  onLoad(options) {
    if (!options.fundCode) return;
    const fundName = options.fundName ? decodeURIComponent(options.fundName) : "基金详情";
    this.setData({ fundCode: options.fundCode, fundName });
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
        wx.setNavigationBarTitle({ title: fundName });
    this._firstLoad = true;
    const { windowWidth } = wx.getSystemInfoSync();
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
    // 缓存新鲜（交易 60s / 盘外 30min）时直接复用，无需自动刷新动画
    const cached = wx.getStorageSync(CACHE_PREFIX + options.fundCode);
    const ttl = this._isTradingHours() ? CACHE_TTL : CACHE_TTL_IDLE;
    const cacheFresh = cached && cached.history && cached.history.length && (Date.now() - (cached.ts || 0) < ttl);
    // 缓存缺失/过期时自动调起下拉刷新动画，让用户感知数据更新（onReady 后再调起）
    this._pendingAutoRefresh = !this._skipCache && !cacheFresh;
    // 立即加载（缓存秒开 + 过期则拉新），不依赖下拉动画链路，避免页面卡加载
    this.fetchAll();
  },

  // 首次渲染完成后自动调起下拉刷新动画（过早调用 startPullDownRefresh 无效）
  onReady() {
    if (this._pendingAutoRefresh) {
      this._pendingAutoRefresh = false;
      setTimeout(() => wx.startPullDownRefresh(), 500);
    }
  },

  onShow() {
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
            const e = estRes.result.data;
            const actualCR = e.actualChangeRate != null ? e.actualChangeRate : this.data.actualChangeRate;
            this.setData({
              nav: e.nav != null ? e.nav : this.data.nav,
              estimatedNav: e.estimatedNav != null ? e.estimatedNav : this.data.estimatedNav,
              estimatedChangeRate: e.estimatedChangeRate != null ? e.estimatedChangeRate : this.data.estimatedChangeRate,
              estimateTime: e.estimateTime || this.data.estimateTime,
              actualNav: e.actualNav ? e.actualNav.toFixed(4) : this.data.actualNav,
              actualChangeRate: actualCR,
              displayChangeRate: calc.selectChangeRate(
                e.nav != null ? e.nav : this.data.nav,
                e.actualNav != null ? e.actualNav : parseFloat(this.data.actualNav),
                e.estimatedChangeRate, actualCR),
              actualDate: e.actualDate || this.data.actualDate,
              peTemp: e.peTemp || this.data.peTemp,
            });
            // 最新一天净值合并进历史（估值接口自带 actualDate/actualNav，无需单独拉历史接口）
            if (e.actualDate && e.actualNav) {
              const merged = this._mergeHistory(cached.history, [{
                date: e.actualDate, nav: e.actualNav,
                changeRate: e.actualChangeRate != null ? e.actualChangeRate : 0,
              }]);
              this.setData({
                navHistory: merged,
                displayHistory: merged.slice(0, 10),
                showAllHistory: false,
              });
              this.calcReturns(merged);
            }
          }
        } else {
          // 首次无缓存历史 → 全量概览（一次拿 260 天历史 + 估值 + 温度；档案/持仓由切 Tab 懒加载）
          const [overviewRes] = await Promise.all([
            api.fetchFundOverview(this.data.fundCode),
            this.checkFollow().catch(() => {}),
            this.checkHolding().catch(() => {}),
            this.fetchTransactions().catch(() => {}),
          ]);
          if (overviewRes.result && overviewRes.result.code === 0) {
            const d = overviewRes.result.data;
            const actualCR = d.actualChangeRate != null ? d.actualChangeRate : this.data.actualChangeRate;
            const yesterdayNav = d.nav != null ? d.nav : this.data.nav;
            const actNavRaw = d.actualNav != null ? d.actualNav : parseFloat(this.data.actualNav);
            const displayCR = calc.selectChangeRate(yesterdayNav, actNavRaw, d.estimatedChangeRate, actualCR);
            this.setData({
              nav: d.nav, estimatedNav: d.estimatedNav,
              estimatedChangeRate: d.estimatedChangeRate, estimateTime: d.estimateTime,
              fundName: this.data.fundName || d.fundName || "",
              actualNav: d.actualNav ? d.actualNav.toFixed(4) : this.data.actualNav,
              actualChangeRate: actualCR,
              displayChangeRate: displayCR,
              peTemp: d.peTemp || this.data.peTemp,
            });
            if (d.history && d.history.length > 0) {
              this.setData({
                navHistory: d.history,
                displayHistory: d.history.slice(0, 10),
                showAllHistory: false,
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
        await Promise.all([this.checkFollow(), this.checkHolding(), this.fetchTransactions()]);
      }
      this.updateDisplay();
      this.enrichHoldingData();
      this._saveCache();
      if (this.data.loading) {
        this.setData({ loading: false }, () => this.drawChart());
      } else {
        this.drawChart();
      }
    } catch (e) {
      this.setData({ loading: false, errorMsg: "加载失败" });
    }
    this._fetchingAll = false;
  },

  // ============ 缓存 ============

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

  _isTradingHours() {
    const now = new Date();
    const day = now.getDay();
    if (day < 1 || day > 5) return false;
    const total = now.getHours() * 60 + now.getMinutes();
    return (total >= 570 && total < 690) || (total >= 780 && total < 900);
  },

  _restoreCache() {
    try {
      const cached = wx.getStorageSync(CACHE_PREFIX + this.data.fundCode);
      if (!cached || !cached.history || !cached.history.length) return false;
      // 跨日缓存不秒开：净值/涨跌按日变化，展示昨天数据没有意义，直接拉新
      // （同日缓存才渲染：新鲜时秒开，过期时渲染后后台刷新）
      const sameDay = cached.actualDate === calc.formatDate(new Date());
      if (!sameDay) return false;
      const ttl = this._isTradingHours() ? CACHE_TTL : CACHE_TTL_IDLE;
      const fresh = Date.now() - (cached.ts || 0) < ttl;
      this.setData({
        loading: false,
        fundName: this.data.fundName || cached.fundName || "",
        nav: cached.nav, estimatedNav: cached.estimatedNav,
        estimatedChangeRate: cached.estimatedChangeRate, estimateTime: cached.estimateTime,
        actualNav: cached.actualNav, actualChangeRate: cached.actualChangeRate,
        actualDate: cached.actualDate, displayChangeRate: cached.displayChangeRate,
        peTemp: cached.peTemp || null,
        navHistory: cached.history,
        displayHistory: (cached.history || []).slice(0, 10),
        showAllHistory: false,
        // 持仓区数据一并秒开（checkHolding 网络请求返回后会自动覆盖更新）
        holdingData: cached.holdingData || null,
      }, () => {
        this.calcReturns(cached.history);
        this.updateDisplay();
        // 缓存含原始持仓时直接用缓存数据计算持仓区，避免等 checkHolding 网络请求出现空白窗口
        if (cached.rawHolding) {
          this._rawHolding = cached.rawHolding;
          this.enrichHoldingData();
        }
        this.drawChart();
      });
      return fresh;
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
        history: this.data.navHistory,
        holdingData: this.data.holdingData,
        rawHolding: this._rawHolding || this._lastRawHolding,
        ts: Date.now(),
      });
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
        const itemList = [...groups, "不分组", "新建分组"];
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
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const min = now.getMinutes();
    const isTrading = day >= 1 && day <= 5 &&
      (hour > 9 || (hour === 9 && min >= 0)) &&
      (hour < 15 || (hour === 15 && min <= 30));
    const displayChangeRate = calc.selectChangeRate(
      this.data.nav, this.data.actualNav,
      this.data.estimatedChangeRate, this.data.actualChangeRate,
    );
    const isNavUpdated = this.data.actualDate === calc.formatDate(now);
    this.setData({ isTrading, displayChangeRate, isNavUpdated });
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
          estimatedChangeRate: d.estimatedChangeRate, estimateTime: d.estimateTime,
          fundName: this.data.fundName || d.fundName || "",
          actualNav: d.actualNav ? d.actualNav.toFixed(4) : this.data.actualNav,
          actualChangeRate: actualCR,
          displayChangeRate: displayCR,
          peTemp: d.peTemp || this.data.peTemp,
        });
      }
    } catch (e) { console.error("获取估值失败:", e); }
  },

  async fetchHistory(days = 250) {
    try {
      const res = await api.fetchFundNAVHistory(this.data.fundCode, days);
      if (res.result && res.result.code === 0) {
        const history = res.result.data;
        if (history.length > 0) {
          this.setData({
            navHistory: history,
            displayHistory: history.slice(0, 10),
            showAllHistory: false,
            actualNav: this.data.actualNav || (history[0].nav != null ? history[0].nav.toFixed(4) : ""),
            actualDate: history[0].date,
            actualChangeRate: this.data.actualChangeRate != null ? this.data.actualChangeRate : (history[0].changeRate || 0),
          });
          this.calcReturns(history);
        }
      }
    } catch (e) { console.error("获取历史净值失败:", e); }
  },

  async fetchProfile() {
    try {
      const res = await api.fetchFundProfile(this.data.fundCode);
      if (res.result && res.result.code === 0) {
        let p = res.result.data.profile || {};
        if (p.fundSize) { p.fundSizeText = (p.fundSize / 100000000).toFixed(2) + '亿'; }
        else { p.fundSizeText = '--'; }
        const riskMap = { '1': '低风险', '2': '中低风险', '3': '中风险', '4': '中高风险', '5': '高风险' };
        p.riskText = riskMap[p.riskLevel] || p.riskLevel || '--';

        const holdings = res.result.data.holdings || [];
        // 先渲染持仓列表（今日涨跌显示 --），股票行情异步补拉
        const exited = res.result.data.exited || [];
        this.setData({ profile: p, manager: res.result.data.manager, holdings, exited, quarterLabel: res.result.data.quarterLabel || '', prevDataIncomplete: !!res.result.data.prevDataIncomplete, feeData: null, showFee: false, turnoverRates: res.result.data.turnoverRates || [] });

        // 后台拉取股票行情（仅补云函数未返回的），不阻塞渲染
        const missingQuotes = holdings.filter(h => h.stockChangeRate == null);
        if (missingQuotes.length > 0) {
          this._fetchStockQuotes(missingQuotes).then(quotes => {
            if (!Object.keys(quotes).length) return;
            const updated = holdings.map(h => ({
              ...h,
              stockChangeRate: quotes[h.stockCode] != null ? quotes[h.stockCode] : h.stockChangeRate,
              isHK: h.stockCode && h.stockCode.length === 5,
            }));
            this.setData({ holdings: updated });
          });
        }
      }
    } catch (e) { console.error("获取基金档案失败:", e); }
  },

  // 兜底：客户端拉取股票行情（当云函数未返回时）
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
          url: `https://push2his.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f170`,
          header: { Referer: "https://quote.eastmoney.com/" },
          success(res) {
            try {
              const d = (res.data && res.data.data) || {};
              map[code] = d.f170 != null ? +(d.f170 / 100).toFixed(2) : null;
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
    const dd = calc.calcMaxDrawdown(history);
    const vol = calc.calcVolatility(history);
    const sharpe = calc.calcSharpe(history);
    const riskMetrics = dd.drawdown != null ? {
      maxDrawdown: dd.drawdown,
      ddPeakDate: dd.peakDate, ddTroughDate: dd.troughDate,
      volatility: vol != null ? vol : '--',
      sharpe: sharpe != null ? sharpe : '--',
    } : null;
    this.setData({
      todayReturn: displayChangeRate != null ? displayChangeRate : (r.day || 0),
      weekReturn: r.week, monthReturn: r.month, threeMonthReturn: r.threeMonth,
      sixMonthReturn: r.sixMonth, yearReturn: r.year, threeYearReturn: r.threeYear,
      riskMetrics,
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
    const color = hd && parseFloat(hd.totalReturn) >= 0 ? '#E4393C' : '#2E8B57';
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
      const ctx = chart.drawLineChart(canvas, opts);
      if (!ctx) return;

      const txMap = this.data.chartTxMap || {};
      if (Object.keys(txMap).length > 0) {
        const p = opts.padding;
        const pw = rw - p.left - p.right, ph = rh - p.top - p.bottom;
        const vals = data.map(d => d.value);
        const min = Math.min(...vals), max = Math.max(...vals);
        const range = max - min || 0.01;
        const yMin = min - range * 0.15, yMax = max + range * 0.15;
        const xp = (i) => p.left + (pw / (data.length - 1)) * i;
        const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
        data.forEach((d, i) => {
          const tx = txMap[d.date];
          if (!tx) return;
          const x = xp(i), y = yp(d.value);
          if (tx.buys > 0 && tx.sells > 0) {
            ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI);
            ctx.strokeStyle = '#2E8B57'; ctx.lineWidth = 1; ctx.stroke();
            ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI);
            ctx.fillStyle = '#E4393C'; ctx.fill();
          } else if (tx.buys > 0) {
            ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = '#E4393C'; ctx.fill();
          } else if (tx.sells > 0) {
            ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = '#2E8B57'; ctx.fill();
          }
        });
      }
      this._baseData = { data, opts, canvas };
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

    const dpr = wx.getSystemInfoSync().pixelRatio;
    canvas.width = opts.w * dpr;
    canvas.height = opts.h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

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

    chart._drawFastLine(ctx, chart._lastDraw, opts);
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
    if (this.data.navHistory.length < neededDays) {
      await this.fetchHistory(neededDays + 50);
    }
    this.drawChart();
  },

  async checkHolding() {
    try {
      const res = await api.holdingCheck(this.data.fundCode);
      if (res.result && res.result.code === 0 && res.result.data) {
        this._rawHolding = res.result.data;
        this.setData({ hasHolding: true, holdingId: res.result.data._id });
        return;
      }
    } catch (e) { console.error("checkHolding 客户端失败:", e); }
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
      this.setData({ chartTxMap: map, transactionList: txns, quarterNet });
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
	      const estRate = parseFloat(this.data.estimatedChangeRate);
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
      const estRate = parseFloat(this.data.estimatedChangeRate);
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
    });
  },

  onRefresh() {
    const show = !this.data.showTransactions;
    this.setData({ showTransactions: show, scrollToTx: show ? "txSection" : "" });
  },
  onPullDownRefresh() {
    this.fetchAll().finally(() => wx.stopPullDownRefresh());
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
  onShowMore() { this.setData({ showAllHistory: true, displayHistory: this.data.navHistory }); },
  onShowLess() { this.setData({ showAllHistory: false, displayHistory: this.data.navHistory.slice(0, 10) }); },
  onToggleExited() { this.setData({ showExited: !this.data.showExited }); },
  async onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab }, () => {
      if (tab === 'trend') this.drawChart();
    });
    if ((tab === 'holdings' || tab === 'profile') && !this.data.profile && !this.data.profileLoading) {
      this.setData({ profileLoading: true });
      await this.fetchProfile();
      this.setData({ profileLoading: false, profileLoaded: true });
    }
  },
  onImportScreenshot() {
    wx.showActionSheet({
      itemList: ["从相册选择"],
      success: () => {
        wx.chooseMedia({
          count: 1, mediaType: ["image"], sourceType: ["album"], sizeType: ["compressed"],
          success: (mediaRes) => { this.doOCR(mediaRes.tempFiles[0].tempFilePath); },
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

  onAddHolding() {
    const { fundCode, fundName, hasHolding, holdingId } = this.data;
    if (hasHolding && holdingId) {
      wx.navigateTo({ url: `/pages/add-holding/index?id=${holdingId}` });
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

  // ---- 定投回测 ----
  onToggleDCA() {
    this.setData({ showDCA: !this.data.showDCA });
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
        this.setData({ dcaResult: res.result.data });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "回测失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "回测失败", icon: "none" });
    }
    this.setData({ dcaLoading: false });
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
