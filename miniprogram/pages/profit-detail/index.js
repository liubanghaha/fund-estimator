const api = require("../../utils/api");

Page({
  data: {
    activeTab: "day",
    dayData: [],
    monthData: [],
    yearData: [],
    totalCost: 0,
    todayProfit: "0.00",
    monthProfit: "0.00",
    yearProfit: "0.00",
    loading: true,
  },

  onLoad() {
    this.loadData();
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

      const [dayHistory, yearHistory] = await Promise.all([
        Promise.all(holdings.map((h) => api.fetchFundNAVHistory(h.fundCode, 90).catch(() => null))),
        Promise.all(holdings.map((h) => api.fetchFundNAVHistory(h.fundCode, 250).catch(() => null))),
      ]);

      const buildDailyData = (histories, holdings) => {
        const dateMap = {};
        histories.forEach((res, i) => {
          if (!res || !res.result || res.result.code !== 0) return;
          const list = res.result.data;
          if (!list || list.length === 0) return;
          const shares = holdings[i].shares;
          list.forEach((item) => {
            const date = item.date;
            if (!dateMap[date]) dateMap[date] = 0;
            dateMap[date] += item.nav * shares;
          });
        });
        return Object.entries(dateMap)
          .map(([date, value]) => ({ date, value: +value.toFixed(2), profit: +(value - totalCost).toFixed(2) }))
          .sort((a, b) => a.date.localeCompare(b.date));
      };

      const allDaily = buildDailyData(dayHistory, holdings);
      const allYearDaily = buildDailyData(yearHistory, holdings);

      const dayData = allDaily.slice(-7);
      const today = new Date();
      const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const monthData = allDaily.filter((d) => d.date.startsWith(thisMonth));

      const monthAgg = {};
      allYearDaily.forEach((d) => {
        const m = d.date.slice(0, 7);
        if (!monthAgg[m]) monthAgg[m] = d;
        monthAgg[m] = { ...monthAgg[m], date: m, value: d.value, profit: d.profit };
      });
      const yearData = Object.values(monthAgg).sort((a, b) => a.date.localeCompare(b.date));

      const todayProfit = dayData.length > 0 ? dayData[dayData.length - 1].profit : 0;
      const monthProfit = monthData.length > 0 ? monthData[monthData.length - 1].profit : 0;
      const yearProfit = yearData.length > 0 ? yearData[yearData.length - 1].profit : 0;

      this.setData({
        dayData, monthData, yearData, totalCost,
        todayProfit: todayProfit.toFixed(2),
        monthProfit: monthProfit.toFixed(2),
        yearProfit: yearProfit.toFixed(2),
        loading: false,
      });
      setTimeout(() => this.drawChart(), 500);
    } catch (e) {
      console.error("加载收益数据失败:", e);
      this.setData({ loading: false });
    }
  },

  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
    setTimeout(() => this.drawChart(), 300);
  },

  drawChart() {
    const { activeTab, dayData, monthData, yearData } = this.data;
    let data = activeTab === "day" ? dayData : activeTab === "month" ? monthData : yearData;
    if (data.length < 2) return;

    const canvasId = "profitCanvas";
    const ctx = wx.createCanvasContext(canvasId, this);
    const w = 340, h = 180;
    const profits = data.map((d) => d.profit);
    const minP = Math.min(...profits), maxP = Math.max(...profits);
    const range = Math.max(maxP - minP, 0.01);
    const pad = range * 0.15;
    const yMin = minP - pad, yMax = maxP + pad;
    const m = { top: 16, right: 8, bottom: 22, left: 8 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (data.length - 1)) * i;
    const yp = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle("#FFFFFF");
    ctx.fillRect(0, 0, w, h);

    const isUp = profits[profits.length - 1] >= profits[0];
    const color = isUp ? "228,57,60" : "46,139,87";
    const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
    gradient.addColorStop(0, `rgba(${color},0.12)`);
    gradient.addColorStop(1, `rgba(${color},0.01)`);
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = xp(i), y = yp(d.profit);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xp(data.length - 1), h - m.bottom);
    ctx.lineTo(xp(0), h - m.bottom);
    ctx.closePath();
    ctx.setFillStyle(gradient);
    ctx.fill();

    ctx.beginPath();
    data.forEach((d, i) => {
      const x = xp(i), y = yp(d.profit);
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
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(0), m.left + 52, yp(val));
    }
    ctx.setTextAlign("center");
    ctx.setTextBaseline("top");
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      const label = activeTab === "year" ? data[idx].date : data[idx].date.slice(5);
      ctx.fillText(label, xp(idx), h - m.bottom + 4);
    }
    ctx.draw();
  },
});
