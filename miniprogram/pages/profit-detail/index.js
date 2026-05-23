const api = require("../../utils/api");

const INDEX_LIST = [
  { code: "000001", name: "上证指数", color: "#E4393C" },
  { code: "000300", name: "沪深300", color: "#FF8C00" },
  { code: "399006", name: "创业板指", color: "#1E90FF" },
];

Page({
  data: {
    activeTab: "day",
    displayMode: "amount",
    loading: true,
    dayData: [],
    monthData: [],
    yearData: [],
    dayIndex: [],
    monthIndex: [],
    yearIndex: [],
    totalCost: 0,
    todayProfit: "0.00",
    monthProfit: "0.00",
    yearProfit: "0.00",
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

      const [navResults, shResults, hs300Results, cyResults] = await Promise.all([
        Promise.all(holdings.map((h) => api.fetchFundNAVHistory(h.fundCode, 250).catch(() => null))),
        api.fetchMarketIndex("000001", 250).catch(() => null),
        api.fetchMarketIndex("000300", 250).catch(() => null),
        api.fetchMarketIndex("399006", 250).catch(() => null),
      ]);

      const parseIndex = (r) => {
        if (!r || !r.result || r.result.code !== 0) return [];
        return r.result.data || [];
      };
      const shData = parseIndex(shResults);
      const hs300Data = parseIndex(hs300Results);
      const cyData = parseIndex(cyResults);

      const buildDaily = (histories) => {
        const dateMap = {};
        histories.forEach((r, i) => {
          if (!r || !r.result || r.result.code !== 0) return;
          (r.result.data || []).forEach((item) => {
            const d = item.date;
            if (!dateMap[d]) dateMap[d] = 0;
            dateMap[d] += item.nav * holdings[i].shares;
          });
        });
        return Object.entries(dateMap)
          .map(([date, value]) => ({ date, value: +value.toFixed(2), profit: +(value - totalCost).toFixed(2) }))
          .sort((a, b) => a.date.localeCompare(b.date));
      };

      const allDaily = buildDaily(navResults);

      const mergeIndex = (profitData, indexData, indexKey) => {
        const idxMap = {};
        indexData.forEach((d) => { idxMap[d.date] = d; });
        return profitData.map((d) => {
          const idx = idxMap[d.date];
          return { ...d, [indexKey]: idx ? idx.close : null };
        }).filter((d) => d[indexKey] != null);
      };

      const dayMerged = mergeIndex(allDaily, shData, "sh").map((d) => {
        const hs = hs300Data.find((x) => x.date === d.date);
        const cy = cyData.find((x) => x.date === d.date);
        return { ...d, hs300: hs ? hs.close : null, cy: cy ? cy.close : null };
      }).filter((d) => d.hs300 != null);

      const today = new Date();
      const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

      const enrichIndexRate = (data) => {
        if (data.length === 0) return data;
        const first = data[0];
        return data.map((d) => ({
          ...d,
          shRate: first.sh && d.sh != null ? +(((d.sh / first.sh) - 1) * 100).toFixed(2) : null,
          hsRate: first.hs300 && d.hs300 != null ? +(((d.hs300 / first.hs300) - 1) * 100).toFixed(2) : null,
        }));
      };

      const dayData = enrichIndexRate(dayMerged.slice(-7));
      const monthData = enrichIndexRate(dayMerged.filter((d) => d.date.startsWith(thisMonth)));

      const monthAgg = {};
      dayMerged.forEach((d) => {
        const m = d.date.slice(0, 7);
        if (!monthAgg[m]) monthAgg[m] = d;
      });
      const yearData = enrichIndexRate(
        Object.values(monthAgg).sort((a, b) => a.date.localeCompare(b.date))
      );

      const todayProfit = allDaily.length > 0 ? allDaily[allDaily.length - 1].profit : 0;
      const monthProfit = monthData.length > 0 ? monthData[monthData.length - 1].profit : 0;
      const yearProfit = yearData.length > 0 ? yearData[yearData.length - 1].profit : 0;

      this.setData({
        dayData, monthData, yearData, totalCost,
        dayIndex: shData.slice(-10),
        monthIndex: shData,
        yearIndex: shData,
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
      const baseVal = data[0][key];
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
      data.forEach((_, i) => {
        if (series[i] == null) { started = false; return; }
        const x = xp(i), y = yp(series[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(1.5);
      if (dash) {
        ctx.setLineDash([4, 3], 0);
      }
      ctx.stroke();
      ctx.setLineDash([], 0);
    };

    // Grid lines
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

    // Y-axis labels (base 100)
    ctx.setFillStyle("#999");
    ctx.setFontSize(9);
    ctx.setTextAlign("right");
    ctx.setTextBaseline("middle");
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(1), m.left - 6, m.top + (ph / 4) * i);
    }

    // X-axis labels
    ctx.setTextAlign("center");
    ctx.setTextBaseline("top");
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      const label = this.data.activeTab === "year" ? data[idx].date : data[idx].date.slice(5);
      ctx.fillText(label, xp(idx), h - m.bottom + 6);
    }

    // Legend
    const legendY = 8;
    ctx.setFontSize(8);
    const legends = [
      { label: "我的收益", color: "#E4393C" },
      { label: "上证指数", color: "#FF8C00" },
      { label: "沪深300", color: "#1E90FF" },
    ];
    let lx = m.left;
    legends.forEach((leg) => {
      ctx.setFillStyle(leg.color);
      ctx.fillRect(lx, legendY, 12, 3);
      ctx.setFillStyle("#666");
      ctx.setTextAlign("left");
      ctx.setTextBaseline("top");
      ctx.fillText(leg.label, lx + 16, legendY - 2);
      lx += 90;
    });

    ctx.draw();
  },
});
