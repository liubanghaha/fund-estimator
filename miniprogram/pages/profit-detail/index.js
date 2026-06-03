const api = require("../../utils/api");
const calc = require("../../utils/calculator");
const chartUtil = require("../../utils/chart");

const CACHE_KEY = "profit_detail_cache";

Page({
  data: {
    activeTab: "week",
    ready: false,
    empty: false,
    totalCost: 0,
    todayProfit: "0.00", todayProfitRate: "0.00",
    weekProfit: "0.00", monthProfit: "0.00", yearProfit: "0.00",
    weekProfitRate: "0.00", monthProfitRate: "0.00", yearProfitRate: "0.00",
    calendarView: "day",
    selectedMonth: "", availableMonths: [], dayCalendar: [],
    selectedYear: "", availableYears: [], monthCalendar: [], yearData: [],
    compareIndex: "000300", compareLabel: "沪深300",
    availableIndices: [
      { code: "000300", name: "沪深300" },
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "399006", name: "创业板指" },
    ],
  },

  onLoad() {
    const { windowWidth } = wx.getSystemInfoSync();
    this._canvasW = windowWidth - 24;
    this._canvasH = Math.round(this._canvasW * 0.59);
    this.setData({ canvasW: this._canvasW, canvasH: this._canvasH });
    // 先展示缓存，再后台拉取
    this._applyCache();
    this._loadFresh();
  },

  onPullDownRefresh() {
    this._loadFresh().finally(() => wx.stopPullDownRefresh());
  },

  // ======== 缓存：瞬开 ========

  _applyCache() {
    try {
      const c = wx.getStorageSync(CACHE_KEY);
      if (c && c.summary && c.chartData) {
        this._allDaily = c.chartData.allDaily;
        this._dailyChange = c.chartData.dailyChange;
        this._indexDaily = c.chartData.indexDaily || [];
        this._totalCost = c.summary.totalCost;
        this.setData({
          ready: true,
          totalCost: c.summary.totalCost,
          todayProfit: c.summary.todayProfit, todayProfitRate: c.summary.todayProfitRate,
          weekProfit: c.summary.weekProfit, monthProfit: c.summary.monthProfit, yearProfit: c.summary.yearProfit,
          weekProfitRate: c.summary.weekProfitRate, monthProfitRate: c.summary.monthProfitRate, yearProfitRate: c.summary.yearProfitRate,
          earliestCreate: c.summary.earliestCreate,
        }, () => this.drawChart());
      }
    } catch (e) { /* ignore */ }
  },

  async _loadFresh() {
    try {
      const [pfRes, idxRes] = await Promise.all([
        api.getPortfolio(30),
        this._fetchIndex(this.data.compareIndex),
      ]);
      if (!pfRes.result || pfRes.result.code !== 0) {
        this.setData({ ready: true });
        return;
      }
      const d = pfRes.result.data;
      const holdings = d.holdings || [];
      if (holdings.length === 0) { this.setData({ ready: true, empty: true }); return; }

      const totalCost = holdings.reduce((sum, h) => sum + h.buyPrice * h.shares, 0);
      const navHistoryMap = d.navHistoryMap || {};
      const dailyChange = {};
      const dateMap = {};
      let earliest = "9999-99-99";

      holdings.forEach(h => {
        const hist = navHistoryMap[h.fundCode] || [];
        let shares = parseFloat(h.shares || h.amount || 0);
        if (!shares && h.marketValue && h.currentNav) shares = parseFloat(h.marketValue) / parseFloat(h.currentNav);
        const startDate = h.createTime ? calc.formatDate(h.createTime) : null;
        if (startDate && startDate < earliest) earliest = startDate;
        hist.forEach(item => { if (!dateMap[item.date]) dateMap[item.date] = 0; dateMap[item.date] += item.nav * h.shares; });
        if (!shares || hist.length < 2) return;
        for (let i = 1; i < hist.length; i++) {
          const date = hist[i].date;
          if (startDate && date < startDate) continue;
          if (!dailyChange[date]) dailyChange[date] = 0;
          dailyChange[date] += (hist[i].nav - hist[i - 1].nav) * shares;
        }
      });
      Object.keys(dailyChange).forEach(k => { dailyChange[k] = +dailyChange[k].toFixed(2); });

      const allDaily = Object.entries(dateMap)
        .filter(([date]) => date >= earliest)
        .map(([date, value]) => ({ date, value: +value.toFixed(2), profit: +(value - totalCost).toFixed(2) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const now = new Date();
      const todayStr = calc.formatDate(now);
      const weekStart = this._getWeekStart(now);
      const curMonth = todayStr.slice(0, 7);
      const curYear = todayStr.slice(0, 4);
      const sumSince = (pfx, len) => { let s = 0; for (const [dt, chg] of Object.entries(dailyChange)) { if (dt.slice(0, len) === pfx) s += chg; } return +s.toFixed(2); };
      const hasHistory = Object.keys(dailyChange).length > 0;
      const tp = parseFloat(d.todayProfit) || 0;
      const w = hasHistory ? sumSince(weekStart, 10) : tp;
      const m = hasHistory ? sumSince(curMonth, 7) : tp;
      const y = hasHistory ? sumSince(curYear, 4) : tp;
      const fmtR = (v) => totalCost > 0 ? +((v / totalCost) * 100).toFixed(2) : 0;

      this._allDaily = allDaily;
      this._dailyChange = dailyChange;
      this._indexDaily = idxRes || [];
      this._totalCost = totalCost;

      const summary = {
        totalCost,
        todayProfit: tp.toFixed(2), todayProfitRate: parseFloat(d.todayProfitRate || 0),
        weekProfit: w.toFixed(2), monthProfit: m.toFixed(2), yearProfit: y.toFixed(2),
        weekProfitRate: fmtR(parseFloat(w)),
        monthProfitRate: fmtR(parseFloat(m)),
        yearProfitRate: fmtR(parseFloat(y)),
        earliestCreate: earliest,
      };

      this._calBuilt = false;
      this.setData({ ready: true, ...summary }, () => this._drawChartIfReady());

      // 写缓存
      try {
        wx.setStorage({ key: CACHE_KEY, data: { summary, chartData: { allDaily, dailyChange, indexDaily: this._indexDaily }, ts: Date.now() } });
      } catch (e) { /* ignore */ }
    } catch (e) {
      this.setData({ ready: true });
    }
  },

  // ======== Chart ========

  _drawChartIfReady() {
    if (!this._canvasW) { this._drawPending = true; return; }
    this._drawPending = false;
    this.drawChart();
  },

  _getChartData() {
    const all = this._allDaily || [];
    const idx = this._indexDaily || [];
    if (all.length < 2) {
      // 无组合数据，画指数
      if (idx.length < 2) return null;
      const now = new Date();
      const ts = calc.formatDate(now);
      let start;
      if (this.data.activeTab === "week") start = this._getWeekStart(now);
      else if (this.data.activeTab === "month") start = ts.slice(0, 7) + "-01";
      else start = ts.slice(0, 4) + "-01-01";
      const f = idx.filter(d => d.date >= start);
      if (f.length < 2) return null;
      const base = f[0].close;
      return {
        data: f.map(d => ({ date: d.date, baseRate: null, indexRate: base > 0 ? +((d.close / base - 1) * 100).toFixed(2) : 0 })),
        hasIndex: true, indexOnly: true,
      };
    }

    const now = new Date();
    const ts = calc.formatDate(now);
    let start;
    if (this.data.activeTab === "week") start = this._getWeekStart(now);
    else if (this.data.activeTab === "month") start = ts.slice(0, 7) + "-01";
    else start = ts.slice(0, 4) + "-01-01";

    const pf = all.filter(d => d.date >= start);
    if (pf.length < 2) return null;
    const baseVal = pf[0].value;

    const idxMap = {}; idx.forEach(d => { idxMap[d.date] = d.close; });
    const idxDates = Object.keys(idxMap).sort();
    const findClose = (ds) => {
      if (idxMap[ds] !== undefined) return idxMap[ds];
      for (let i = idxDates.length - 1; i >= 0; i--) { if (idxDates[i] <= ds) return idxMap[idxDates[i]]; }
      return null;
    };
    const idxBase = findClose(pf[0].date);
    const data = pf.map(p => {
      const c = findClose(p.date);
      return {
        date: p.date,
        baseRate: +((p.value / baseVal - 1) * 100).toFixed(2),
        indexRate: (idxBase && c && idxBase > 0) ? +((c / idxBase - 1) * 100).toFixed(2) : null,
      };
    });
    return { data, hasIndex: idxBase !== null && data.some(d => d.indexRate !== null) };
  },

  drawChart() {
    const result = this._getChartData();
    if (!result) return;
    const { data, hasIndex, indexOnly } = result;
    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = this._canvasW, h = this._canvasH;
    const p = { top: 40, right: 12, bottom: 36, left: 52 };

    const color = !data.length ? '#E4393C' : (data[data.length - 1].baseRate >= (data[0].baseRate || 0) ? '#E4393C' : '#2E8B57');

    if (indexOnly) {
      const items = data.map(d => ({ date: d.date, value: d.indexRate }));
      chartUtil.drawLineChart(ctx, { w, h, data: items, color: '#E4393C', padding: p });
    } else if (hasIndex) {
      chartUtil.drawDualLineChart(ctx, {
        w, h, data, padding: p,
        fieldA: 'baseRate', fieldB: 'indexRate',
        colorA: color, colorB: '#1976D2',
        labelA: '我的收益', labelB: this.data.compareLabel,
      });
    } else {
      const items = data.map(d => ({ date: d.date, value: d.baseRate }));
      chartUtil.drawLineChart(ctx, { w, h, data: items, color, padding: p });
    }
    ctx.draw();
  },

  // Calendar (lazy)
  _ensureCalendar() {
    if (this._calBuilt) return;
    this._calBuilt = true;
    const all = this._allDaily, dc = this._dailyChange;
    if (!all || !dc) return;
    const dm = {}; all.forEach(d => { dm[d.date] = d; });
    const mons = [...new Set(Object.keys(dm).map(d => d.slice(0, 7)))].sort().reverse();
    const yrs = [...new Set(Object.keys(dm).map(d => d.slice(0, 4)))].sort().reverse();
    const now = new Date();
    const sm = mons[0] || calc.formatDate(now).slice(0, 7);
    const sy = yrs[0] || String(now.getFullYear());
    this.setData({
      availableMonths: mons, selectedMonth: sm,
      availableYears: yrs, selectedYear: sy,
      dayCalendar: this._buildDays(all, dc, sm),
      monthCalendar: this._buildMonths(dc, sy),
      yearData: this._buildYears(dc),
    });
  },

  _buildDays(all, dc, month) {
    const map = {}; all.forEach(d => { map[d.date] = d; });
    const [y, m] = month.split('-').map(Number);
    const fd = new Date(y, m - 1, 1).getDay();
    const dim = new Date(y, m, 0).getDate();
    const weeks = []; let w = [];
    for (let i = 0; i < fd; i++) w.push({ day: '', empty: true });
    for (let d = 1; d <= dim; d++) {
      const ds = `${month}-${String(d).padStart(2, '0')}`;
      const chg = dc[ds];
      w.push({ day: d, date: ds, profit: chg !== undefined ? chg : null, empty: chg === undefined });
      if (w.length === 7) { weeks.push(w); w = []; }
    }
    while (w.length > 0 && w.length < 7) w.push({ day: '', empty: true });
    if (w.length === 7) weeks.push(w);
    return weeks;
  },

  _buildMonths(dc, year) {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => {
      const pfx = `${year}-${String(m).padStart(2, '0')}`;
      let s = 0, h = false;
      for (const [d, chg] of Object.entries(dc)) { if (d.startsWith(pfx)) { s += chg; h = true; } }
      return { month: m, date: pfx, profit: +s.toFixed(2), empty: !h };
    });
  },

  _buildYears(dc) {
    const ys = [...new Set(Object.keys(dc).map(d => d.slice(0, 4)))].sort();
    return ys.map(y => {
      let s = 0;
      for (const [d, chg] of Object.entries(dc)) { if (d.startsWith(y)) s += chg; }
      return { date: y + '-12-31', profit: +s.toFixed(2) };
    });
  },

  // ======== Events ========

  onSummaryTap(e) { this.setData({ activeTab: e.currentTarget.dataset.tab }, () => this.drawChart()); },
  onCalendarTab(e) { this._ensureCalendar(); this.setData({ calendarView: e.currentTarget.dataset.tab }); },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },

  onMonthChange(e) {
    const m = this.data.availableMonths[e.detail.value];
    this.setData({ selectedMonth: m, dayCalendar: this._buildDays(this._allDaily, this._dailyChange, m) });
  },
  onYearChange(e) {
    const y = this.data.availableYears[e.detail.value];
    this.setData({ selectedYear: y, monthCalendar: this._buildMonths(this._dailyChange, y) });
  },

  async onSelectIndex(e) {
    const { code, name } = e.currentTarget.dataset;
    if (code === this.data.compareIndex) return;
    const idx = await this._fetchIndex(code);
    this._indexDaily = idx;
    this.setData({ compareIndex: code, compareLabel: name }, () => this.drawChart());
  },

  onProfitTouch() {},

  // ======== Helpers ========

  _getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return calc.formatDate(d);
  },

  async _fetchIndex(code) {
    try {
      const res = await api.fetchMarketIndexClient(code, 30);
      if (res && res.code === 0 && res.data) return res.data.map(d => ({ date: d.date, close: d.close }));
    } catch (e) { /* ignore */ }
    return [];
  },
});
