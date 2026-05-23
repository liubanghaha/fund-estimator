const api = require("../../utils/api");
const calc = require("../../utils/calculator");

Page({
  data: {
    fundCode: "", fundName: "", loading: true, errorMsg: "",
    nav: null, estimatedNav: null, estimatedChangeRate: null, estimateTime: "",
    actualNav: "", actualDate: "", actualChangeRate: null,
    navHistory: [],
    todayReturn: null, weekReturn: null, monthReturn: null,
    threeMonthReturn: null, sixMonthReturn: null, yearReturn: null,
    profile: null, manager: null, holdings: [],
    hasHolding: false, activeTab: "trend",
    showAllHistory: false,
    isTrading: false,
  },

  onLoad(options) {
    this.setData({
      fundCode: options.fundCode || "",
      fundName: options.fundName ? decodeURIComponent(options.fundName) : "",
    });
    this.fetchAll();
  },

  async fetchAll() {
    this.setData({ loading: true, errorMsg: "" });
    try {
      await Promise.all([this.fetchEstimate(), this.fetchHistory(), this.fetchProfile()]);
      await this.checkHolding();
      this.updateDisplay();
      this.setData({ loading: false });
      setTimeout(() => this.drawChart(), 500);
    } catch (e) {
      this.setData({ loading: false, errorMsg: "加载失败" });
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
    } catch (e) {}
  },

  async fetchHistory() {
    try {
      const res = await api.fetchFundNAVHistory(this.data.fundCode, 60);
      if (res.result && res.result.code === 0) {
        const history = res.result.data;
        if (history.length > 0) {
          this.setData({
            navHistory: history,
            actualNav: this.data.actualNav || history[0].nav.toFixed(4),
            actualDate: history[0].date,
            actualChangeRate: this.data.actualChangeRate != null ? this.data.actualChangeRate : (history[0].changeRate || 0),
          });
          this.calcReturns(history);
        }
      }
    } catch (e) {}
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
    } catch (e) {}
  },

  calcReturns(history) {
    const latest = history[0].nav;
    const g = (d) => { if (history.length <= d) return null; return parseFloat(((latest - history[d].nav) / history[d].nav * 100).toFixed(2)); };
    this.setData({
      todayReturn: history[0].changeRate || 0,
      weekReturn: g(4), monthReturn: g(19), threeMonthReturn: g(39),
      sixMonthReturn: g(59), yearReturn: null,
    });
  },

  drawChart() {
    const history = this.data.navHistory;
    if (history.length < 2) return;
    const ctx = wx.createCanvasContext('navCanvas', this);
    const w = 340, h = 180;
    const data = [...history].reverse();
    const navs = data.map(d => d.nav);
    const minNav = Math.min(...navs), maxNav = Math.max(...navs);
    const range = maxNav - minNav || 0.01;
    const pad = range * 0.15;
    const yMin = minNav - pad, yMax = maxNav + pad;
    const m = { top: 16, right: 8, bottom: 22, left: 8 };
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
      ctx.fillText(val.toFixed(4), m.left + 52, yp(val));
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

  async checkHolding() {
    try {
      const res = await api.getPortfolio();
      if (res.result && res.result.code === 0) {
        const holdings = res.result.data.holdings || [];
        this.setData({ hasHolding: holdings.some((h) => h.fundCode === this.data.fundCode) });
      }
    } catch (e) {}
  },

  onRefresh() { this.fetchAll(); },
  onShowMore() { this.setData({ showAllHistory: true }); },
  onShowLess() { this.setData({ showAllHistory: false }); },
  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
    if (tab === 'trend') setTimeout(() => this.drawChart(), 300);
  },
  onAddHolding() {
    const { fundCode, fundName } = this.data;
    wx.navigateTo({ url: `/pages/add-holding/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName)}` });
  },
});
