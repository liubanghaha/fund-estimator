const api = require("../../utils/api");

Page({
  data: {
    fundCode: "", fundName: "", loading: true, errorMsg: "",
    nav: null, estimatedNav: null, estimatedChangeRate: null, estimateTime: "",
    actualNav: "", actualDate: "", actualChangeRate: null,
    navHistory: [],
    todayReturn: null, weekReturn: null, monthReturn: null,
    threeMonthReturn: null, sixMonthReturn: null, yearReturn: null,
    profile: null, manager: null, holdings: [],
    hasHolding: false, holdingData: null, followed: false, activeTab: "trend",
    showAllHistory: false,
    isTrading: false,
    chartPeriod: '1M',
  },

  onLoad(options) {
    const fundName = options.fundName ? decodeURIComponent(options.fundName) : "基金详情";
    this.setData({ fundCode: options.fundCode || "", fundName });
    wx.setNavigationBarTitle({ title: fundName });
    this.fetchAll();
  },

  async fetchAll() {
    this.setData({ loading: true, errorMsg: "" });
    try {
      await Promise.all([this.fetchEstimate(), this.fetchHistory(), this.checkFollow(), this.checkHolding()]);
      this.updateDisplay();
      this.enrichHoldingData();
      this.setData({ loading: false });
      setTimeout(() => this.drawChart(), 500);
    } catch (e) {
      this.setData({ loading: false, errorMsg: "加载失败" });
    }
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
        const res = await api.watchlistAdd(fundCode, fundName);
        if (res.result && res.result.code === 0) {
          this.setData({ followed: true });
          wx.showToast({ title: "已加自选", icon: "success" });
        } else {
          wx.showToast({ title: res.result ? res.result.msg : "操作失败", icon: "none" });
        }
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
    const isTrading = day >= 1 && day <= 5 && (hour > 9 || (hour === 9 && min >= 30)) && hour < 15;
    this.setData({ isTrading });
  },

  async fetchEstimate() {
    try {
      const res = await api.fetchFundEstimate(this.data.fundCode);
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        this.setData({
          nav: d.nav, estimatedNav: d.estimatedNav,
          estimatedChangeRate: d.estimatedChangeRate, estimateTime: d.estimateTime,
          fundName: this.data.fundName || d.fundName || "",
          actualNav: d.actualNav ? d.actualNav.toFixed(4) : this.data.actualNav,
          actualChangeRate: d.actualChangeRate != null ? d.actualChangeRate : this.data.actualChangeRate,
        });
      }
    } catch (e) { console.error("获取估值失败:", e); }
  },

  async fetchHistory(days = 80) {
    try {
      const res = await api.fetchFundNAVHistory(this.data.fundCode, days);
      if (res.result && res.result.code === 0) {
        const history = res.result.data;
        if (history.length > 0) {
          this.setData({
            navHistory: history,
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
        this.setData({
          profile: p, manager: res.result.data.manager,
          holdings: res.result.data.holdings || [],
        });
      }
    } catch (e) { console.error("获取基金档案失败:", e); }
  },

  calcReturns(history) {
    const latest = history[0].nav;
    const g = (d) => { if (history.length <= d) return null; const nav = history[d] && history[d].nav; if (!nav) return null; return parseFloat(((latest - nav) / nav * 100).toFixed(2)); };
    this.setData({
      todayReturn: history[0].changeRate || 0,
      weekReturn: g(4), monthReturn: g(19), threeMonthReturn: g(64),
      sixMonthReturn: g(129), yearReturn: g(249),
    });
  },

  drawChart() {
    const history = this.data.navHistory;
    if (history.length < 2) return;
    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260 };
    const days = PERIOD_DAYS[this.data.chartPeriod] || 260;
    const sliced = history.slice(0, days);
    if (sliced.length < 2) return;
    const ctx = wx.createCanvasContext('navCanvas', this);
    const w = 340, h = 180;
    const data = [...sliced].reverse();
    const navs = data.map(d => d.nav);
    const minNav = Math.min(...navs), maxNav = Math.max(...navs);
    const range = maxNav - minNav || 0.01;
    const pad = range * 0.15;
    const yMin = minNav - pad, yMax = maxNav + pad;
    const m = { top: 16, right: 8, bottom: 22, left: 56 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (data.length - 1)) * i;
    const yp = (nav) => m.top + ph - ((nav - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, w, h);

    const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
    gradient.addColorStop(0, 'rgba(228,57,60,0.12)');
    gradient.addColorStop(1, 'rgba(228,57,60,0.01)');
    ctx.beginPath();
    data.forEach((d, i) => { const x = xp(i), y = yp(d.nav); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.lineTo(xp(data.length - 1), h - m.bottom);
    ctx.lineTo(xp(0), h - m.bottom);
    ctx.closePath();
    ctx.setFillStyle(gradient);
    ctx.fill();

    ctx.beginPath();
    data.forEach((d, i) => { const x = xp(i), y = yp(d.nav); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.setStrokeStyle('#E4393C');
    ctx.setLineWidth(1.5);
    ctx.stroke();

    ctx.setFillStyle('#999');
    ctx.setFontSize(9);
    ctx.setTextAlign('right');
    ctx.setTextBaseline('middle');
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(4), m.left - 4, yp(val));
    }
    ctx.setTextAlign('center');
    ctx.setTextBaseline('top');
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      ctx.fillText(data[idx].date.slice(5), xp(idx), h - m.bottom + 4);
    }
    ctx.draw();
  },

  async onChartPeriod(e) {
    const period = e.currentTarget.dataset.period;
    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260 };
    const neededDays = PERIOD_DAYS[period] || 260;
    this.setData({ chartPeriod: period });
    if (this.data.navHistory.length < neededDays) {
      await this.fetchHistory(Math.min(neededDays + 20, 280));
    }
    this.drawChart();
  },

  async checkHolding() {
    try {
      const db = wx.cloud.database();
      const userInfo = wx.getStorageSync("userInfo") || {};
      const openid = userInfo.openid || "";
      const res = await db.collection("holdings")
        .where({ _openid: openid, fundCode: this.data.fundCode })
        .get();
      if (res.data && res.data.length > 0) {
        this._rawHolding = res.data[0];
        this.setData({ hasHolding: true });
      }
    } catch (e) { console.error("检查持仓失败:", e); }
  },

  enrichHoldingData() {
    if (!this._rawHolding) return;
    const raw = this._rawHolding;
    const { nav, estimatedNav, actualNav } = this.data;
    const currentNav = parseFloat(estimatedNav || actualNav || nav || 0);
    const yesterdayNav = parseFloat(nav || 0);
    if (!currentNav || !yesterdayNav) return;

    const shares = raw.shares || raw.amount || 0;
    const buyPrice = raw.nav || raw.buyPrice || 0;
    const marketValue = currentNav * shares;
    const todayProfit = (currentNav - yesterdayNav) * shares;
    const costValue = buyPrice * shares;
    const totalReturn = raw.holdingReturn || (marketValue - costValue);
    const totalReturnRate = costValue > 0 ? (totalReturn / costValue) * 100 : 0;

    this.setData({
      holdingData: {
        shares: shares,
        buyPrice: buyPrice,
        marketValue: marketValue.toFixed(2),
        todayProfit: todayProfit.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
      },
    });
    this._rawHolding = null;
  },

  onRefresh() { this.fetchAll(); },
  onPullDownRefresh() {
    this.fetchAll().finally(() => wx.stopPullDownRefresh());
  },
  onShowMore() { this.setData({ showAllHistory: true }); },
  onShowLess() { this.setData({ showAllHistory: false }); },
  async onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
    if (tab === 'trend') {
      setTimeout(() => this.drawChart(), 300);
    } else if ((tab === 'holdings' || tab === 'profile') && !this.data.profile) {
      wx.showLoading({ title: '加载中...' });
      await this.fetchProfile();
      wx.hideLoading();
    }
  },
  onAddHolding() {
    const { fundCode, fundName } = this.data;
    wx.navigateTo({ url: `/pages/add-holding/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName)}` });
  },
  onCompare() {
    const { fundCode, fundName } = this.data;
    if (!fundCode || fundCode === "undefined") {
      wx.showToast({ title: "基金信息异常", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/fund-compare/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName || "")}`,
      fail: (err) => {
        console.error("跳转对比页失败:", err);
        wx.showToast({ title: err.errMsg || "跳转失败", icon: "none" });
      },
    });
  },
});
