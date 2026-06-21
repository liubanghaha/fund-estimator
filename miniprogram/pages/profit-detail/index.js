
const _getChartColors = () => {
  const t = (typeof wx !== 'undefined') ? (wx.getStorageSync('theme') || 'blue') : 'blue';
  return t === 'red' ? { primary: '#E4393C', secondary: '#1976D2', red: '#E4393C', green: '#2E8B57', up: '#E4393C', down: '#2E8B57' }
    : { primary: '#1976D2', secondary: '#E4393C', red: '#E4393C', green: '#2E8B57', up: '#E4393C', down: '#2E8B57' };
};
const api = require("../../utils/api");
const calc = require("../../utils/calculator");

const CACHE = "profit_detail_cache_v2";

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
        // 缓存的当日条目可能是非交易日残留，先移除；_fetch() 验证后加回
        const cachedToday = calc.formatDate(new Date());
        if (this._dailyChange[cachedToday]) delete this._dailyChange[cachedToday];
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
        this.setData({ loading: false, loadError: true });
        return;
      }
      const d = pfRes.result.data;

      // 当天收益分时：优先用服务端 snapshotProfit 定时写入的快照（每分钟一个点，覆盖全天）
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
      if (this.data.activeTab === 'today') this.fetchIntraday();

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
      this.setData({ loading: false, loadError: true });
      if (!this._fromCache) wx.showToast({ title: '数据加载失败', icon: 'none' });
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

    const hasIdx = ib !== null;
    const validProfit = data.filter(d => d.baseRate !== null);
    const validIdx = data.filter(d => d.indexRate !== null);
    if (validProfit.length === 0 && validIdx.length === 0) return null;

    return { data, hasP: validProfit.length > 0, noIdx: !hasIdx };
  },

  _draw() {
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const isToday = this.data.activeTab === 'today';

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

      if (!isToday && !r) {
        ctx.fillStyle = '#FFF'; ctx.fillRect(0, 0, cw, ch);
        return;
      }

      if (isToday) {
        this._drawIntraday(ctx, cw, ch);
      } else {
        this._drawHistory(ctx, cw, ch, r);
      }
    });
  },

  // ============ 当天走势图（新引擎） ============
  // 收益线数据源：服务端 snapshotProfit 定时写入的 _profitSnapshots（每分钟一点，覆盖全天）
  // 指数线数据源：fetchIndexIntraday 的 _intradayRaw（09:30-15:00 分时）
  // 两条线都基于 timeToX 时间映射，等时间距，对比才有意义

  _drawIntraday(ctx, cw, ch) {
    const idxRaw = this._intradayRaw || [];
    const profitSnaps = this._profitSnapshots || [];
    const fundRate = parseFloat(this.data.todayProfitRate || 0);
    const hasIndex = idxRaw.length >= 2;
    const hasProfit = profitSnaps.length >= 1;
    const p = { t: 36, r: 20, b: 32, l: 48 };
    const pw = cw - p.l - p.r, ph = ch - p.t - p.b;

    // 时间→X：09:30-11:30(0-120分) + 13:00-15:00(120-240分)，午休段折叠
    const timeToX = (t) => {
      const [hh, mm] = (t || '09:30').split(':').map(Number);
      const total = hh * 60 + mm;
      let eff;
      if (total <= 690) eff = Math.max(0, total - 570);          // 09:30-11:30
      else if (total >= 780) eff = 120 + Math.min(120, total - 780); // 13:00-15:00
      else eff = 120;                                              // 11:30-13:00 映射到午休末端
      return p.l + (pw * eff / 240);
    };
    const xToTime = (x) => {
      const eff = (x - p.l) / pw * 240;
      let total;
      if (eff <= 120) total = 570 + eff;
      else total = 660 + eff; // 跨过午休
      const hh = Math.floor(total / 60), mm = Math.round(total % 60);
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };

    // 指数分时点（changeRate%）
    const idxData = hasIndex ? idxRaw.map(d => ({ time: d.time, value: d.changeRate })) : [];
    // 收益分时点（rate%）
    const profitData = profitSnaps.map(d => ({ time: d.time, value: d.rate }));
    // 收益线末端补当前实时值（仅交易时段）
    if (this._isTradingNow()) {
      if (hasProfit) {
        const last = profitData[profitData.length - 1];
        const now = this._nowTimeStr();
        if (now && (!last || last.time < now)) profitData.push({ time: now, value: fundRate });
      } else if (profitSnaps.length === 0) {
        profitData.push({ time: this._nowTimeStr(), value: fundRate });
      }
    }

    // Y 轴范围：两条线取并集，对称包含 0
    const allVals = [];
    idxData.forEach(d => allVals.push(d.value));
    profitData.forEach(d => allVals.push(d.value));
    if (!allVals.length) allVals.push(0, 0);
    let mn = Math.min(...allVals), mx = Math.max(...allVals);
    const absMax = Math.max(Math.abs(mn), Math.abs(mx), 0.2);
    const y0 = -absMax * 1.15, y1 = absMax * 1.15;
    const yi = v => p.t + ph - ((v - y0) / (y1 - y0)) * ph;

    this._intradayDraw = { idxData, profitData, p, cw, ch, pw, ph, y0, y1, yi, fundRate, hasIndex, hasProfit, timeToX, xToTime };

    // 1. 白底
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cw, ch);
    if (!hasIndex && !hasProfit) {
      ctx.fillStyle = '#BBB'; ctx.font = '12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('今日暂无分时数据', cw / 2, ch / 2);
      return;
    }

    // 2. 午休段浅灰背景
    const lunchStart = timeToX('11:30'), lunchEnd = timeToX('13:00');
    ctx.fillStyle = 'rgba(0,0,0,0.025)';
    ctx.fillRect(lunchStart, p.t, lunchEnd - lunchStart, ph);

    // 3. 网格 + 0% 基准虚线
    this._drawGrid(ctx, p, cw, ch, y0, y1, yi);

    // 4. 指数线（蓝虚线）
    if (hasIndex) this._drawIdxLine(ctx, idxData, timeToX, yi, true);

    // 5. 收益线（涨跌填充 + 实线）
    if (profitData.length >= 1) this._drawProfitLine(ctx, profitData, timeToX, yi);

    // 6. 图例
    this._drawIntradayLegend(ctx, p, cw, idxData, profitData, hasIndex, fundRate);

    // 7. 坐标轴
    this._drawIntradayAxis(ctx, p, cw, ch, y0, y1, yi, timeToX);
  },

  _drawIdxLine(ctx, data, timeToX, yi, dashed) {
    if (data.length < 2) return;
    ctx.beginPath();
    data.forEach((d, i) => { const x = timeToX(d.time); i === 0 ? ctx.moveTo(x, yi(d.value)) : ctx.lineTo(x, yi(d.value)); });
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#1976D2'; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]);
  },

  _drawProfitLine(ctx, data, timeToX, yi) {
    const color = (data[data.length - 1].value || 0) >= 0 ? '#E4393C' : '#2E8B57';
    const fillColor = color === '#E4393C' ? 'rgba(228,57,60,0.10)' : 'rgba(46,139,87,0.10)';
    // 涨跌区域填充（以 0% 即 yi(0) 为基准）
    if (data.length >= 2) {
      ctx.beginPath();
      data.forEach((d, i) => { const x = timeToX(d.time); i === 0 ? ctx.moveTo(x, yi(d.value)) : ctx.lineTo(x, yi(d.value)); });
      const lastX = timeToX(data[data.length - 1].time);
      const firstX = timeToX(data[0].time);
      ctx.lineTo(lastX, yi(0));
      ctx.lineTo(firstX, yi(0));
      ctx.closePath();
      ctx.fillStyle = fillColor; ctx.fill();
    }
    // 实线
    ctx.beginPath();
    data.forEach((d, i) => { const x = timeToX(d.time); i === 0 ? ctx.moveTo(x, yi(d.value)) : ctx.lineTo(x, yi(d.value)); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
    // 末端点
    const last = data[data.length - 1];
    const lx = timeToX(last.time), ly = yi(last.value);
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, 2 * Math.PI);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#FFF'; ctx.lineWidth = 1; ctx.stroke();
  },

  _drawIntradayLegend(ctx, p, cw, idxData, profitData, hasIndex, fundRate) {
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    const fmt = v => (v > 0 ? '+' : '') + (v != null ? v.toFixed(2) : '0.00') + '%';
    let yOff = 14;
    // 收益
    const pColor = fundRate >= 0 ? '#E4393C' : '#2E8B57';
    ctx.fillStyle = pColor; ctx.fillRect(p.l, yOff - 4, 14, 3);
    ctx.fillStyle = '#333'; ctx.textAlign = 'left';
    const pVal = profitData.length ? profitData[profitData.length - 1].value : fundRate;
    ctx.fillText('我的收益 ' + fmt(pVal), p.l + 18, yOff);
    // 指数
    if (hasIndex) {
      yOff = 28;
      ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l, yOff - 4, 14, 3);
      ctx.fillStyle = '#333';
      const iVal = idxData[idxData.length - 1].value;
      ctx.fillText(this.data.compareLabel + ' ' + fmt(iVal), p.l + 18, yOff);
    }
  },

  _drawIntradayAxis(ctx, p, cw, ch, y0, y1, yi, timeToX) {
    // Y 轴刻度（% ）
    ctx.fillStyle = '#999'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) { const v = y1 - (y1 - y0) / 4 * i; ctx.fillText(v.toFixed(1), p.l - 5, yi(v)); }
    // X 轴时间刻度
    ctx.fillStyle = '#999'; ctx.font = '9px sans-serif'; ctx.textBaseline = 'top';
    const labels = [{ t: '09:30', a: 'left' }, { t: '11:30/13:00', a: 'center' }, { t: '15:00', a: 'right' }];
    labels.forEach(l => {
      ctx.textAlign = l.a;
      const x = l.t.includes('/') ? timeToX('11:30') + (timeToX('13:00') - timeToX('11:30')) / 2 : timeToX(l.t);
      ctx.fillText(l.t, x, ch - p.b + 6);
    });
  },

  _nowTimeStr() {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
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
        ctx.fillStyle = '#666'; ctx.textAlign = 'left'; ctx.fillText('我的收益', p.l + 20, 12);
        ctx.fillStyle = '#1976D2'; ctx.fillRect(p.l + 4, 22, 12, 4);
        ctx.fillStyle = '#666'; ctx.fillText(this.data.compareLabel, p.l + 20, 24);
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

  async fetchIntraday() {
    if (this._fetchingToday) return;
    this._fetchingToday = true;
    try {
      const res = await api.fetchIndexIntraday(this.data.compareIndex);
      if (res.code === 0 && res.data && res.data.length > 0) {
        this._intradayRaw = res.data;
        this.setData({ _t: Date.now() }, () => this._draw());
      }
    } catch (e) { /* 静默降级，Canvas 已有空状态提示 */ }
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

  onSummaryTap(e) { const tab = e.currentTarget.dataset.tab; this.setData({ activeTab: tab }, () => { if (tab === 'today') this.fetchIntraday(); else this._draw(); }); },
  onCalendarTab(e) { this._cal(); this.setData({ calendarView: e.currentTarget.dataset.tab }); },
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },
  onMonthChange(e) { const m = this.data.availableMonths[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedMonth: m, dayCalendar: this._days(this._dailyChange, m, dm) }); },
  onYearChange(e) { const y = this.data.availableYears[e.detail.value]; const dm = {}; (this._allDaily || []).forEach(d => { dm[d.date] = d.value; }); this.setData({ selectedYear: y, monthCalendar: this._mons(this._dailyChange, y, dm) }); },
  onToggleMode() { this._cal(); this.setData({ profitMode: this.data.profitMode === 'amount' ? 'rate' : 'amount' }); },
  onSelectIndex(e) { const { code, name } = e.currentTarget.dataset; if (code === this.data.compareIndex) return; this.setData({ compareIndex: code, compareLabel: name }); if (this.data.activeTab === 'today') { delete this._intradayRaw; this._fetchingToday = false; this.fetchIntraday(); return; } const data = this._idxMap ? this._idxMap[code] : null; if (!data || !data.length) { this._fetch(); return; } this._indexDaily = data; this._draw(); },

  onCanvasTouch(e) {
    const isToday = this.data.activeTab === 'today';
    const d = isToday ? this._intradayDraw : this._chartDraw;
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

  _touchIntraday(ctx, d, px) {
    const { idxData, profitData, p, cw, ch, y0, y1, yi, fundRate, hasIndex, hasProfit, timeToX, xToTime } = d;
    if (!hasIndex && !hasProfit) return;
    // 重绘底图（不含图例，腾出顶部空间给气泡）
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cw, ch);
    const lunchStart = timeToX('11:30'), lunchEnd = timeToX('13:00');
    ctx.fillStyle = 'rgba(0,0,0,0.025)';
    ctx.fillRect(lunchStart, p.t, lunchEnd - lunchStart, ch - p.t - p.b);
    this._drawGrid(ctx, p, cw, ch, y0, y1, yi);
    if (hasIndex) this._drawIdxLine(ctx, idxData, timeToX, yi, true);
    if (hasProfit && profitData.length >= 1) this._drawProfitLine(ctx, profitData, timeToX, yi, y0);
    this._drawIntradayAxis(ctx, p, cw, ch, y0, y1, yi, timeToX);

    // 限制在绘图区内
    const clampedX = Math.max(p.l, Math.min(cw - p.r, px));
    const tt = xToTime(clampedX);

    // 找该时间点上两条线的值（按时间最近邻）
    const nearest = (arr) => {
      if (!arr || !arr.length) return null;
      let ni = 0, nd = Infinity;
      arr.forEach((pt, i) => { const dist = Math.abs(timeToX(pt.time) - clampedX); if (dist < nd) { nd = dist; ni = i; } });
      return arr[ni];
    };
    const idxPt = hasIndex ? nearest(idxData) : null;
    const pfPt = hasProfit ? nearest(profitData) : null;
    const idxV = idxPt ? idxPt.value : null;
    const pfV = pfPt ? pfPt.value : (hasProfit ? fundRate : null);

    // 十字线
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(clampedX, p.t); ctx.lineTo(clampedX, ch - p.b); ctx.stroke();
    ctx.setLineDash([]);

    // 双圆点
    const pColor = (pfV != null ? pfV : 0) >= 0 ? '#E4393C' : '#2E8B57';
    if (pfV != null) {
      ctx.beginPath(); ctx.arc(clampedX, yi(pfV), 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#FFF'; ctx.fill(); ctx.strokeStyle = pColor; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (idxV != null) {
      ctx.beginPath(); ctx.arc(clampedX, yi(idxV), 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#FFF'; ctx.fill(); ctx.strokeStyle = '#1976D2'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // 顶部气泡：时间 + 双数值
    const fmt = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    const parts = [{ t: tt, c: '#999' }];
    if (pfV != null) parts.push({ t: '收益 ' + fmt(pfV), c: pColor });
    if (idxV != null) parts.push({ t: this.data.compareLabel + ' ' + fmt(idxV), c: '#1976D2' });
    let tx = p.l;
    parts.forEach(part => {
      const w = ctx.measureText(part.t).width;
      ctx.fillStyle = part.c; ctx.textAlign = 'left';
      ctx.fillText(part.t, tx, p.t / 2);
      tx += w + 12;
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
      this.setData({ todayProfitRate: rate, todayProfit: tp });
      // 同步刷新服务端快照（增量追加）
      const snaps = res.result.data.intradaySnapshots;
      if (snaps && snaps.length > (this._profitSnapshots || []).length) {
        this._profitSnapshots = snaps.slice().sort((a, b) => a.time.localeCompare(b.time));
      }
      // today 模式下同步刷新指数分时线
      if (this.data.activeTab === 'today') {
        api.fetchIndexIntraday(this.data.compareIndex).then(ires => {
          if (ires.code === 0 && ires.data) this._intradayRaw = ires.data;
          this._draw();
        });
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
