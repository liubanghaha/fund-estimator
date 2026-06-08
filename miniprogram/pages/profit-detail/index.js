const api = require("../../utils/api");
const calc = require("../../utils/calculator");

const CACHE = "profit_detail_cache_v2";

Page({
  data: {
    activeTab: "week",
    profitMode: "amount",
    loading: true,
    empty: false,
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
    canvasHRpx: 0,
    earliestDate: "",
    calendarView: "day",
    selectedMonth: "", availableMonths: [], dayCalendar: [],
    selectedYear: "", availableYears: [], monthCalendar: [], yearData: [],
  },

  onLoad() {
    const { windowWidth } = wx.getSystemInfoSync();
    this._canvasW = windowWidth - 24;
    this._canvasH = Math.round(this._canvasW * 0.59);
    this._canvasHRpx = Math.round(this._canvasH * 750 / windowWidth);
    this.setData({ canvasW: this._canvasW, canvasH: this._canvasH, canvasHRpx: this._canvasHRpx });
    this._fromCache();
  },

  onShow() {
    if (this._first) { this._first = false; return; }
    const now = Date.now();
    if (this._lastFetch && now - this._lastFetch < 30000) return;
    this._lastFetch = now;
    this._fetch();
  },

  onPullDownRefresh() {
    this._fetch().finally(() => wx.stopPullDownRefresh());
  },

  // ============ 缓存 + 拉取 ============

  _fromCache() {
    try {
      const c = wx.getStorageSync(CACHE);
      if (c && c.d && c.d.length && c.idx && c.idx.length) {
        this._lastFetch = c.ts || 0;
        this._allDaily = c.d;
        this._dailyChange = c.dc;
        this._indexDaily = c.idx;
        this._idxMap = c.im || {};
        this._totalCost = c.tc;
        const cacheLastDate = c.d.length ? c.d[c.d.length - 1].date : "";
        const cacheIsTrading = cacheLastDate === calc.formatDate(new Date());
        this._fromCache = true;
        this.setData({
          loading: false,
          totalCost: c.tc,
          todayProfit: cacheIsTrading ? c.s.tp : "0.00", todayProfitRate: cacheIsTrading ? c.s.tpr : 0,
          weekProfit: c.s.w, monthProfit: c.s.m, yearProfit: c.s.y,
          weekProfitRate: c.s.wr, monthProfitRate: c.s.mr, yearProfitRate: c.s.yr,
          earliestDate: c.ed || c.d[0] ? (c.ed || c.d[0].date) : "",
          availableMonths: c.cal.months || [], selectedMonth: c.cal.sm || "",
          availableYears: c.cal.years || [], selectedYear: c.cal.sy || "",
          dayCalendar: c.cal.days || [], monthCalendar: c.cal.mons || [], yearData: c.cal.yrs || [],
        });
        setTimeout(() => this._draw(), 150);
      }
    } catch (e) { /* ignore */ }
    this._first = true;
    this._fetch();
  },

  async _fetch() {
    try {
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
        if (!this._fromCache) wx.showToast({ title: '数据加载失败', icon: 'none' });
        this.setData({ loading: false });
        return;
      }
      const d = pfRes.result.data;
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

      const lastDate = allDaily.length ? allDaily[allDaily.length - 1].date : "";
      const isTradingDay = lastDate === today;
      if (!isTradingDay) {
        Object.keys(idxMap).forEach(k => { idxMap[k] = (idxMap[k] || []).filter(d => d.date !== today); });
      }
      const tp = isTradingDay ? (parseFloat(d.todayProfit) || 0) : 0;
      if (isTradingDay && tp !== 0) dcFinal[today] = tp;

      // 收益
      const ws = this._mon(now);
      const cm = today.slice(0, 7), cy = today.slice(0, 4);
      const sm = (s, pf, len) => { let x = 0; for (const [dt, v] of Object.entries(dcFinal)) { if (dt < s) continue; if (pf && dt.slice(0, len) !== pf) continue; x += v; } return +x.toFixed(2); };
      const w = sm(ws), m = sm(cm + "-01", cm, 7), y = sm(cy + "-01-01", cy, 4);
      const rt = (v) => totalCost > 0 ? +((v / totalCost) * 100).toFixed(2) : 0;

      this._allDaily = allDaily;
      this._dailyChange = dcFinal;
      this._indexDaily = idxMap[this.data.compareIndex] || [];
      this._totalCost = totalCost;
      this._fromCache = false;

      const earliestCreate = hs.reduce((min, h) => { if (!h.createTime) return min; const d = calc.formatDate(h.createTime); return d < min ? d : min; }, "9999-99-99");

      this.setData({
        loading: false,
        totalCost,
        todayProfit: tp.toFixed(2), todayProfitRate: isTradingDay ? parseFloat(d.todayProfitRate || 0) : 0,
        weekProfit: w, monthProfit: m, yearProfit: y,
        weekProfitRate: rt(parseFloat(w)), monthProfitRate: rt(parseFloat(m)), yearProfitRate: rt(parseFloat(y)),
        earliestDate: earliestCreate === "9999-99-99" ? "" : earliestCreate,
      }, () => { this._draw(); this._cal(); });

      const cal = this._calCached();
      const hasIndex = Object.values(idxMap).some(arr => arr && arr.length);
      if (hasIndex) {
        this._retryCount = 0;
        wx.setStorage({ key: CACHE, data: { d: allDaily, dc: dcFinal, idx: this._indexDaily, im: idxMap, ed: earliestCreate, tc: totalCost, s: { tp: tp.toFixed(2), tpr: isTradingDay ? parseFloat(d.todayProfitRate || 0) : 0, w, m, y, wr: rt(parseFloat(w)), mr: rt(parseFloat(m)), yr: rt(parseFloat(y)) }, cal, ts: Date.now() } });
      } else {
        this._retryCount = (this._retryCount || 0) + 1;
        if (this._retryCount <= 3) setTimeout(() => this._fetch(), 2000);
      }
    } catch (e) {
      this.setData({ loading: false });
      if (!this._fromCache) wx.showToast({ title: '数据加载失败', icon: 'none' });
    }
  },

  // ============ 图 ============

  _data() {
    const all = this._allDaily || [], idx = this._indexDaily || [];
    if (!all.length) return null;
    const now = new Date(), today = calc.formatDate(now);
    let st; if (this.data.activeTab === "week") st = this._mon(now); else if (this.data.activeTab === "month") st = today.slice(0, 7) + "-01"; else st = today.slice(0, 4) + "-01-01";
    const pm = {}; all.forEach(d => { pm[d.date] = d; });
    const fi = idx.filter(d => d.date >= st);

    if (fi.length < 2) {
      let pf = all.filter(d => d.date >= st);
      if (pf.length < 2) {
        // 当前周期数据不足 2 个点，取最近数据兜底
        pf = all.slice(-5);
        if (pf.length < 2) return null;
      }
      // 兜底时也尝试匹配指数数据
      const fallbackStart = pf[0].date;
      const idxFallback = idx.filter(d => d.date >= fallbackStart);
      if (idxFallback.length >= 2) {
        const ib2 = idxFallback[0].close;
        let pb2 = null;
        for (const d of idxFallback) { if (pm[d.date]) { pb2 = pm[d.date].value; break; } }
        const hasP2 = pb2 !== null && pb2 > 0;
        return { data: idxFallback.map(d => { const pv = pm[d.date]; return { date: d.date, baseRate: (hasP2 && pv) ? +((pv.value / pb2 - 1) * 100).toFixed(2) : null, indexRate: +((d.close / ib2 - 1) * 100).toFixed(2) }; }), hasP: hasP2 };
      }
      const pb = pf[0].value;
      return { data: pf.map(d => ({ date: d.date, baseRate: +((d.value / pb - 1) * 100).toFixed(2), indexRate: null })), hasP: true, noIdx: true };
    }

    const ib = fi[0].close;
    let pb = null; for (const d of fi) { if (pm[d.date]) { pb = pm[d.date].value; break; } }
    const hasP = pb !== null && pb > 0;
    const data = fi.map(d => { const pf = pm[d.date]; return { date: d.date, baseRate: (hasP && pf) ? +((pf.value / pb - 1) * 100).toFixed(2) : null, indexRate: +((d.close / ib - 1) * 100).toFixed(2) }; });
    return { data, hasP };
  },

  _draw() {
    const r = this._data(); if (!r) return;
    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const p = { t: 40, r: 12, b: 36, l: 52 };
    const { data, hasP, noIdx } = r;

    const drawAxis = (vals, marker, label) => {
      const mn = Math.min(...vals), mx = Math.max(...vals);
      const rg = mx - mn || 0.01, y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
      const pw = w - p.l - p.r, ph = h - p.t - p.b;
      const xi = i => p.l + (pw / (data.length - 1)) * i;
      const yi = v => p.t + ph - ((v - y0) / (y1 - y0)) * ph;
      ctx.setFillStyle('#FFF'); ctx.fillRect(0, 0, w, h);
      if (marker === 'baseRate') {
        this._line(ctx, data, 'baseRate', xi, yi, '#E4393C');
        ctx.setFontSize(9); ctx.setTextBaseline('middle');
        ctx.setFillStyle('#E4393C'); ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText(label || '收益', p.l + 20, 12);
      } else if (marker === 'dual') {
        const vals2 = data.filter(d => d.baseRate !== null);
        const pc2 = vals2.length >= 2 && vals2[vals2.length - 1].baseRate >= vals2[0].baseRate ? '#E4393C' : '#2E8B57';
        this._line(ctx, data, 'baseRate', xi, yi, pc2);
        this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
        ctx.setFontSize(9); ctx.setTextBaseline('middle');
        ctx.setFillStyle(pc2); ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText('我的收益', p.l + 20, 12);
        ctx.setFillStyle('#1976D2'); ctx.fillRect(p.l + 4, 22, 12, 4);
        ctx.setFillStyle('#666'); ctx.fillText(this.data.compareLabel, p.l + 20, 24);
      } else {
        this._line(ctx, data, 'indexRate', xi, yi, '#E4393C');
        ctx.setFontSize(9); ctx.setTextBaseline('middle');
        ctx.setFillStyle('#E4393C'); ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText(this.data.compareLabel, p.l + 20, 12);
      }
      ctx.setFillStyle('#999'); ctx.setFontSize(10); ctx.setTextAlign('right'); ctx.setTextBaseline('middle');
      for (let i = 0; i <= 4; i++) { const v = y1 - (y1 - y0) / 4 * i; ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v)); }
      ctx.setTextBaseline('top'); ctx.setFontSize(11);
      const last = data.length - 1;
      const positions = [0, Math.floor(last / 2), last];
      const aligns = ['left', 'center', 'right'];
      positions.forEach((ix, i) => {
        ctx.setTextAlign(aligns[i]);
        const x = i === 2 ? xi(ix) - 4 : i === 0 ? xi(ix) + 4 : xi(ix);
        ctx.fillText(data[ix].date.slice(5), x, h - p.b + 8);
      });
      ctx.draw();
    };

    if (noIdx) { const vs = data.filter(d => d.baseRate !== null).map(d => d.baseRate); if (vs.length >= 2) drawAxis(vs, 'baseRate', ''); }
    else if (hasP) { const av = [...data.map(d => d.baseRate).filter(v => v !== null), ...data.map(d => d.indexRate)]; if (av.length >= 2) drawAxis(av, 'dual'); }
    else { drawAxis(data.map(d => d.indexRate), 'index'); }
  },

  _line(ctx, data, f, xi, yi, c) { let s = false; ctx.beginPath(); data.forEach((d, i) => { if (d[f] === null) { s = false; return; } const x = xi(i), y = yi(d[f]); s ? ctx.lineTo(x, y) : ctx.moveTo(x, y); s = true; }); ctx.setStrokeStyle(c); ctx.setLineWidth(2); ctx.stroke(); },

  // ============ 日历 ============

  _cal() { const s = this._calCached(); if (s) this.setData({ availableMonths: s.months, selectedMonth: s.sm, availableYears: s.years, selectedYear: s.sy, dayCalendar: s.days, monthCalendar: s.mons, yearData: s.yrs }); },
  _calCached() {
    const a = this._allDaily, c = this._dailyChange; if (!a || !c) return null;
    const dm = {}; a.forEach(d => { dm[d.date] = d.value; });
    const ms = [...new Set(Object.keys(dm).map(d => d.slice(0, 7)))].sort().reverse();
    const ys = [...new Set(Object.keys(dm).map(d => d.slice(0, 4)))].sort().reverse();
    const now = new Date(); const sm = ms[0] || calc.formatDate(now).slice(0, 7); const sy = ys[0] || String(now.getFullYear());
    return { months: ms, sm, years: ys, sy, days: this._days(c, sm, dm), mons: this._mons(c, sy, dm), yrs: this._yrs(c, dm) };
  },

  _days(c, month, dm) { const [y, m] = month.split('-').map(Number); const fd = new Date(y, m - 1, 1).getDay(); const dim = new Date(y, m, 0).getDate(); const wks = []; let w = []; for (let i = 0; i < fd; i++) w.push({ day: '', empty: true }); for (let d = 1; d <= dim; d++) { const ds = `${month}-${String(d).padStart(2, '0')}`; const chg = c[ds]; const empty = chg === undefined; const mv = dm[ds] || 0; w.push({ day: d, date: ds, profit: empty ? null : chg, rate: empty ? null : (mv > 0 && mv !== chg ? +((chg / (mv - chg)) * 100).toFixed(2) : 0), empty }); if (w.length === 7) { wks.push(w); w = []; } } while (w.length > 0 && w.length < 7) w.push({ day: '', empty: true }); if (w.length === 7) wks.push(w); return wks; },
  _mons(c, year, dm) { return [1,2,3,4,5,6,7,8,9,10,11,12].map(m => { const pfx = `${year}-${String(m).padStart(2, '0')}`; let s = 0, h = false; for (const [d, chg] of Object.entries(c)) { if (d.startsWith(pfx)) { s += chg; h = true; } } const v = +s.toFixed(2); const keys = Object.keys(dm).filter(k => k.startsWith(pfx)).sort(); const mv = keys.length ? dm[keys[keys.length - 1]] : 0; return { month: m, date: pfx, profit: v, rate: mv > 0 && mv !== v ? +((v / (mv - v)) * 100).toFixed(2) : 0, empty: !h }; }); },
  _yrs(c, dm) { return [...new Set(Object.keys(c).map(d => d.slice(0, 4)))].sort().map(y => { let s = 0; for (const [d, chg] of Object.entries(c)) { if (d.startsWith(y)) s += chg; } const v = +s.toFixed(2); const keys = Object.keys(dm).filter(k => k.startsWith(y)).sort(); const mv = keys.length ? dm[keys[keys.length - 1]] : 0; return { date: y + '-12-31', profit: v, rate: mv > 0 && mv !== v ? +((v / (mv - v)) * 100).toFixed(2) : 0 }; }); },

  // ============ 事件 ============

  onSummaryTap(e) { this.setData({ activeTab: e.currentTarget.dataset.tab }, () => this._draw()); },
  onCalendarTab(e) { this._cal(); this.setData({ calendarView: e.currentTarget.dataset.tab }); },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },
  onMonthChange(e) { const m = this.data.availableMonths[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedMonth: m, dayCalendar: this._days(this._dailyChange, m, dm) }); },
  onYearChange(e) { const y = this.data.availableYears[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedYear: y, monthCalendar: this._mons(this._dailyChange, y, dm) }); },
  onToggleMode() { this._cal(); this.setData({ profitMode: this.data.profitMode === 'amount' ? 'rate' : 'amount' }); },
  onSelectIndex(e) { const { code, name } = e.currentTarget.dataset; if (code === this.data.compareIndex) return; this.setData({ compareIndex: code, compareLabel: name }); const data = this._idxMap ? this._idxMap[code] : null; if (!data || !data.length) { this._fetch(); return; } this._indexDaily = data; this._draw(); },

  _mon(d) { const c = new Date(d); c.setDate(c.getDate() - (c.getDay() === 0 ? 6 : c.getDay() - 1)); return calc.formatDate(c); },
  async _idx(code, days) {
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
    const r1 = await tryAll();
    if (r1) return r1;
    return (await tryAll()) || [];
  },
});
