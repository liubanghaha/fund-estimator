const api = require("../../utils/api");
const calc = require("../../utils/calculator");

Page({
  data: {
    activeTab: "week",
    loading: true, empty: false,
    totalCost: 0,
    todayProfit: "0.00", todayProfitRate: "0.00",
    weekProfit: "0.00", monthProfit: "0.00", yearProfit: "0.00",
    weekProfitRate: "0.00", monthProfitRate: "0.00", yearProfitRate: "0.00",
    compareIndex: "000300", compareLabel: "沪深300",
    availableIndices: [
      { code: "000300", name: "沪深300" },
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "399006", name: "创业板指" },
    ],
    earliestDate: "",
    calendarView: "day",
    selectedMonth: "", availableMonths: [], dayCalendar: [],
    selectedYear: "", availableYears: [], monthCalendar: [], yearData: [],
  },

  onLoad() {
    const { windowWidth } = wx.getSystemInfoSync();
    this._canvasW = windowWidth - 24;
    this._canvasH = Math.round(this._canvasW * 0.59);
    this.setData({ canvasW: this._canvasW, canvasH: this._canvasH });
    this._load();
  },

  onPullDownRefresh() {
    this._load().finally(() => wx.stopPullDownRefresh());
  },

  async _load() {
    try {
      const [pfRes, idxRes] = await Promise.all([
        api.getPortfolio(60),
        this._idx(this.data.compareIndex),
      ]);
      if (!pfRes.result || pfRes.result.code !== 0) { this.setData({ loading: false }); return; }
      const d = pfRes.result.data;
      const hs = d.holdings || [];
      if (!hs.length) { this.setData({ loading: false, empty: true }); return; }

      const totalCost = hs.reduce((s, h) => s + h.buyPrice * h.shares, 0);
      const navMap = d.navHistoryMap || {};
      const now = new Date();
      const today = calc.formatDate(now);

      // ---- 日变动（NAV 升序计算）----
      const dc = {};
      hs.forEach(h => {
        let shares = parseFloat(h.shares || h.amount || 0);
        if (!shares && h.marketValue) {
          const cn = h.currentNav || h.buyPrice;
          if (cn > 0) shares = parseFloat(h.marketValue) / cn;
        }
        if (!shares) return;
        const hist = [...(navMap[h.fundCode] || [])].reverse();
        if (hist.length < 2) return;
        const startDate = h.createTime ? calc.formatDate(h.createTime) : null;
        for (let i = 1; i < hist.length; i++) {
          if (startDate && hist[i].date < startDate) continue;
          const chg = (hist[i].nav - hist[i - 1].nav) * shares;
          if (!dc[hist[i].date]) dc[hist[i].date] = 0;
          dc[hist[i].date] += chg;
        }
      });
      Object.keys(dc).forEach(k => { dc[k] = +dc[k].toFixed(2); });

      // 用服务端 tp 替换今日客户端值
      const tp = parseFloat(d.todayProfit) || 0;
      const dcFinal = { ...dc };
      if (tp !== 0) dcFinal[today] = tp;

      // ---- 每日市值（图表用）----
      const dm = {};
      hs.forEach(h => {
        (navMap[h.fundCode] || []).forEach(x => {
          if (!dm[x.date]) dm[x.date] = 0;
          dm[x.date] += x.nav * h.shares;
        });
      });
      const allDaily = Object.entries(dm)
        .map(([dt, v]) => ({ date: dt, value: +v.toFixed(2) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // ---- 收益 ----
      const wStart = this._mon(now);
      const cm = today.slice(0, 7);
      const cy = today.slice(0, 4);
      const sum = (s, pf, len) => {
        let x = 0;
        for (const [dt, v] of Object.entries(dcFinal)) {
          if (dt < s) continue;
          if (pf && dt.slice(0, len) !== pf) continue;
          x += v;
        }
        return +x.toFixed(2);
      };
      const w = sum(wStart);
      const m = sum(cm + "-01", cm, 7);
      const y = sum(cy + "-01-01", cy, 4);
      const rate = (v) => totalCost > 0 ? +((v / totalCost) * 100).toFixed(2) : 0;

      this._allDaily = allDaily;
      this._dailyChange = dcFinal;
      this._indexDaily = idxRes || [];
      this._totalCost = totalCost;

      this.setData({
        loading: false,
        totalCost,
        todayProfit: tp.toFixed(2), todayProfitRate: parseFloat(d.todayProfitRate || 0),
        weekProfit: w, monthProfit: m, yearProfit: y,
        weekProfitRate: rate(parseFloat(w)),
        monthProfitRate: rate(parseFloat(m)),
        yearProfitRate: rate(parseFloat(y)),
        earliestDate: allDaily[0] ? allDaily[0].date : today,
      }, () => {
        this._draw();
        this._cal();
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  // ============ 图 ============

  _data() {
    const all = this._allDaily || [];
    const idx = this._indexDaily || [];
    if (!all.length || !idx.length) return null;
    const now = new Date();
    const today = calc.formatDate(now);
    let start;
    if (this.data.activeTab === "week") start = this._mon(now);
    else if (this.data.activeTab === "month") start = today.slice(0, 7) + "-01";
    else start = today.slice(0, 4) + "-01-01";

    const pm = {}; all.forEach(d => { pm[d.date] = d; });
    const fi = idx.filter(d => d.date >= start);
    if (fi.length < 2) return null;

    const iBase = fi[0].close;
    let pBase = null;
    for (const d of fi) { if (pm[d.date]) { pBase = pm[d.date].value; break; } }
    const hasP = pBase !== null && pBase > 0;

    const data = fi.map(d => {
      const pf = pm[d.date];
      return {
        date: d.date,
        baseRate: (hasP && pf) ? +((pf.value / pBase - 1) * 100).toFixed(2) : null,
        indexRate: +((d.close / iBase - 1) * 100).toFixed(2),
      };
    });
    return { data, hasP };
  },

  _draw() {
    const r = this._data();
    if (!r) return;
    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const p = { t: 40, r: 12, b: 36, l: 52 };
    const { data, hasP } = r;

    if (hasP) {
      const vv = data.filter(d => d.baseRate !== null);
      const pc = vv.length >= 2 && vv[vv.length - 1].baseRate >= vv[0].baseRate ? '#E4393C' : '#2E8B57';
      const av = [...data.map(d => d.baseRate).filter(v => v !== null), ...data.map(d => d.indexRate)];
      const mn = Math.min(...av), mx = Math.max(...av);
      const rg = mx - mn || 0.01;
      const y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
      const pw = w - p.l - p.r, ph = h - p.t - p.b;
      const xi = (i) => p.l + (pw / (data.length - 1)) * i;
      const yi = (v) => p.t + ph - ((v - y0) / (y1 - y0)) * ph;

      ctx.setFillStyle('#FFF'); ctx.fillRect(0, 0, w, h);
      this._line(ctx, data, 'baseRate', xi, yi, pc);
      this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');

      ctx.setFontSize(9); ctx.setTextBaseline('middle');
      ctx.setFillStyle(pc); ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText('我的收益', p.l + 20, 12);
      ctx.setFillStyle('#1976D2'); ctx.fillRect(p.l + 4, 22, 12, 4);
      ctx.setFillStyle('#666'); ctx.fillText(this.data.compareLabel, p.l + 20, 24);

      ctx.setFillStyle('#999'); ctx.setFontSize(10); ctx.setTextAlign('right'); ctx.setTextBaseline('middle');
      for (let i = 0; i <= 4; i++) {
        const v = y1 - (y1 - y0) / 4 * i;
        ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v));
      }
      ctx.setTextAlign('center'); ctx.setTextBaseline('top');
      const st = Math.min(5, data.length);
      for (let i = 0; i < st; i++) {
        const idx = Math.round((i / (st - 1)) * (data.length - 1));
        ctx.fillText(data[idx].date.slice(5), xi(idx), h - p.b + 8);
      }
    } else {
      const av = data.map(d => d.indexRate);
      const mn = Math.min(...av), mx = Math.max(...av);
      const rg = mx - mn || 0.01;
      const y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
      const pw = w - p.l - p.r, ph = h - p.t - p.b;
      const xi = (i) => p.l + (pw / (data.length - 1)) * i;
      const yi = (v) => p.t + ph - ((v - y0) / (y1 - y0)) * ph;

      ctx.setFillStyle('#FFF'); ctx.fillRect(0, 0, w, h);
      this._line(ctx, data, 'indexRate', xi, yi, '#E4393C');

      ctx.setFillStyle('#E4393C'); ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText(this.data.compareLabel, p.l + 20, 12);

      ctx.setFillStyle('#999'); ctx.setFontSize(10); ctx.setTextAlign('right'); ctx.setTextBaseline('middle');
      for (let i = 0; i <= 4; i++) {
        const v = y1 - (y1 - y0) / 4 * i;
        ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v));
      }
      ctx.setTextAlign('center'); ctx.setTextBaseline('top');
      const st = Math.min(5, data.length);
      for (let i = 0; i < st; i++) {
        const idx = Math.round((i / (st - 1)) * (data.length - 1));
        ctx.fillText(data[idx].date.slice(5), xi(idx), h - p.b + 8);
      }
    }
    ctx.draw();
  },

  _line(ctx, data, f, xi, yi, c) {
    let s = false;
    ctx.beginPath();
    data.forEach((d, i) => {
      if (d[f] === null) { s = false; return; }
      const x = xi(i), y = yi(d[f]);
      s ? ctx.lineTo(x, y) : ctx.moveTo(x, y); s = true;
    });
    ctx.setStrokeStyle(c); ctx.setLineWidth(2); ctx.stroke();
  },

  // ============ 日历 ============

  _cal() {
    const a = this._allDaily, c = this._dailyChange;
    if (!a || !c) return;
    const dm = {}; a.forEach(d => { dm[d.date] = d; });
    const ms = [...new Set(Object.keys(dm).map(d => d.slice(0, 7)))].sort().reverse();
    const ys = [...new Set(Object.keys(dm).map(d => d.slice(0, 4)))].sort().reverse();
    const now = new Date();
    const sm = ms[0] || calc.formatDate(now).slice(0, 7);
    const sy = ys[0] || String(now.getFullYear());
    this.setData({
      availableMonths: ms, selectedMonth: sm,
      availableYears: ys, selectedYear: sy,
      dayCalendar: this._days(c, sm),
      monthCalendar: this._mons(c, sy),
      yearData: this._yrs(c),
    });
  },

  _days(c, month) {
    const [y, m] = month.split('-').map(Number);
    const fd = new Date(y, m - 1, 1).getDay();
    const dim = new Date(y, m, 0).getDate();
    const wks = []; let w = [];
    for (let i = 0; i < fd; i++) w.push({ day: '', empty: true });
    for (let d = 1; d <= dim; d++) {
      const ds = `${month}-${String(d).padStart(2, '0')}`;
      const chg = c[ds];
      w.push({ day: d, date: ds, profit: chg !== undefined ? chg : null, empty: chg === undefined });
      if (w.length === 7) { wks.push(w); w = []; }
    }
    while (w.length > 0 && w.length < 7) w.push({ day: '', empty: true });
    if (w.length === 7) wks.push(w);
    return wks;
  },

  _mons(c, year) {
    return [1,2,3,4,5,6,7,8,9,10,11,12].map(m => {
      const pfx = `${year}-${String(m).padStart(2, '0')}`;
      let s = 0, h = false;
      for (const [d, chg] of Object.entries(c)) { if (d.startsWith(pfx)) { s += chg; h = true; } }
      return { month: m, date: pfx, profit: +s.toFixed(2), empty: !h };
    });
  },

  _yrs(c) {
    const ys = [...new Set(Object.keys(c).map(d => d.slice(0, 4)))].sort();
    return ys.map(y => {
      let s = 0;
      for (const [d, chg] of Object.entries(c)) { if (d.startsWith(y)) s += chg; }
      return { date: y + '-12-31', profit: +s.toFixed(2) };
    });
  },

  // ============ 事件 ============

  onSummaryTap(e) { this.setData({ activeTab: e.currentTarget.dataset.tab }, () => this._draw()); },
  onCalendarTab(e) {
    if (!this._calDone) { this._cal(); this._calDone = true; }
    this.setData({ calendarView: e.currentTarget.dataset.tab });
  },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },

  onMonthChange(e) {
    const m = this.data.availableMonths[e.detail.value];
    this.setData({ selectedMonth: m, dayCalendar: this._days(this._dailyChange, m) });
  },
  onYearChange(e) {
    const y = this.data.availableYears[e.detail.value];
    this.setData({ selectedYear: y, monthCalendar: this._mons(this._dailyChange, y) });
  },

  async onSelectIndex(e) {
    const { code, name } = e.currentTarget.dataset;
    if (code === this.data.compareIndex) return;
    const idx = await this._idx(code);
    this._indexDaily = idx;
    this.setData({ compareIndex: code, compareLabel: name }, () => this._draw());
  },

  // ============ 工具 ============

  _mon(d) { const c = new Date(d); c.setDate(c.getDate() - (c.getDay() === 0 ? 6 : c.getDay() - 1)); return calc.formatDate(c); },

  async _idx(code) {
    try {
      const res = await api.fetchMarketIndexClient(code, 60);
      if (res && res.code === 0 && res.data) return res.data.map(d => ({ date: d.date, close: d.close }));
    } catch (e) { /* ignore */ }
    return [];
  },
});
