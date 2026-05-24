const api = require("../../utils/api");

Page({
  data: {
    fundA: { code: "", name: "", nav: null, changeRate: null },
    fundB: { code: "", name: "", nav: null, changeRate: null },
    searchKeyword: "",
    searchResults: [],
    searching: false,
    hasSearched: false,
    loading: true,
    comparison: null,
    watchlist: [],
    watchlistLoaded: false,
    searchHighlight: false,
    searchFocus: false,
  },

  onLoad(options) {
    const rawCode = options.fundCode || "";
    const rawName = options.fundName ? decodeURIComponent(options.fundName) : "";
    const code = (rawCode && rawCode !== "undefined") ? rawCode : "";
    const name = (rawName && rawName !== "undefined") ? rawName : "";
    this.setData({ "fundA.code": code, "fundA.name": name });
    if (code) {
      this.fetchFundAData();
      this.fetchWatchlist();
    } else {
      this.setData({ loading: false });
    }
  },

  async fetchFundAData() {
    try {
      const [estRes, histRes, profRes] = await Promise.all([
        api.fetchFundEstimate(this.data.fundA.code),
        api.fetchFundNAVHistory(this.data.fundA.code, 260),
        api.fetchFundProfile(this.data.fundA.code),
      ]);

      const est = (estRes.result && estRes.result.code === 0) ? estRes.result.data : {};
      const history = (histRes.result && histRes.result.code === 0) ? histRes.result.data : [];
      const profile = (profRes.result && profRes.result.code === 0) ? profRes.result.data : {};

      this.setData({
        "fundA.nav": est.actualNav || est.nav || null,
        "fundA.changeRate": est.estimatedChangeRate != null ? est.estimatedChangeRate : est.actualChangeRate,
        "fundA.history": history,
        "fundA.profile": profile.profile || {},
        "fundA.manager": profile.manager || {},
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onSearchInput(e) {
    const keyword = (e.detail.value || "").trim();
    if (keyword.length < 2) {
      this.setData({ searchResults: [], hasSearched: false });
      return;
    }
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this.setData({ searching: true });
    this._searchTimer = setTimeout(() => {
      this._doSearch(keyword);
    }, 400);
  },

  async _doSearch(keyword) {
    try {
      const res = await api.searchFund(keyword);
      if (res && res.result && res.result.code === 0) {
        const data = res.result.data || [];
        const list = data.filter(
          (f) => f && f.fundCode && f.fundCode !== this.data.fundA.code
        );
        this.setData({ searchResults: list, hasSearched: true, searching: false });
      } else {
        this.setData({ searchResults: [], hasSearched: true, searching: false });
      }
    } catch (e) {
      console.error("搜索异常:", e);
      wx.showToast({ title: "搜索失败，请重试", icon: "none" });
      this.setData({ searchResults: [], hasSearched: true, searching: false });
    }
  },

  async onSelectFundB(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.showLoading({ title: "加载中..." });
    this.setData({
      "fundB.code": code, "fundB.name": name,
      searchKeyword: "", searchResults: [], hasSearched: false,
      searchFocus: false,
    });

    try {
      const [estRes, histRes, profRes] = await Promise.all([
        api.fetchFundEstimate(code),
        api.fetchFundNAVHistory(code, 260),
        api.fetchFundProfile(code),
      ]);

      const est = (estRes.result && estRes.result.code === 0) ? estRes.result.data : {};
      const history = (histRes.result && histRes.result.code === 0) ? histRes.result.data : [];
      const profile = (profRes.result && profRes.result.code === 0) ? profRes.result.data : {};

      this.setData({
        "fundB.nav": est.actualNav || est.nav || null,
        "fundB.changeRate": est.estimatedChangeRate != null ? est.estimatedChangeRate : est.actualChangeRate,
        "fundB.history": history,
        "fundB.profile": profile.profile || {},
        "fundB.manager": profile.manager || {},
      }, () => {
        this.buildComparison();
        setTimeout(() => this.drawChart(), 500);
      });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
    }
    wx.hideLoading();
  },

  onTapPlaceholder() {
    this.setData({ searchHighlight: true, searchFocus: true });
    setTimeout(() => this.setData({ searchHighlight: false }), 800);
    wx.createSelectorQuery()
      .select('.search-box')
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec((res) => {
        if (res[0] && res[1] != null) {
          wx.pageScrollTo({ scrollTop: res[1].scrollTop + res[0].top - 40, duration: 300 });
        }
      });
  },

  async fetchWatchlist() {
    try {
      const res = await api.watchlistList();
      if (res.result && res.result.code === 0) {
        const items = (res.result.data || []).filter(w => w.fundCode !== this.data.fundA.code);
        this.setData({ watchlist: items, watchlistLoaded: true });
      } else {
        this.setData({ watchlist: [], watchlistLoaded: true });
      }
    } catch (e) {
      this.setData({ watchlist: [], watchlistLoaded: true });
    }
  },

  onRemoveFundB() {
    this.setData({
      "fundB.code": "", "fundB.name": "", "fundB.nav": null, "fundB.changeRate": null,
      "fundB.history": null, "fundB.profile": null, "fundB.manager": null,
      comparison: null, searchFocus: false,
    });
  },

  buildComparison() {
    const { fundA, fundB } = this.data;
    const histA = fundA.history || [];
    const histB = fundB.history || [];

    const retA = this.calcReturns(histA);
    const retB = this.calcReturns(histB);

    // Normalize histories for chart
    const chartData = this.buildChartData(histA, histB);

    const profileA = fundA.profile || {};
    const profileB = fundB.profile || {};
    const mgrA = fundA.manager || {};
    const mgrB = fundB.manager || {};

    const riskMap = { "1": "低风险", "2": "中低风险", "3": "中风险", "4": "中高风险", "5": "高风险" };

    this.setData({
      comparison: {
        returns: [
          { label: "日涨幅", a: retA.day, b: retB.day },
          { label: "近1周", a: retA.week, b: retB.week },
          { label: "近1月", a: retA.month, b: retB.month },
          { label: "近3月", a: retA.threeMonth, b: retB.threeMonth },
          { label: "近6月", a: retA.sixMonth, b: retB.sixMonth },
          { label: "近1年", a: retA.year, b: retB.year },
        ],
        infos: [
          { label: "基金类型", a: profileA.fundType || "--", b: profileB.fundType || "--" },
          { label: "基金规模", a: this.fmtSize(profileA.fundSize), b: this.fmtSize(profileB.fundSize) },
          { label: "风险等级", a: riskMap[profileA.riskLevel] || "--", b: riskMap[profileB.riskLevel] || "--" },
          { label: "成立日期", a: profileA.establishDate || "--", b: profileB.establishDate || "--" },
          { label: "基金经理", a: mgrA.name || "--", b: mgrB.name || "--" },
        ],
      },
      chartData,
    });
  },

  fmtSize(size) {
    if (!size) return "--";
    return (size / 100000000).toFixed(2) + "亿";
  },

  calcReturns(history) {
    if (!history || history.length === 0) return { day: null, week: null, month: null, threeMonth: null, sixMonth: null, year: null };
    const latest = history[0].nav;
    const g = (days) => {
      if (history.length <= days) return null;
      const nav = history[days] && history[days].nav;
      if (!nav) return null;
      return parseFloat(((latest - nav) / nav * 100).toFixed(2));
    };
    return {
      day: history[0].changeRate || 0,
      week: g(4), month: g(19), threeMonth: g(64), sixMonth: g(129), year: g(249),
    };
  },

  buildChartData(histA, histB) {
    if (!histA.length || !histB.length) return [];

    // Build date maps for both histories
    const mapA = {}, mapB = {};
    [...histA].reverse().forEach((d) => { mapA[d.date] = d.nav; });
    [...histB].reverse().forEach((d) => { mapB[d.date] = d.nav; });

    // Find common date range
    const allDates = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)])].sort();
    if (allDates.length < 2) return [];

    let startIdx = 0;
    for (let i = 0; i < allDates.length; i++) {
      if (mapA[allDates[i]] && mapB[allDates[i]]) { startIdx = i; break; }
    }

    const baseA = mapA[allDates[startIdx]];
    const baseB = mapB[allDates[startIdx]];
    if (!baseA || !baseB) return [];

    const result = [];
    for (let i = startIdx; i < allDates.length; i++) {
      const d = allDates[i];
      result.push({
        date: d,
        rateA: mapA[d] ? +((mapA[d] / baseA - 1) * 100).toFixed(2) : null,
        rateB: mapB[d] ? +((mapB[d] / baseB - 1) * 100).toFixed(2) : null,
      });
    }
    return result;
  },

  drawChart() {
    const chartData = this.data.chartData;
    if (!chartData || chartData.length < 2) return;

    const ctx = wx.createCanvasContext('compareCanvas', this);
    const w = 340, h = 200;

    const ratesA = chartData.map(d => d.rateA).filter(v => v !== null);
    const ratesB = chartData.map(d => d.rateB).filter(v => v !== null);
    const allVals = [...ratesA, ...ratesB];
    if (allVals.length === 0) return;
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const range = max - min || 0.01;
    const pad = range * 0.15;
    const yMin = min - pad, yMax = max + pad;

    const m = { top: 24, right: 12, bottom: 36, left: 52 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (chartData.length - 1)) * i;
    const yp = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, w, h);

    // Draw fund A line (red)
    this.drawLine(ctx, chartData, 'rateA', xp, yp, '#E4393C', h, m);
    // Draw fund B line (blue)
    this.drawLine(ctx, chartData, 'rateB', xp, yp, '#1976D2', h, m);

    // Legend
    ctx.setFontSize(9);
    ctx.setTextBaseline('top');
    ctx.setFillStyle('#E4393C');
    ctx.fillRect(m.left + 4, 4, 14, 3);
    ctx.setFillStyle('#666');
    ctx.setTextAlign('left');
    ctx.fillText(this.data.fundA.name || '基金A', m.left + 22, 1);
    ctx.setFillStyle('#1976D2');
    ctx.fillRect(m.left + 80, 4, 14, 3);
    ctx.setFillStyle('#666');
    ctx.fillText(this.data.fundB.name || '基金B', m.left + 98, 1);

    // Y-axis
    ctx.setFillStyle('#999');
    ctx.setFontSize(10);
    ctx.setTextAlign('right');
    ctx.setTextBaseline('middle');
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(1) + '%', m.left - 6, yp(val));
    }

    // X-axis
    ctx.setTextAlign('center');
    ctx.setTextBaseline('top');
    ctx.setFillStyle('#999');
    const steps = Math.min(5, chartData.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (chartData.length - 1));
      ctx.fillText(chartData[idx].date.slice(5), xp(idx), h - m.bottom + 8);
    }

    ctx.draw();
  },

  drawLine(ctx, data, field, xp, yp, color, h, m) {
    let started = false;
    ctx.beginPath();
    data.forEach((d, i) => {
      if (d[field] === null) { started = false; return; }
      const x = xp(i), y = yp(d[field]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    });
    ctx.setStrokeStyle(color);
    ctx.setLineWidth(2);
    ctx.stroke();
  },
});
