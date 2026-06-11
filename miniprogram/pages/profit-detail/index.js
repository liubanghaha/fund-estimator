const api = require("../../utils/api");
const calc = require("../../utils/calculator");

const CACHE = "profit_detail_cache_v2";

Page({
  data: {
    activeTab: "today",
    profitMode: "amount",
    loading: true,
    empty: false,
    totalCost: 0,
    todayProfit: "0.00", todayProfitRate: "0.00",
    weekProfit: "0.00", monthProfit: "0.00", yearProfit: "0.00",
    weekProfitRate: "0.00", monthProfitRate: "0.00", yearProfitRate: "0.00",
    compareIndex: "000001", compareLabel: "上证指数",
    availableIndices: [
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "399006", name: "创业板指" },
      { code: "000300", name: "沪深300" },
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
    this._loadFundCache();
    this._fromCache();
  },

  onShow() {
    if (this._first) { this._first = false; }
    else {
      const now = Date.now();
      if (!this._lastFetch || now - this._lastFetch >= 30000) {
        this._lastFetch = now;
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
      // 去掉最后一天不完整数据（部分基金净值未公布会导致市值虚降）
      if (allDaily.length >= 2) {
        const lastCnt = hs.reduce((c, h) => c + ((navMap[h.fundCode || ''] || []).some(x => x.date === allDaily[allDaily.length - 1].date) ? 1 : 0), 0);
        const prevCnt = hs.reduce((c, h) => c + ((navMap[h.fundCode || ''] || []).some(x => x.date === allDaily[allDaily.length - 2].date) ? 1 : 0), 0);
        if (lastCnt < prevCnt) allDaily.pop();
      }

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
    const w = this._canvasW || 340, h = this._canvasH || 200;

    if (this.data.activeTab === 'today') {
      const raw = this._intradayRaw || [];
      if (raw.length < 2) {
        if (!this._fetchingToday) this.fetchIntraday();
        return;
      }
      const query = wx.createSelectorQuery();
      query.select('#todayCanvas').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const dpr = wx.getSystemInfoSync().pixelRatio;
        const cw = res[0].width || w;
        const ch = res[0].height || h;
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const p = { t: 40, r: 24, b: 36, l: 52 };
        const data = raw.map(d => ({ date: d.time, value: d.changeRate }));
        const allVals = data.map(d => d.value);
        const fundRate = parseFloat(this.data.todayProfitRate || 0);
        allVals.push(fundRate);
        if (this._fundPoints) this._fundPoints.forEach(d => allVals.push(d.rate));
        const mn = Math.min(...allVals), mx = Math.max(...allVals);
        const rg = mx - mn || 0.01, y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
        const pw = cw - p.l - p.r, ph = ch - p.t - p.b;
        const xi = i => p.l + (pw / (data.length - 1)) * i;
        const yi = v => p.t + ph - ((v - y0) / (y1 - y0)) * ph;

        ctx.fillStyle = '#FFF';
        ctx.fillRect(0, 0, cw, ch);

        // 分时线
        let started = false;
        ctx.beginPath();
        data.forEach((d, i) => {
          const x = xi(i), y = yi(d.value);
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          started = true;
        });
        ctx.strokeStyle = '#1976D2';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 收益曲线（轮询攒的点）或参考线（单个点）
        const fundPoints = this._fundPoints || [];
        const color = fundRate >= 0 ? '#E4393C' : '#2E8B57';

        if (fundPoints.length >= 2) {
          // 有时间换算函数：HH:MM → 图表 X 坐标
          const timeToX = (t) => {
            const [hh, mm] = t.split(':').map(Number);
            const mins = (hh - 9) * 60 + (mm - 30);
            return p.l + (pw * mins / 330);
          };
          let fs = false;
          ctx.beginPath();
          fundPoints.forEach(d => {
            const x = timeToX(d.time), y = yi(d.rate);
            fs ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            fs = true;
          });
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          const fundY = yi(fundRate);
          if (fundY >= p.t && fundY <= ch - p.b) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.l, fundY);
            ctx.lineTo(cw - p.r, fundY);
            ctx.stroke();
          }
        }

        // 图例
        ctx.font = '9px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1976D2';
        ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.fillStyle = '#666';
        ctx.textAlign = 'left';
        const idxRate = data[data.length - 1].value;
        const idxLabel = this.data.compareLabel + ' ' + (idxRate > 0 ? '+' : '') + idxRate + '%';
        ctx.fillText(idxLabel, p.l + 20, 12);
        ctx.fillStyle = color;
        ctx.fillRect(p.l + 4, 22, 12, 4);
        ctx.fillStyle = '#666';
        ctx.fillText('我的收益 ' + (fundRate > 0 ? '+' : '') + fundRate + '%', p.l + 20, 24);

        // Y轴
        ctx.fillStyle = '#999';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= 4; i++) {
          const v = y1 - (y1 - y0) / 4 * i;
          ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v));
        }

        // X轴
        ctx.font = '9px sans-serif';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillText('09:30', p.l, ch - p.b + 8);
        ctx.textAlign = 'center';
        ctx.fillText('11:30', p.l + pw / 2, ch - p.b + 8);
        ctx.textAlign = 'right';
        ctx.fillText('15:00', cw - p.r, ch - p.b + 8);
        // 保存绘制参数供触摸 tooltip
        this._todayDraw = { raw, data, fundPoints, p, cw, ch, pw, ph, y0, y1, xi, yi, fundRate, color,
          timeToX: (t) => {
            const [hh, mm] = t.split(':').map(Number);
            return p.l + (pw * ((hh - 9) * 60 + (mm - 30)) / 330);
          },
        };
      });

      return;
    }

    const ctx = wx.createCanvasContext('profitCanvas', this);
    const r = this._data(); if (!r) return;
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

    // 保存绘制参数供触摸 tooltip（周/月/年图表）
    this._chartDraw = { data, p, w, h, noIdx, hasP, compareLabel: this.data.compareLabel };
  },

  _line(ctx, data, f, xi, yi, c) { let s = false; ctx.beginPath(); data.forEach((d, i) => { if (d[f] === null) { s = false; return; } const x = xi(i), y = yi(d[f]); s ? ctx.lineTo(x, y) : ctx.moveTo(x, y); s = true; }); ctx.setStrokeStyle(c); ctx.setLineWidth(2); ctx.stroke(); },

  async fetchIntraday() {
    if (this._fetchingToday) return;
    this._fetchingToday = true;
    try {
      const res = await api.fetchIndexIntraday(this.data.compareIndex);
      if (res.code === 0 && res.data && res.data.length > 0) {
        this._intradayRaw = res.data;
        this.setData({ _t: Date.now() }, () => this._draw());
      } else {
        wx.showToast({ title: "暂无当天走势数据", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "获取失败", icon: "none" });
    }
    this._fetchingToday = false;
  },

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

  onSummaryTap(e) { const tab = e.currentTarget.dataset.tab; this.setData({ activeTab: tab }, () => this._draw()); },
  onCalendarTab(e) { this._cal(); this.setData({ calendarView: e.currentTarget.dataset.tab }); },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },
  onMonthChange(e) { const m = this.data.availableMonths[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedMonth: m, dayCalendar: this._days(this._dailyChange, m, dm) }); },
  onYearChange(e) { const y = this.data.availableYears[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedYear: y, monthCalendar: this._mons(this._dailyChange, y, dm) }); },
  onToggleMode() { this._cal(); this.setData({ profitMode: this.data.profitMode === 'amount' ? 'rate' : 'amount' }); },
  onSelectIndex(e) { const { code, name } = e.currentTarget.dataset; if (code === this.data.compareIndex) return; this.setData({ compareIndex: code, compareLabel: name }); if (this.data.activeTab === 'today') { delete this._intradayRaw; this._fetchingToday = false; this.fetchIntraday(); return; } const data = this._idxMap ? this._idxMap[code] : null; if (!data || !data.length) { this._fetch(); return; } this._indexDaily = data; this._draw(); },

  onTodayTouch(e) {
    const d = this._todayDraw;
    if (!d) return;

    if (e.type === 'touchstart') {
      this._ttSY = e.touches[0].y;
      this._ttSX = e.touches[0].x;
      this._ttActive = false;
      return;
    }
    if (e.type === 'touchend') {
      this._ttActive = false;
      this._draw();
      return;
    }
    // 区分横向滑动和纵向滚动
    if (!this._ttActive) {
      const dy = Math.abs(e.touches[0].y - this._ttSY);
      const dx = Math.abs(e.touches[0].x - this._ttSX);
      if (dy > dx && dy > 8) return;
      if (dx > dy && dx > 8) this._ttActive = true;
    }
    if (!this._ttActive) return;

    // 60fps 节流
    const now = Date.now();
    if (this._ttT && now - this._ttT < 60) return;
    this._ttT = now;

    const { data, fundPoints, p, cw, ch, pw, ph, y0, y1, xi, yi, fundRate, color, timeToX } = d;
    const query = wx.createSelectorQuery();
    query.select('#todayCanvas').fields({ node: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const dpr = wx.getSystemInfoSync().pixelRatio;
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      ctx.scale(dpr, dpr);

      // 重绘底图
      ctx.fillStyle = '#FFF';
      ctx.fillRect(0, 0, cw, ch);
      let started = false;
      ctx.beginPath();
      data.forEach((pt, i) => {
        const x = xi(i), y = yi(pt.value);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      });
      ctx.strokeStyle = '#1976D2';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 收益曲线
      if (fundPoints.length >= 2) {
        let fs = false;
        ctx.beginPath();
        fundPoints.forEach(pt => {
          const x = timeToX(pt.time), y = yi(pt.rate);
          fs ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          fs = true;
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        const fy = yi(fundRate);
        if (fy >= p.t && fy <= ch - p.b) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.l, fy);
          ctx.lineTo(cw - p.r, fy);
          ctx.stroke();
        }
      }

      // 找最近点
      const px = e.touches[0].x;
      let nearest = 0, minDist = Infinity;
      data.forEach((pt, i) => { const dist = Math.abs(xi(i) - px); if (dist < minDist) { minDist = dist; nearest = i; } });
      const pt = data[nearest], cx = xi(nearest), cy = yi(pt.value);
      const fmt = v => v != null ? (v > 0 ? '+' : '') + v + '%' : '--';
      // 找最近收益点
      let fundV = fundRate;
      if (fundPoints.length) {
        let fN = 0, fMin = Infinity;
        fundPoints.forEach((fp, i) => { const dist = Math.abs(timeToX(fp.time) - cx); if (dist < fMin) { fMin = dist; fN = i; } });
        fundV = fundPoints[fN].rate;
      }

      // 补坐标轴和图例(用触摸点的值)
      ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(this.data.compareLabel + ' ' + fmt(pt.value), p.l + 20, 12);
      ctx.fillStyle = color; ctx.fillRect(p.l + 4, 22, 12, 4);
      ctx.fillStyle = '#666';
      ctx.fillText('我的收益 ' + fmt(fundV), p.l + 20, 24);
      ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) { const v = y1 - (y1 - y0) / 4 * i; ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v)); }
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'top';
      ctx.textAlign = 'left'; ctx.fillText('09:30', p.l, ch - p.b + 8);
      ctx.textAlign = 'center'; ctx.fillText('11:30', p.l + pw / 2, ch - p.b + 8);
      ctx.textAlign = 'right'; ctx.fillText('15:00', cw - p.r, ch - p.b + 8);

      // 竖线+圆点
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, p.t); ctx.lineTo(cx, ch - p.b); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI); ctx.fillStyle = '#FFF'; ctx.fill();
      ctx.strokeStyle = '#1976D2'; ctx.lineWidth = 2; ctx.stroke();
    });
  },

  // 本周/本月/本年走势图触摸
  onChartTouch(e) {
    const d = this._chartDraw;
    if (!d) return;

    if (e.type === 'touchstart') {
      this._ctSY = e.touches[0].y;
      this._ctSX = e.touches[0].x;
      this._ctActive = false;
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
      if (dy > dx && dy > 8) return;
      if (dx > dy && dx > 8) this._ctActive = true;
    }
    if (!this._ctActive) return;

    const now = Date.now();
    if (this._ctT && now - this._ctT < 60) return;
    this._ctT = now;

    const { data, p, w, h, noIdx, hasP, compareLabel } = d;
    const ctx = wx.createCanvasContext('profitCanvas', this);
    const pw = w - p.l - p.r, ph = h - p.t - p.b;

    // 计算范围和坐标
    const allVals = [];
    data.forEach(pt => {
      if (!noIdx && pt.indexRate != null) allVals.push(pt.indexRate);
      if (hasP && pt.baseRate != null) allVals.push(pt.baseRate);
      if (noIdx && pt.baseRate != null) allVals.push(pt.baseRate);
      if (!noIdx && !hasP) allVals.push(pt.indexRate);
    });
    if (!allVals.length) return;
    const mn = Math.min(...allVals), mx = Math.max(...allVals);
    const rg = mx - mn || 0.01;
    const y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
    const xi = i => p.l + (pw / (data.length - 1)) * i;
    const yi = v => p.t + ph - ((v - y0) / (y1 - y0)) * ph;

    // 找最近点
    const px = e.touches[0].x;
    let nearest = 0, minDist = Infinity;
    data.forEach((pt, i) => { const dist = Math.abs(xi(i) - px); if (dist < minDist) { minDist = dist; nearest = i; } });
    const pt = data[nearest], cx = xi(nearest);
    const tv = !noIdx && pt.indexRate != null ? pt.indexRate : pt.baseRate;
    const cy = yi(tv);
    const fmt = v => v != null ? (v > 0 ? '+' : '') + v + '%' : '--';

    // 重绘底图+图例(用触摸点值)
    ctx.setFillStyle('#FFF'); ctx.fillRect(0, 0, w, h);
    if (noIdx) {
      this._line(ctx, data, 'baseRate', xi, yi, '#E4393C');
      ctx.setFontSize(9); ctx.setTextBaseline('middle');
      ctx.setFillStyle('#E4393C'); ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText('我的收益 ' + fmt(pt.baseRate), p.l + 20, 12);
    } else if (hasP) {
      const pc2 = pt.baseRate >= (data[0].baseRate || 0) ? '#E4393C' : '#2E8B57';
      this._line(ctx, data, 'baseRate', xi, yi, pc2);
      this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
      ctx.setFontSize(9); ctx.setTextBaseline('middle');
      ctx.setFillStyle(pc2); ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText('我的收益 ' + fmt(pt.baseRate), p.l + 20, 12);
      ctx.setFillStyle('#1976D2'); ctx.fillRect(p.l + 4, 22, 12, 4);
      ctx.setFillStyle('#666'); ctx.fillText(compareLabel + ' ' + fmt(pt.indexRate), p.l + 20, 24);
    } else {
      this._line(ctx, data, 'indexRate', xi, yi, '#E4393C');
      ctx.setFontSize(9); ctx.setTextBaseline('middle');
      ctx.setFillStyle('#E4393C'); ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.setFillStyle('#666'); ctx.setTextAlign('left'); ctx.fillText(compareLabel + ' ' + fmt(pt.indexRate), p.l + 20, 12);
    }

    // 坐标轴
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

    // 竖线+圆点
    ctx.setStrokeStyle('rgba(0,0,0,0.12)'); ctx.setLineWidth(1);
    ctx.beginPath(); ctx.moveTo(cx, p.t); ctx.lineTo(cx, h - p.b); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.setFillStyle('#FFF'); ctx.fill();
    ctx.setStrokeStyle('#1976D2'); ctx.setLineWidth(2); ctx.stroke();
    ctx.draw();
  },

  // ============ 收益轮询 ============

  _getFundCacheKey() { return `fund_intraday_${calc.formatDate(new Date())}`; },

  _loadFundCache() {
    try {
      const key = this._getFundCacheKey();
      const cached = wx.getStorageSync(key);
      if (cached && Array.isArray(cached) && cached.length) {
        this._fundPoints = cached;
        return;
      }
    } catch (e) {}
    this._fundPoints = [];
  },

  _saveFundCache() {
    try {
      wx.setStorageSync(this._getFundCacheKey(), this._fundPoints);
    } catch (e) {}
  },

  _isTradingNow() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const min = now.getMinutes();
    const afterOpen = hour > 9 || (hour === 9 && min >= 30);
    const beforeClose = hour < 15 || (hour === 15 && min === 0);
    return day >= 1 && day <= 5 && afterOpen && beforeClose;
  },

  _startPolling() {
    console.log('[轮询] 启动, 当前点数:', this._fundPoints.length);
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
    this._pollingNow = true;
    try {
      const res = await api.getPortfolio();
      if (!res.result || res.result.code !== 0) return;
      const rate = parseFloat(res.result.data.todayProfitRate || 0);
      const tp = res.result.data.todayProfit || "0";
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const last = this._fundPoints[this._fundPoints.length - 1];
      console.log('[轮询] 时间:', time, 'rate:', rate, '已攒点数:', this._fundPoints.length + 1);
      if (!last || last.time !== time) {
        this._fundPoints.push({ time, rate });
        this._saveFundCache();
        this.setData({ todayProfitRate: rate, todayProfit: tp });
        // 同步刷新指数分时线，保证两条线点数一致
        if (this.data.activeTab === 'today') {
          api.fetchIndexIntraday(this.data.compareIndex).then(res => {
            if (res.code === 0 && res.data) this._intradayRaw = res.data;
            this._draw();
          });
        }
      }
    } catch (e) {}
    this._pollingNow = false;
  },

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
