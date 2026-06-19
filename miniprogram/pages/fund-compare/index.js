const api = require("../../utils/api");
const calc = require("../../utils/calculator");
const chartUtil = require("../../utils/chart");

Page({
  data: {
    fundA: { code: "", name: "", nav: null, changeRate: null },
    fundB: { code: "", name: "", nav: null, changeRate: null },
    searchKeyword: "",
    searchResults: [],
    searching: false,
    hasSearched: false,
    loading: true,
    loadError: false,
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
    const { windowWidth } = wx.getSystemInfoSync();
    const canvasW = windowWidth - 24;
    const canvasH = Math.round(canvasW * 0.62);
    this._canvasW = canvasW;
    this._canvasH = canvasH;
    this.setData({ "fundA.code": code, "fundA.name": name, canvasW, canvasH });
    if (code) {
      this.fetchFundAData();
      this.fetchWatchlist();
    } else {
      this.setData({ loading: false });
    }
  },

  async fetchFundAData() {
    try {
      const res = await api.fetchFundOverview(this.data.fundA.code);
      const d = (res.result && res.result.code === 0) ? res.result.data : {};

      this.setData({
        "fundA.nav": d.actualNav || d.nav || null,
        "fundA.changeRate": d.estimatedChangeRate != null ? d.estimatedChangeRate : d.actualChangeRate,
        "fundA.history": d.history || [],
        "fundA.profile": d.profile || {},
        "fundA.manager": d.manager || {},
      loading: false,
      loadError: false,
    });
    } catch (e) {
      this.setData({ loading: false, loadError: true });
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
      const res = await api.fetchFundOverview(code);
      const d = (res.result && res.result.code === 0) ? res.result.data : {};

      this.setData({
        "fundB.nav": d.actualNav || d.nav || null,
        "fundB.changeRate": d.estimatedChangeRate != null ? d.estimatedChangeRate : d.actualChangeRate,
        "fundB.history": d.history || [],
        "fundB.profile": d.profile || {},
        "fundB.manager": d.manager || {},
      }, () => {
        this.buildComparison();
        this.drawChart();
      });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
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
    return calc.calcPeriodReturns(history);
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

  _getCompareOpts() {
    return {
      w: this._canvasW || 340,
      h: this._canvasH || 212,
      padding: { top: 36, right: 12, bottom: 36, left: 52 },
      fieldA: 'rateA', fieldB: 'rateB',
      colorA: '#E4393C', colorB: '#1976D2',
      labelA: (this.data.fundA.name || '').slice(0, 10),
      labelB: (this.data.fundB.name || '').slice(0, 10),
    };
  },

  drawChart() {
    const chartData = this.data.chartData;
    if (!chartData || chartData.length < 2) return;
    const query = wx.createSelectorQuery();
    query.select('#compareCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const opts = { ...this._getCompareOpts(), data: chartData };
      chartUtil.drawDualLineChart(canvas, opts);
      this._compareCanvas = canvas;
      this._compareOpts = opts;
    });
  },

  onCompareTouch(e) {
    const chartData = this.data.chartData;
    if (!chartData || chartData.length < 2) return;
    const canvas = this._compareCanvas;
    if (!canvas) return;

    if (e.type === 'touchstart') {
      this._ctSY = e.touches[0].y;
      this._ctSX = e.touches[0].x;
      this._ctActive = false;
      this._ctTopCheck = e.touches[0].y < 100;
      return;
    }
    if (e.type === 'touchend') { this._ctActive = false; this.drawChart(); return; }
    if (!this._ctActive) {
      const dy = Math.abs(e.touches[0].y - this._ctSY);
      const dx = Math.abs(e.touches[0].x - this._ctSX);
      if (this._ctTopCheck && e.touches[0].y > this._ctSY && dy > dx) return;
      if (dy > dx && dy > 8) return;
      if (dx > dy && dx > 8) this._ctActive = true;
    }
    if (!this._ctActive) return;

    const now = Date.now();
    if (this._ctT && now - this._ctT < 60) return;
    this._ctT = now;

    const opts = { ...this._compareOpts || this._getCompareOpts(), data: chartData };
    const dpr = wx.getSystemInfoSync().pixelRatio;
    const { canvasW: w, canvasH: h } = this.data;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    chartUtil.drawDualLineChart(canvas, opts);
    chartUtil.handleDualTouch(ctx, e, opts);
  },

  onRetry() {
    this.setData({ loading: true, loadError: false });
    this.fetchFundAData();
  },
});
