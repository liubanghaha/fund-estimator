
const api = require("../../utils/api");
const calc = require("../../utils/calculator");

const CACHE = "profit_detail_cache_v2";
const INTRADAY_CACHE_PREFIX = "intraday_v2_";
const chartUtil = require("../../utils/chart");

Page({
  data: {
    activeTab: "today",
    profitMode: "amount",
    loading: true,
    loadError: false,
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
    if (typeof wx.showChangelog === 'function') wx.showChangelog();
    this._fromCache();
  },

  onShow() {
    if (this._first) { this._first = false; }
    else {
      const now = Date.now();
      const cacheAge = this._lastFetch ? (now - this._lastFetch) : Infinity;
      const isTrading = this._isTradingNow();
      const ttl = isTrading ? 30000 : 120000;
      if (cacheAge > ttl) {
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
        // 缓存的当日条目可能是非交易日残留，先移除；_fetch() 验证后加回
        const cachedToday = calc.formatDate(new Date());
        if (this._dailyChange[cachedToday]) delete this._dailyChange[cachedToday];
        this._indexDaily = c.idx;
        this._idxMap = c.im || {};
        this._totalCost = c.tc;
        this._cachedProfit = c.s ? { tp: c.s.tp, tpr: c.s.tpr } : null;
        this._cacheApplied = true;
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
        // 缓存渲染后立即后台刷新，确保不展示过期数据
        this._lastFetch = 0;
        this._fetch();
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
        if (!this._cacheApplied) wx.showToast({ title: '数据加载失败', icon: 'none' });
        this.setData({ loading: false, loadError: true });
        return;
      }
      const d = pfRes.result.data;

      this._profitSnapshots = (d.intradaySnapshots && d.intradaySnapshots.length)
        ? d.intradaySnapshots.slice().sort((a, b) => a.time.localeCompare(b.time))
        : [];

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
      const hasTodaySnaps = d.intradaySnapshots && d.intradaySnapshots.length > 0;
      const isTradingDay = lastDate === today || hasTodaySnaps;
      if (!isTradingDay) {
        Object.keys(idxMap).forEach(k => { idxMap[k] = (idxMap[k] || []).filter(d => d.date !== today); });
      }
      const tp = parseFloat(d.todayProfit) || 0;
      if (isTradingDay && tp !== 0) dcFinal[today] = tp;

      // 收益率：和走势图一致，用「期末市值 / 期初市值 - 1」
      const ws = this._mon(now);
      const cm = today.slice(0, 7), cy = today.slice(0, 4);
      const calcPeriodRate = (startDate) => {
        let first = null, last = null;
        for (let i = 0; i < allDaily.length; i++) {
          if (allDaily[i].date >= startDate) {
            if (first === null) {
              for (let j = i - 1; j >= 0; j--) { if (allDaily[j].date < startDate) { first = allDaily[j].value; break; } }
              if (first === null) first = allDaily[i].value;
            }
            last = allDaily[i].value;
          }
        }
        if (!first || !last || first <= 0) return { rate: 0, amount: 0 };
        return {
          rate: +((last / first - 1) * 100).toFixed(2),
          amount: +(last - first).toFixed(2),
        };
      };
      const wr = calcPeriodRate(ws), mr = calcPeriodRate(cm + "-01"), yr = calcPeriodRate(cy + "-01-01");
      const weekProfitRate = wr.rate, monthProfitRate = mr.rate, yearProfitRate = yr.rate;
      const w = wr.amount, m = mr.amount, y = yr.amount;

      this._allDaily = allDaily;
      this._dailyChange = dcFinal;
      this._indexDaily = idxMap[this.data.compareIndex] || [];
      this._totalCost = totalCost;
      this._cacheApplied = false;

      const earliestCreate = hs.reduce((min, h) => { if (!h.createTime) return min; const d = calc.formatDate(h.createTime); return d < min ? d : min; }, "9999-99-99");

      this.setData({
        loading: false,
        totalCost,
        todayProfitRate: parseFloat(d.todayProfitRate || 0),
        todayProfit: tp.toFixed(2),
        weekProfit: w, monthProfit: m, yearProfit: y,
        weekProfitRate, monthProfitRate, yearProfitRate,
        earliestDate: earliestCreate === "9999-99-99" ? "" : earliestCreate,
      }, () => { this._draw(); this._cal(); });
      if (this.data.activeTab === 'today') this.fetchIntraday();

      const cal = this._calCached();
      const hasIndex = Object.values(idxMap).some(arr => arr && arr.length);
      if (hasIndex) {
        this._retryCount = 0;
        wx.setStorage({ key: CACHE, data: { d: allDaily, dc: dcFinal, idx: this._indexDaily, im: idxMap, ed: earliestCreate, tc: totalCost, s: { tp: tp.toFixed(2), tpr: parseFloat(d.todayProfitRate || 0), w, m, y, wr: weekProfitRate, mr: monthProfitRate, yr: yearProfitRate }, cal, ts: Date.now() } });
      } else {
        this._retryCount = (this._retryCount || 0) + 1;
        if (this._retryCount <= 3) setTimeout(() => this._fetch(), 2000);
      }
    } catch (e) {
      this.setData({ loading: false, loadError: true });
      if (!this._cacheApplied) wx.showToast({ title: '数据加载失败', icon: 'none' });
    }
  },

  onRetry() {
    this.setData({ loading: true, loadError: false });
    this._fetch();
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
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const isToday = this.data.activeTab === 'today';

    if (isToday) {
      if ((this._profitSnapshots || []).length === 0) {
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
      const dpr = wx.getSystemInfoSync().pixelRatio;
      const cw = res[0].width || w;
      const ch = res[0].height || h;
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

      this._drawHistory(ctx, cw, ch, r);
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
    const fundRate = parseFloat(this.data.todayProfitRate || 0);

    const toChina = (utcTime) => {
      const [hh, mm] = utcTime.split(':').map(Number);
      const totalMin = hh * 60 + mm + 480;
      const ch = Math.floor(totalMin / 60) % 24;
      const cm = totalMin % 60;
      return String(ch).padStart(2, '0') + ':' + String(cm).padStart(2, '0');
    };

    const isTrading = (chinaTime) => {
      const [hh, mm] = chinaTime.split(':').map(Number);
      const total = hh * 60 + mm;
      return (total >= 570 && total <= 690) || (total >= 780 && total <= 900);
    };

    const timeMap = {};
    profitSnaps.forEach(p => {
      const ct = toChina(p.time);
      if (!isTrading(ct)) return;
      timeMap[ct] = timeMap[ct] || { time: ct };
      timeMap[ct].rate = p.rate;
    });
    idxRaw.forEach(d => {
      if (!isTrading(d.time)) return;
      timeMap[d.time] = timeMap[d.time] || { time: d.time };
      timeMap[d.time].indexRate = d.changeRate;
    });

    const result = Object.values(timeMap).sort((a, b) => a.time.localeCompare(b.time));
    const last = result[result.length - 1];
    if (last) last.rate = fundRate;

    const hasRate = result.filter(d => d.rate != null).length;
    const hasIdx = result.filter(d => d.indexRate != null).length;
    if (hasRate > 20 && hasIdx > 20) this._saveTodayCache(result);

    return result;
    } catch(e) {
      return [];
    }
  },

  _drawToday() {
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const compareLabel = this.data.compareLabel || '上证指数';
    const indexCode = this.data.compareIndex || '000001';

    this._todayCaches = this._todayCaches || {};
    const memCache = this._todayCaches[indexCode];
    if (memCache && memCache.data && memCache.data.length > 0) {
      if (this._isTradingNow()) {
        const data = [...memCache.data];
        const last = data[data.length - 1];
        if (last) last.rate = parseFloat(this.data.todayProfitRate || 0);
        this._renderToday(w, h, data, compareLabel);
        return;
      }
      this._renderToday(w, h, memCache.data, compareLabel);
      return;
    }

    const storageData = this._loadTodayCache(indexCode);
    if (storageData) {
      this._renderToday(w, h, storageData, compareLabel);
      return;
    }

    if ((this._profitSnapshots || []).length === 0 && (this._intradayRaw || []).length === 0) return;
    const data = this._buildIntradayData();
    this._renderToday(w, h, data, compareLabel);
  },

  _renderToday(w, h, data, compareLabel) {
    const query = wx.createSelectorQuery();
    query.select('#profitCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      chartUtil.drawIntradayChart(res[0].node, {
        w, h, data,
        labelA: '我的收益', labelB: compareLabel,
      });
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

  async fetchIntraday(indexCode) {
    if (this._fetchingToday) return;
    this._fetchingToday = true;
    const code = indexCode || this.data.compareIndex;
    try {
      const ires = await api.fetchIndexIntradayTencent(code);
      if (ires && ires.code === 0 && ires.data && ires.data.length > 0) {
        this._intradayRaw = ires.data;
      }
      this._todayCaches = this._todayCaches || {};
      delete this._todayCaches[code];
      try { wx.removeStorageSync(INTRADAY_CACHE_PREFIX + code); } catch (e) {}
      this._draw();
    } catch (e) {}
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

  _days(c, month, dm) { const [y, m] = month.split('-').map(Number); const fd = new Date(y, m - 1, 1).getDay(); const dim = new Date(y, m, 0).getDate(); const wks = []; let w = []; for (let i = 0; i < fd; i++) w.push({ day: '', empty: true }); for (let d = 1; d <= dim; d++) { const ds = `${month}-${String(d).padStart(2, '0')}`; const chg = c[ds]; const empty = chg === undefined; const allKeys = Object.keys(dm).sort(); let prevMv = 0; for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= ds) { if (i > 0) prevMv = dm[allKeys[i - 1]]; break; } } const rate = (prevMv > 0 && chg != null) ? +((chg / prevMv) * 100).toFixed(2) : 0; w.push({ day: d, date: ds, profit: empty ? null : chg, rate, empty }); if (w.length === 7) { wks.push(w); w = []; } } while (w.length > 0 && w.length < 7) w.push({ day: '', empty: true }); if (w.length === 7) wks.push(w); return wks; },
  _mons(c, year, dm) { return [1,2,3,4,5,6,7,8,9,10,11,12].map(m => { const pfx = `${year}-${String(m).padStart(2, '0')}`; let s = 0, h = false; for (const [d, chg] of Object.entries(c)) { if (d.startsWith(pfx)) { s += chg; h = true; } } const profit = +s.toFixed(2); const keys = Object.keys(dm).filter(k => k.startsWith(pfx)).sort(); const last = keys.length ? dm[keys[keys.length - 1]] : 0; const allKeys = Object.keys(dm).sort(); let first = last; for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= pfx + '-01') { if (i > 0) first = dm[allKeys[i - 1]]; break; } } const rate = first > 0 ? +((last / first - 1) * 100).toFixed(2) : 0; return { month: m, date: pfx, profit, rate, empty: !h }; }); },
  _yrs(c, dm) { return [...new Set(Object.keys(c).map(d => d.slice(0, 4)))].sort().map(y => { let s = 0; for (const [d, chg] of Object.entries(c)) { if (d.startsWith(y)) s += chg; } const profit = +s.toFixed(2); const keys = Object.keys(dm).filter(k => k.startsWith(y)).sort(); const last = keys.length ? dm[keys[keys.length - 1]] : 0; const allKeys = Object.keys(dm).sort(); let first = last; for (let i = 0; i < allKeys.length; i++) { if (allKeys[i] >= y + '-01-01') { if (i > 0) first = dm[allKeys[i - 1]]; break; } } const rate = first > 0 ? +((last / first - 1) * 100).toFixed(2) : 0; return { date: y + '-12-31', profit, rate }; }); },

  // ============ 事件 ============

  onSummaryTap(e) { const tab = e.currentTarget.dataset.tab; this.setData({ activeTab: tab }, () => { this._draw(); }); },
  onCalendarTab(e) { this._cal(); this.setData({ calendarView: e.currentTarget.dataset.tab }); },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },

  onOpenH5Profit() {
    const { compareIndex, compareLabel, todayProfitRate } = this.data;
    const snaps = this._profitSnapshots || [];
    // 精简快照数据：仅传 time + rate
    const slimSnaps = snaps.map(s => ({ t: s.time, r: s.rate }));
    const snapsJson = encodeURIComponent(JSON.stringify(slimSnaps));
    // TODO: 替换为你的 H5 域名
    const h5Base = wx.getStorageSync('h5_base_url') || 'https://cloudbase-d0gug00io7bfedd97-1434082140.tcloudbaseapp.com';
    const url = `/pages/webview/index?base=${encodeURIComponent(h5Base)}&page=profit-detail.html` +
      `&indexCode=${compareIndex}&indexLabel=${encodeURIComponent(compareLabel || '上证指数')}` +
      `&todayRate=${todayProfitRate || 0}&snapshots=${snapsJson}`;
    wx.navigateTo({ url });
  },
  onMonthChange(e) { const m = this.data.availableMonths[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedMonth: m, dayCalendar: this._days(this._dailyChange, m, dm) }); },
  onYearChange(e) { const y = this.data.availableYears[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedYear: y, monthCalendar: this._mons(this._dailyChange, y, dm) }); },
  onToggleMode() { this._cal(); this.setData({ profitMode: this.data.profitMode === 'amount' ? 'rate' : 'amount' }); },
  onSelectIndex(e) { const { code, name } = e.currentTarget.dataset; if (code === this.data.compareIndex) return; this.setData({ compareIndex: code, compareLabel: name }); if (this.data.activeTab === 'today') { delete this._intradayRaw; this._fetchingToday = false; this.fetchIntraday(code); return; } const data = this._idxMap ? this._idxMap[code] : null; if (!data || !data.length) { this._fetch(); return; } this._indexDaily = data; this._draw(); },

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
        const dpr = wx.getSystemInfoSync().pixelRatio;
        canvas.width = this._canvasW * dpr; canvas.height = this._canvasH * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        chartUtil._drawIntradayFast(ctx);
        chartUtil.handleIntradayTouch(ctx, e);
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
      const dpr = wx.getSystemInfoSync().pixelRatio;
      canvas.width = d.cw * dpr;
      canvas.height = d.ch * dpr;
      ctx.scale(dpr, dpr);

      if (isToday) {
        this._touchIntraday(ctx, d, e.touches[0].x);
      } else {
        this._touchHistory(ctx, d, e.touches[0].x);
      }
    });
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
    this._pollTimer = setInterval(() => this._pollFundRate(), 15000);
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
      const changed = this.data.todayProfitRate !== rate || this.data.todayProfit !== tp;
      if (changed) {
        this.setData({ todayProfitRate: rate, todayProfit: tp });
        // 仅当日视图需要重绘走势（周/月/年视图不包含当天数据）
        if (this.data.activeTab === 'today') this._draw();
      }
      const snaps = res.result.data.intradaySnapshots;
      if (snaps && snaps.length > (this._profitSnapshots || []).length) {
        this._profitSnapshots = snaps.slice().sort((a, b) => a.time.localeCompare(b.time));
        this._todayCaches = {};
        try { wx.removeStorageSync(INTRADAY_CACHE_PREFIX + (this.data.compareIndex || '000001')); } catch (e) {}
      }
      if (this.data.activeTab === 'today') {
        this.fetchIntraday();
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
