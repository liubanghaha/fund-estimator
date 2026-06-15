const api = require("../../utils/api");
const calc = require("../../utils/calculator");

const CACHE = "profit_detail_cache_v2";

Page({
  data: {
    activeTab: "week", // 当天走势对比图已禁用，默认展示本周
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
        this._cachedProfit = c.s ? { tp: c.s.tp, tpr: c.s.tpr } : null;
        this._fromCache = true;
        this.setData({
          loading: false,
          totalCost: c.tc,
          todayProfit: c.s.tp, todayProfitRate: c.s.tpr,
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
    // 当天走势对比图已禁用
    // if (this.data.activeTab === 'today') this.fetchIntraday();
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

      // 合并服务端快照到收益曲线（去重）
      const mergeSnapshots = (snapshots) => {
        if (!snapshots || !snapshots.length) return;
        const curMap = {};
        (this._fundPoints || []).forEach(p => { curMap[p.time] = p.rate; });
        snapshots.forEach(p => {
          if (!curMap[p.time]) {
            if (!this._fundPoints) this._fundPoints = [];
            this._fundPoints.push({ time: p.time, rate: p.rate });
          }
        });
        this._fundPoints.sort((a, b) => a.time.localeCompare(b.time));
      };
      mergeSnapshots(d.intradaySnapshots);

      // 如果服务端没返回，直接客户端读 profit_snapshots（取最近有数据的日期）
      if (!(d.intradaySnapshots && d.intradaySnapshots.length)) {
        try {
          const snapRes = await wx.cloud.database().collection("profit_snapshots")
            .orderBy("date", "desc").limit(1).get();
          if (snapRes.data && snapRes.data.length) {
            mergeSnapshots(snapRes.data[0].points);
          }
        } catch (e) { /* ignore */ }
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
      const isTradingDay = lastDate === today;
      if (!isTradingDay) {
        Object.keys(idxMap).forEach(k => { idxMap[k] = (idxMap[k] || []).filter(d => d.date !== today); });
      }
      const tp = parseFloat(d.todayProfit) || 0;
      if (tp !== 0) dcFinal[today] = tp;

      // 收益
      const ws = this._mon(now);
      const cm = today.slice(0, 7), cy = today.slice(0, 4);
      const sm = (s, pf, len) => { let x = 0; for (const [dt, v] of Object.entries(dcFinal)) { if (dt < s) continue; if (pf && dt.slice(0, len) !== pf) continue; x += v; } return +x.toFixed(2); };
      const w = sm(ws), m = sm(cm + "-01", cm, 7), y = sm(cy + "-01-01", cy, 4);
      // 收益率以周期起始日前一个交易日的市值为分母
      const mvBefore = (d) => { for (let i = allDaily.length - 1; i >= 0; i--) { if (allDaily[i].date < d) return allDaily[i].value; } return allDaily.length ? allDaily[0].value : totalCost; };
      const rtMV = (v, baseMV) => baseMV > 0 ? +((v / baseMV) * 100).toFixed(2) : 0;

      this._allDaily = allDaily;
      this._dailyChange = dcFinal;
      this._indexDaily = idxMap[this.data.compareIndex] || [];
      this._totalCost = totalCost;
      this._fromCache = false;

      const earliestCreate = hs.reduce((min, h) => { if (!h.createTime) return min; const d = calc.formatDate(h.createTime); return d < min ? d : min; }, "9999-99-99");

      this.setData({
        loading: false,
        totalCost,
        todayProfitRate: parseFloat(d.todayProfitRate || 0),
        todayProfit: tp.toFixed(2),
        weekProfit: w, monthProfit: m, yearProfit: y,
        weekProfitRate: rtMV(parseFloat(w), mvBefore(ws)), monthProfitRate: rtMV(parseFloat(m), mvBefore(cm + "-01")), yearProfitRate: rtMV(parseFloat(y), mvBefore(cy + "-01-01")),
        earliestDate: earliestCreate === "9999-99-99" ? "" : earliestCreate,
      }, () => { this._draw(); this._cal(); });

      const cal = this._calCached();
      const hasIndex = Object.values(idxMap).some(arr => arr && arr.length);
      if (hasIndex) {
        this._retryCount = 0;
        wx.setStorage({ key: CACHE, data: { d: allDaily, dc: dcFinal, idx: this._indexDaily, im: idxMap, ed: earliestCreate, tc: totalCost, s: { tp: tp.toFixed(2), tpr: parseFloat(d.todayProfitRate || 0), w, m, y, wr: rtMV(parseFloat(w), mvBefore(ws)), mr: rtMV(parseFloat(m), mvBefore(cm + "-01")), yr: rtMV(parseFloat(y), mvBefore(cy + "-01-01")) }, cal, ts: Date.now() } });
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
    const im = {}; idx.forEach(d => { im[d.date] = d; });

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

    const hasIdx = ib !== null;
    const validProfit = data.filter(d => d.baseRate !== null);
    const validIdx = data.filter(d => d.indexRate !== null);
    if (validProfit.length === 0 && validIdx.length === 0) return null;

    return { data, hasP: validProfit.length > 0, noIdx: !hasIdx };
  },

  _draw() {
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const isToday = this.data.activeTab === 'today';

    if (isToday) return; // 当天走势对比图已禁用

    const r = isToday ? null : this._data();

    const query = wx.createSelectorQuery();
    query.select('#profitCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const dpr = wx.getSystemInfoSync().pixelRatio;
      const cw = res[0].width || w;
      const ch = res[0].height || h;
      // 微信 Canvas 2D：先置零强制清除，再用像素坐标 clearRect 兜底
      const targetW = cw * dpr, targetH = ch * dpr;
      canvas.width = 1; canvas.height = 1;
      canvas.width = targetW; canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, targetW, targetH);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetW, targetH);
      ctx.scale(dpr, dpr);

      if (!r) {
        ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch);
        return;
      }

      if (isToday) {
        this._drawToday(ctx, cw, ch);
      } else {
        this._drawHistory(ctx, cw, ch, r);
      }
    });
  },

  _drawToday(ctx, cw, ch) {
    const raw = this._intradayRaw || this._intradayRawCached || [];
    const fundPoints = this._fundPoints || [];
    const isCached = !this._intradayRaw && this._intradayRawCached;
    const hasIndex = raw.length >= 2;
    const p = { t: 40, r: 24, b: 36, l: 52 };
    const data = hasIndex ? raw.map(d => ({ date: d.time, value: d.changeRate })) : [];
    const allVals = data.map(d => d.value);
    const fundRate = parseFloat(this.data.todayProfitRate || 0);
    allVals.push(fundRate);
    if (fundPoints.length) fundPoints.forEach(d => allVals.push(d.rate));
    let mn = Math.min(...allVals), mx = Math.max(...allVals);
    if (mn > 0) mn = 0; if (mx < 0) mx = 0;
    const rg = mx - mn || 0.01, y0 = mn - rg * 0.15, y1 = mx + rg * 0.15;
    const pw = cw - p.l - p.r, ph = ch - p.t - p.b;
    const timeToX = (t) => {
      const [hh, mm] = (t || '09:30').split(':').map(Number);
      const total = hh * 60 + mm;
      let eff;
      if (total <= 690) eff = Math.max(0, total - 570);
      else if (total >= 780) eff = 120 + Math.min(120, total - 780);
      else eff = 120;
      return p.l + (pw * eff / 240);
    };
    const yi = v => p.t + ph - ((v - y0) / (y1 - y0)) * ph;
    const color = fundRate >= 0 ? '#E4393C' : '#2E8B57';

    this._drawGrid(ctx, p, cw, ch, y0, y1, yi);
    this._drawIndexCurve(ctx, data, hasIndex, timeToX, yi);
    this._drawProfitCurve(ctx, fundPoints, fundRate, timeToX, yi);
    this._drawLegend(ctx, p, cw, data, hasIndex, fundRate, color, isCached);
    this._drawAxis(ctx, p, cw, ch, y0, y1, yi, timeToX, true);
    this._todayDraw = { raw, data, fundPoints: this._fundPoints, p, cw, ch, pw, ph, y0, y1, yi, fundRate, color, timeToX, hasIndex };
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
        this._fillArea(ctx, data, 'baseRate', xi, yi, '#E4393C');
        this._line(ctx, data, 'baseRate', xi, yi, '#E4393C');
        ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#E4393C'; ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText(label || '收益', p.l + 20, 12);
      } else if (marker === 'dual') {
        this._fillArea(ctx, data, 'baseRate', xi, yi, profitColor);
        this._fillArea(ctx, data, 'indexRate', xi, yi, '#1976D2');
        this._line(ctx, data, 'baseRate', xi, yi, profitColor);
        this._line(ctx, data, 'indexRate', xi, yi, '#1976D2');
        ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillStyle = profitColor; ctx.fillRect(p.l + 4, 10, 12, 4);
        ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText('我的收益', p.l + 20, 12);
        ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 22, 12, 4);
        ctx.fillStyle = '#666'; ctx.fillText(this.data.compareLabel, p.l + 20, 24);
      } else {
        this._fillArea(ctx, data, 'indexRate', xi, yi, '#E4393C');
        this._line(ctx, data, 'indexRate', xi, yi, '#E4393C');
        ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#E4393C'; ctx.fillRect(p.l + 4, 10, 12, 4);
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

  _drawIndexCurve(ctx, data, hasIndex, timeToX, yi) {
    if (!hasIndex) return;
    ctx.beginPath();
    data.forEach((d, i) => { const x = timeToX(d.date); i === 0 ? ctx.moveTo(x, yi(d.value)) : ctx.lineTo(x, yi(d.value)); });
    ctx.strokeStyle = '#1976D2'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath();
    data.forEach((d, i) => { const x = timeToX(d.date); i === 0 ? ctx.moveTo(x, yi(d.value)) : ctx.lineTo(x, yi(d.value)); });
    ctx.lineTo(timeToX(data[data.length - 1].date), yi(0));
    ctx.lineTo(timeToX(data[0].date), yi(0));
    ctx.closePath(); ctx.fillStyle = 'rgba(25,118,210,0.06)'; ctx.fill();
  },

  _drawProfitCurve(ctx, fundPoints, fundRate, timeToX, yi) {
    const color = fundRate >= 0 ? '#E4393C' : '#2E8B57';
    if (fundPoints.length >= 2) {
      ctx.beginPath();
      fundPoints.forEach((d, i) => { const x = timeToX(d.time); i === 0 ? ctx.moveTo(x, yi(d.rate)) : ctx.lineTo(x, yi(d.rate)); });
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath();
      fundPoints.forEach((d, i) => { const x = timeToX(d.time); i === 0 ? ctx.moveTo(x, yi(d.rate)) : ctx.lineTo(x, yi(d.rate)); });
      ctx.lineTo(timeToX(fundPoints[fundPoints.length - 1].time), yi(0));
      ctx.lineTo(timeToX(fundPoints[0].time), yi(0));
      ctx.closePath(); ctx.fillStyle = color === '#E4393C' ? 'rgba(228,57,60,0.06)' : 'rgba(46,139,87,0.06)'; ctx.fill();
    } else if (fundPoints.length === 1) {
      const x = timeToX(fundPoints[0].time), y = yi(fundPoints[0].rate);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    }
  },

  _drawLegend(ctx, p, cw, data, hasIndex, fundRate, color, isCached) {
    ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
    if (hasIndex) {
      ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.textAlign = 'left';
      const idxRate = data[data.length - 1].value;
      ctx.fillText(this.data.compareLabel + ' ' + (idxRate > 0 ? '+' : '') + idxRate + '%', p.l + 20, 12);
      ctx.fillStyle = color; ctx.fillRect(p.l + 4, 22, 12, 4);
      ctx.fillStyle = '#666';
      ctx.fillText('我的收益 ' + (fundRate > 0 ? '+' : '') + fundRate + '%', p.l + 20, 24);
    } else {
      ctx.fillStyle = color; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.textAlign = 'left';
      ctx.fillText('我的收益 ' + (fundRate > 0 ? '+' : '') + fundRate + '%', p.l + 20, 12);
    }
    if (isCached && this._intradayCacheDate) {
      ctx.fillStyle = '#BBB'; ctx.font = '8px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(this._intradayCacheDate + ' 数据', cw - p.r, 12);
    }
  },

  _drawAxis(ctx, p, cw, ch, y0, y1, yi, timeToX, isToday) {
    ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) { const v = y1 - (y1 - y0) / 4 * i; ctx.fillText(v.toFixed(1) + '%', p.l - 6, yi(v)); }
    ctx.font = '9px sans-serif'; ctx.textBaseline = 'top';
    if (isToday) {
      const xLabels = [{ t: '09:30', a: 'left' }, { t: '11:30', a: 'center' }, { t: '13:00', a: 'center' }, { t: '15:00', a: 'right' }];
      xLabels.forEach(l => { ctx.textAlign = l.a; ctx.fillText(l.t, timeToX(l.t), ch - p.b + 8); });
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

  async fetchIntraday() {
    if (this._fetchingToday) return;
    this._fetchingToday = true;
    try {
      const res = await api.fetchIndexIntraday(this.data.compareIndex);
      if (res.code === 0 && res.data && res.data.length > 0) {
        this._intradayRaw = res.data;
        this._intradayRawCached = res.data;
        this._saveFundCache();
        this.setData({ _t: Date.now() }, () => this._draw());
      } else if (!this._intradayRawCached) {
        wx.showToast({ title: "暂无当天走势数据", icon: "none" });
      }
    } catch (e) {
      if (!this._intradayRawCached) wx.showToast({ title: "获取失败", icon: "none" });
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
  onSelectIndex(e) { const { code, name } = e.currentTarget.dataset; if (code === this.data.compareIndex) return; this.setData({ compareIndex: code, compareLabel: name }); /* 当天走势对比图已禁用 if (this.data.activeTab === 'today') { delete this._intradayRaw; this._fetchingToday = false; this.fetchIntraday(); return; } */ const data = this._idxMap ? this._idxMap[code] : null; if (!data || !data.length) { this._fetch(); return; } this._indexDaily = data; this._draw(); },

  onCanvasTouch(e) {
    const isToday = this.data.activeTab === 'today';
    const d = isToday ? this._todayDraw : this._chartDraw;
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
      const dpr = wx.getSystemInfoSync().pixelRatio;
      canvas.width = d.cw * dpr;
      canvas.height = d.ch * dpr;
      ctx.scale(dpr, dpr);

      if (isToday) {
        this._touchToday(ctx, d, e.touches[0].x);
      } else {
        this._touchHistory(ctx, d, e.touches[0].x);
      }
    });
  },

  _touchToday(ctx, d, px) {
    const { data, fundPoints, p, cw, ch, y0, y1, yi, fundRate, color, timeToX, hasIndex } = d;
    ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch);
    this._drawGrid(ctx, p, cw, ch, y0, y1, yi);
    this._drawIndexCurve(ctx, data, hasIndex, timeToX, yi);
    this._drawProfitCurve(ctx, fundPoints, fundRate, timeToX, yi);

    const fmt = v => v != null ? (v > 0 ? '+' : '') + v + '%' : '--';
    let cx, cy, idxVal;
    if (hasIndex) {
      let nearest = 0, minDist = Infinity;
      data.forEach((pt, i) => { const dist = Math.abs(timeToX(pt.date) - px); if (dist < minDist) { minDist = dist; nearest = i; } });
      cx = timeToX(data[nearest].date); cy = yi(data[nearest].value); idxVal = data[nearest].value;
    } else if (fundPoints.length) {
      let nearest = 0, minDist = Infinity;
      fundPoints.forEach((pt, i) => { const dist = Math.abs(timeToX(pt.time) - px); if (dist < minDist) { minDist = dist; nearest = i; } });
      cx = timeToX(fundPoints[nearest].time); cy = yi(fundPoints[nearest].rate);
    }
    let fundV = fundRate;
    if (fundPoints.length) {
      let fN = 0, fMin = Infinity;
      fundPoints.forEach((fp, i) => { const dist = Math.abs(timeToX(fp.time) - (cx || px)); if (dist < fMin) { fMin = dist; fN = i; } });
      fundV = fundPoints[fN].rate;
    }
    ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (hasIndex) {
      ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.fillText(this.data.compareLabel + ' ' + fmt(idxVal), p.l + 20, 12);
      ctx.fillStyle = color; ctx.fillRect(p.l + 4, 22, 12, 4);
      ctx.fillStyle = '#666'; ctx.fillText('我的收益 ' + fmt(fundV), p.l + 20, 24);
    } else {
      ctx.fillStyle = color; ctx.fillRect(p.l + 4, 10, 12, 4);
      ctx.fillStyle = '#666'; ctx.fillText('我的收益 ' + fmt(fundV), p.l + 20, 12);
    }
    this._drawAxis(ctx, p, cw, ch, y0, y1, yi, timeToX, true);
    if (cx != null) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, p.t); ctx.lineTo(cx, ch - p.b); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 2 * Math.PI); ctx.fillStyle = '#FFF'; ctx.fill();
      ctx.strokeStyle = '#1976D2'; ctx.lineWidth = 1; ctx.stroke();
      // 收益曲线上的对应点
      if (fundPoints.length) {
        const fy = yi(fundV);
        ctx.beginPath(); ctx.arc(cx, fy, 4, 0, 2 * Math.PI); ctx.fillStyle = '#FFF'; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  },

  _touchHistory(ctx, d, px) {
    const { data, p, cw, ch, pw, ph, y0, y1, xi, yi, noIdx, hasP, compareLabel } = d;
    ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch);
    this._drawGrid(ctx, p, cw, ch, y0, y1, yi);

    let nearest = 0, minDist = Infinity;
    data.forEach((pt, i) => { const dist = Math.abs(xi(i) - px); if (dist < minDist) { minDist = dist; nearest = i; } });
    const pt = data[nearest], cx = xi(nearest);
    const tv = !noIdx && pt.indexRate != null ? pt.indexRate : pt.baseRate;
    const fmt = v => v != null ? (v > 0 ? '+' : '') + v + '%' : '--';

    if (noIdx) {
      this._fillArea(ctx, data, 'baseRate', xi, yi, '#E4393C');
      this._line(ctx, data, 'baseRate', xi, yi, '#E4393C');
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#E4393C'; ctx.fillRect(p.l + 4, 10, 12, 4);
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
      this._fillArea(ctx, data, 'indexRate', xi, yi, '#E4393C');
      this._line(ctx, data, 'indexRate', xi, yi, '#E4393C');
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#E4393C'; ctx.fillRect(p.l + 4, 10, 12, 4);
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
  },

  // ============ 收益轮询 ============

  _getFundCacheKey() { return `fund_intraday_cache`; },

  _loadFundCache() {
    try {
      const cached = wx.getStorageSync(this._getFundCacheKey());
      if (cached && cached.fp && Array.isArray(cached.fp) && cached.fp.length) {
        this._fundPoints = cached.fp;
      } else {
        this._fundPoints = [];
      }
      if (cached && cached.ir && Array.isArray(cached.ir) && cached.ir.length) {
        this._intradayRawCached = cached.ir;
        this._intradayCacheDate = cached.d || '';
      }
    } catch (e) { this._fundPoints = []; }
  },

  _saveFundCache() {
    try {
      const raw = this._intradayRaw && this._intradayRaw.length ? this._intradayRaw : (this._intradayRawCached || null);
      wx.setStorageSync(this._getFundCacheKey(), {
        fp: this._fundPoints,
        ir: raw,
        d: calc.formatDate(new Date()),
      });
    } catch (e) {}
  },

  _isTradingNow() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const min = now.getMinutes();
    const afterOpen = hour > 9 || (hour === 9 && min >= 30);
    const beforeClose = hour < 15 || (hour === 15 && min === 0);
    // 跳过午休 11:30-13:00
    const totalMin = hour * 60 + min;
    const isLunch = totalMin > 690 && totalMin < 780;
    return day >= 1 && day <= 5 && afterOpen && beforeClose && !isLunch;
  },

  _startPolling() {
    this._stopPolling();
    this._pollFundRate();
    this._pollTimer = setInterval(() => this._pollFundRate(), 5000);
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
      if (!last || last.time !== time) {
        this._fundPoints.push({ time, rate });
        this._saveFundCache();
        this.setData({ todayProfitRate: rate, todayProfit: tp });
        // 当天走势对比图已禁用，不再同步刷新指数分时线
        // if (this.data.activeTab === 'today') {
        //   api.fetchIndexIntraday(this.data.compareIndex).then(res => {
        //     if (res.code === 0 && res.data) this._intradayRaw = res.data;
        //     this._draw();
        //   });
        // }
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
