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
    hasIndex: false,
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

      const [navResults, shResults, hs300Results] = await Promise.all([
        Promise.all(holdings.map((h) => api.fetchFundNAVHistory(h.fundCode, 250).catch(() => null))),
        api.fetchMarketIndex("000001", 250).catch(() => null),
        api.fetchMarketIndex("000300", 250).catch(() => null),
      ]);

      // 构建持仓每日数据
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
        .map(([date, value]) => ({ date, value: +value.toFixed(2), profit: +(value - totalCost).toFixed(2) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // 解析指数数据
      const parseIndex = (r) => {
        if (!r || !r.result || r.result.code !== 0) return [];
        return r.result.data || [];
      };
      const shData = parseIndex(shResults);
      const hs300Data = parseIndex(hs300Results);
      const hasIndex = shData.length > 0 || hs300Data.length > 0;

      // 合并指数数据到每日数据
      if (hasIndex) {
        const shMap = {};
        shData.forEach((d) => { shMap[d.date] = d; });
        const hsMap = {};
        hs300Data.forEach((d) => { hsMap[d.date] = d; });
        allDaily.forEach((d) => {
          if (shMap[d.date]) d.sh = shMap[d.date].close;
          if (hsMap[d.date]) d.hs300 = hsMap[d.date].close;
        });
      }

      const today = new Date();
      const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      // 丰富显示字段
      const enrich = (data) => {
        if (data.length === 0) return [];
        const first = data[0];
        return data.map((d) => {
          const shRate = first.sh != null && d.sh != null ? (((d.sh / first.sh) - 1) * 100) : null;
          const hsRate = first.hs300 != null && d.hs300 != null ? (((d.hs300 / first.hs300) - 1) * 100) : null;
          const profitRate = totalCost > 0 ? ((d.profit / totalCost) * 100) : 0;
          return {
            ...d,
            shRate: shRate != null ? shRate.toFixed(2) : null,
            hsRate: hsRate != null ? hsRate.toFixed(2) : null,
            shRateNum: shRate != null ? +shRate.toFixed(2) : null,
            hsRateNum: hsRate != null ? +hsRate.toFixed(2) : null,
            profitRate: profitRate.toFixed(2),
            profitRateNum: +profitRate.toFixed(2),
            profitStr: d.profit >= 0 ? '+' + d.profit : '' + d.profit,
            shRateStr: shRate != null ? (shRate >= 0 ? '+' : '') + shRate.toFixed(2) + '%' : '--',
            hsRateStr: hsRate != null ? (hsRate >= 0 ? '+' : '') + hsRate.toFixed(2) + '%' : '--',
            profitRateStr: profitRate >= 0 ? '+' + profitRate.toFixed(2) + '%' : profitRate.toFixed(2) + '%',
          };
        });
      };

      const dayData = enrich(allDaily.slice(-7));
      const monthData = enrich(allDaily.filter((d) => d.date.startsWith(thisMonth)));

      const monthAgg = {};
      allDaily.forEach((d) => {
        const m = d.date.slice(0, 7);
        if (!monthAgg[m]) monthAgg[m] = d;
      });
      const yearData = enrich(
        Object.values(monthAgg).sort((a, b) => a.date.localeCompare(b.date))
      );

      const todayProfit = allDaily.length > 0 ? allDaily[allDaily.length - 1].profit : 0;
      const monthProfit = monthData.length > 0 ? monthData[monthData.length - 1].profit : 0;
      const yearProfit = yearData.length > 0 ? yearData[yearData.length - 1].profit : 0;

      this.setData({
        dayData, monthData, yearData, totalCost, hasIndex,
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
    this.setData({ activeTab: e.currentTarget.dataset.tab });
    setTimeout(() => this.drawChart(), 300);
  },

  onToggleMode() {
    this.setData({ displayMode: this.data.displayMode === "amount" ? "rate" : "amount" });
  },

  getCurrentData() {
    const { activeTab, dayData, monthData, yearData } = this.data;
    if (activeTab === "day") return dayData;
    if (activeTab === "month") return monthData;
    return yearData;
  },

  drawChart() {
    const data = this.getCurrentData();
    if (data.length < 2) return;

    const ctx = wx.createCanvasContext("profitCanvas", this);
    const w = 340, h = 190;
    const m = { top: 20, right: 44, bottom: 24, left: 44 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;

    const norm = (series, key) => {
      const first = data.find((d) => d[key] != null);
      if (!first) return null;
      const baseVal = first[key];
      if (baseVal == null || baseVal === 0) return null;
      return data.map((d) => d[key] != null ? (d[key] / baseVal) * 100 : null);
    };

    const pSeries = norm(data, "value");
    const shNorm = norm(data, "sh");
    const hsNorm = norm(data, "hs300");

    const allSeries = [pSeries, shNorm, hsNorm].filter((s) => s != null);
    if (allSeries.length === 0) return;

    const allVals = allSeries.flat().filter((v) => v != null);
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    const range = Math.max(maxV - minV, 0.5);
    const pad = range * 0.1;
    const yMin = minV - pad, yMax = maxV + pad;

    const xp = (i) => m.left + (pw / (data.length - 1)) * i;
    const yp = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle("#FFFFFF");
    ctx.fillRect(0, 0, w, h);

    const drawLine = (series, color, dash) => {
      if (!series) return;
      ctx.beginPath();
      let started = false;
      let prevX, prevY;
      data.forEach((_, i) => {
        if (series[i] == null) return;
        const x = xp(i), y = yp(series[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else { ctx.lineTo(x, y); }
      });
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(1.5);
      if (dash) ctx.setLineDash([4, 3], 0);
      ctx.stroke();
      ctx.setLineDash([], 0);
    };

    ctx.setStrokeStyle("#F0F0F0");
    ctx.setLineWidth(0.5);
    for (let i = 0; i <= 4; i++) {
      const y = m.top + (ph / 4) * i;
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(w - m.right, y);
      ctx.stroke();
    }

    drawLine(pSeries, "#E4393C", false);
    drawLine(shNorm, "#FF8C00", false);
    drawLine(hsNorm, "#1E90FF", true);

    ctx.setFillStyle("#999");
    ctx.setFontSize(9);
    ctx.setTextAlign("right");
    ctx.setTextBaseline("middle");
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(1), m.left - 6, m.top + (ph / 4) * i);
    }

    ctx.setTextAlign("center");
    ctx.setTextBaseline("top");
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      const label = this.data.activeTab === "year" ? data[idx].date : data[idx].date.slice(5);
      ctx.fillText(label, xp(idx), h - m.bottom + 6);
    }

    const legendY = 8;
    ctx.setFontSize(8);
    const legends = [{ label: "我的收益", color: "#E4393C" }];
    if (shNorm) legends.push({ label: "上证指数", color: "#FF8C00" });
    if (hsNorm) legends.push({ label: "沪深300", color: "#1E90FF" });
    let lx = m.left;
    legends.forEach((leg) => {
      ctx.setFillStyle(leg.color);
      ctx.fillRect(lx, legendY, 12, 3);
      ctx.setFillStyle("#666");
      ctx.setTextAlign("left");
      ctx.setTextBaseline("top");
      ctx.fillText(leg.label, lx + 16, legendY - 2);
      lx += 80;
    });

    ctx.draw();
  },
});
