const api = require("../../utils/api");

Page({
  data: {
    activeTab: "day",
    displayMode: "amount",
    loading: true,
    dayData: [],
    monthData: [],
    yearData: [],
    totalCost: 0,
    todayProfit: "0.00",
    monthProfit: "0.00",
    yearProfit: "0.00",
  },

  onShow() {
    if (!this._loaded) {
      this._loaded = true;
      this.loadData();
    }
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const res = await api.getPortfolio();
      if (!res.result || res.result.code !== 0) {
        this.setData({ loading: false });
        return;
      }
      const holdings = res.result.data.holdings || [];
      if (holdings.length === 0) {
        this.setData({ loading: false });
        return;
      }

      const totalCost = holdings.reduce((sum, h) => sum + h.buyPrice * h.shares, 0);
      const navResults = await Promise.all(
        holdings.map((h) => api.fetchFundNAVHistory(h.fundCode, 250).catch(() => null))
      );

      // 构建持仓每日市值
      const dateMap = {};
      navResults.forEach((r, i) => {
        if (!r || !r.result || r.result.code !== 0) return;
        (r.result.data || []).forEach((item) => {
          const d = item.date;
          if (!dateMap[d]) dateMap[d] = 0;
          dateMap[d] += item.nav * holdings[i].shares;
        });
      });

      const allDaily = Object.entries(dateMap)
        .map(([date, value]) => ({
          date,
          value: +value.toFixed(2),
          profit: +(value - totalCost).toFixed(2),
          profitRate: totalCost > 0 ? +(((value - totalCost) / totalCost) * 100).toFixed(2) : 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      if (allDaily.length === 0) {
        this.setData({ loading: false });
        return;
      }

      const today = new Date();
      const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      const dayData = allDaily.slice(-7);
      const monthData = allDaily.filter((d) => d.date.startsWith(thisMonth));

      // 按月末聚合
      const monthEndMap = {};
      allDaily.forEach((d) => {
        const m = d.date.slice(0, 7);
        monthEndMap[m] = d;
      });
      const yearData = Object.keys(monthEndMap).sort().map((m) => monthEndMap[m]);

      // 同时尝试获取指数数据做对比
      const [shRes, hsRes] = await Promise.all([
        api.fetchMarketIndex("000001", 250).catch(() => null),
        api.fetchMarketIndex("000300", 250).catch(() => null),
      ]);
      if (shRes && shRes.result && shRes.result.code === 0 && shRes.result.data) {
        const shMap = {};
        shRes.result.data.forEach((d) => { shMap[d.date] = d.close; });
        allDaily.forEach((d) => { if (shMap[d.date] != null) d.sh = shMap[d.date]; });
      }
      if (hsRes && hsRes.result && hsRes.result.code === 0 && hsRes.result.data) {
        const hsMap = {};
        hsRes.result.data.forEach((d) => { hsMap[d.date] = d.close; });
        allDaily.forEach((d) => { if (hsMap[d.date] != null) d.hs300 = hsMap[d.date]; });
      }

      const todayProfit = allDaily[allDaily.length - 1].profit;
      const monthProfit = monthData.length > 0 ? monthData[monthData.length - 1].profit : 0;
      const yearProfit = yearData.length > 0 ? yearData[yearData.length - 1].profit : 0;

      this.setData({
        dayData, monthData, yearData, totalCost,
        todayProfit: todayProfit.toFixed(2),
        monthProfit: monthProfit.toFixed(2),
        yearProfit: yearProfit.toFixed(2),
        loading: false,
      });
      setTimeout(() => this.drawChart(), 600);
    } catch (e) {
      console.error("加载收益数据失败:", e);
      this.setData({ loading: false });
    }
  },

  onTabTap(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
    setTimeout(() => this.drawChart(), 300);
  },

  onToggleMode() {
    this.setData({ displayMode: this.data.displayMode === "amount" ? "rate" : "amount" });
  },

  getChartData() {
    const { activeTab, dayData, monthData, yearData } = this.data;
    if (activeTab === "day") return dayData;
    if (activeTab === "month") return monthData;
    return yearData;
  },

  drawChart() {
    const data = this.getChartData();
    if (!data || data.length < 2) return;

    const ctx = wx.createCanvasContext("profitCanvas", this);
    const w = 350, h = 200;
    const profits = data.map((d) => d.profit);
    const minP = Math.min.apply(null, profits);
    const maxP = Math.max.apply(null, profits);
    const range = maxP - minP || 1;
    const pad = range * 0.15;
    const yMin = minP - pad;
    const yMax = maxP + pad;
    const m = { top: 20, right: 12, bottom: 26, left: 12 };
    const pw = w - m.left - m.right;
    const ph = h - m.top - m.bottom;
    const xp = function (i) { return m.left + (pw / (data.length - 1)) * i; };
    const yp = function (v) { return m.top + ph - ((v - yMin) / (yMax - yMin)) * ph; };

    ctx.setFillStyle("#FFFFFF");
    ctx.fillRect(0, 0, w, h);

    const isUp = profits[profits.length - 1] >= profits[0];
    const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
    gradient.addColorStop(0, isUp ? "rgba(228,57,60,0.12)" : "rgba(46,139,87,0.12)");
    gradient.addColorStop(1, isUp ? "rgba(228,57,60,0.01)" : "rgba(46,139,87,0.01)");
    ctx.beginPath();
    data.forEach(function (d, i) {
      var x = xp(i), y = yp(d.profit);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xp(data.length - 1), h - m.bottom);
    ctx.lineTo(xp(0), h - m.bottom);
    ctx.closePath();
    ctx.setFillStyle(gradient);
    ctx.fill();

    ctx.beginPath();
    data.forEach(function (d, i) {
      var x = xp(i), y = yp(d.profit);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.setStrokeStyle(isUp ? "#E4393C" : "#2E8B57");
    ctx.setLineWidth(1.5);
    ctx.stroke();

    ctx.setFillStyle("#999");
    ctx.setFontSize(9);
    ctx.setTextAlign("right");
    ctx.setTextBaseline("middle");
    for (var i = 0; i <= 4; i++) {
      var val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(0), m.left + 52, yp(val));
    }

    ctx.setTextAlign("center");
    ctx.setTextBaseline("top");
    var steps = Math.min(5, data.length);
    for (var i = 0; i < steps; i++) {
      var idx = Math.round((i / (steps - 1)) * (data.length - 1));
      var label = this.data.activeTab === "year" ? data[idx].date : data[idx].date.slice(5);
      ctx.fillText(label, xp(idx), h - m.bottom + 6);
    }

    ctx.draw();
  },
});
