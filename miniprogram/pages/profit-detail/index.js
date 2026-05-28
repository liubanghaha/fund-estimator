const api = require("../../utils/api");

Page({
  data: {
    activeTab: "day",
    empty: false,
    calendarView: "day",
    displayMode: "amount",
    loading: true,
    allDaily: [],
    dayCalendar: [],
    monthCalendar: [],
    yearData: [],
    selectedMonth: "",
    selectedYear: "",
    availableMonths: [],
    availableYears: [],
    totalCost: 0,
    todayProfit: "0.00",
    monthProfit: "0.00",
    yearProfit: "0.00",
    todayProfitRate: "0.00",
    monthProfitRate: "0.00",
    yearProfitRate: "0.00",
    compareIndex: "000001",
    indexDaily: [],
    availableIndices: [
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "000300", name: "沪深300" },
      { code: "399006", name: "创业板指" },
    ],
    compareRange: ["不对比", "上证指数", "深证成指", "沪深300", "创业板指"],
    compareLabel: "上证指数",
  },

  onLoad() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const res = await api.getPortfolio(80);
      if (!res.result || res.result.code !== 0) {
        this.setData({ loading: false });
        return;
      }
      const holdings = res.result.data.holdings || [];
      if (holdings.length === 0) {
        this.setData({ loading: false, empty: true });
        return;
      }

      const portfolioRes = res.result.data;
      const totalCost = holdings.reduce((sum, h) => sum + h.buyPrice * h.shares, 0);
      const todayProfitFromPortfolio = parseFloat(portfolioRes.todayProfit) || 0;
      const navHistoryMap = portfolioRes.navHistoryMap || {};

      // Fetch index data in parallel with data processing
      const compareIndex = this.data.activeTab === 'day' ? '000001' : '000300';
      const compareLabel = this.data.activeTab === 'day' ? '上证指数' : '沪深300';
      const indexPromise = this.loadIndexData(compareIndex);

      const dateMap = {};
      holdings.forEach((h) => {
        const history = navHistoryMap[h.fundCode] || [];
        history.forEach((item) => {
          const d = item.date;
          if (!dateMap[d]) dateMap[d] = 0;
          dateMap[d] += item.nav * h.shares;
        });
      });

      let allDaily = Object.entries(dateMap)
        .map(([date, value]) => ({
          date,
          value: +value.toFixed(2),
          profit: +(value - totalCost).toFixed(2),
          profitRate: totalCost > 0 ? +(((value - totalCost) / totalCost) * 100).toFixed(2) : 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      if (allDaily.length === 0 && holdings.length === 0) {
        allDaily = this.generateMockData();
        this._isMock = true;
      }

      // 统一日变动：date → 当日收益（当天profit - 前一天profit）
      const dailyChange = {};
      for (let i = 1; i < allDaily.length; i++) {
        dailyChange[allDaily[i].date] = +(allDaily[i].profit - allDaily[i - 1].profit).toFixed(2);
      }
      this._dailyChange = dailyChange;

      // 按周期求和
      const sumByPeriod = (prefix, len) => {
        let sum = 0;
        for (const [date, chg] of Object.entries(dailyChange)) {
          if (date.slice(0, len) === prefix) sum += chg;
        }
        return +sum.toFixed(2);
      };

      const today = new Date();
      const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
      const currentYear = `${today.getFullYear()}`;

      const availableMonths = [...new Set(allDaily.map(d => d.date.slice(0, 7)))].sort().reverse();
      const availableYears = [...new Set(allDaily.map(d => d.date.slice(0, 4)))].sort().reverse();
      const selectedMonth = availableMonths.includes(currentMonth) ? currentMonth : availableMonths[0];
      const selectedYear = availableYears.includes(currentYear) ? currentYear : availableYears[0];

      const dayCalendar = this.buildDayCalendar(allDaily, dailyChange, selectedMonth, totalCost);
      const monthCalendar = this.buildMonthCalendar(dailyChange, selectedYear, totalCost);
      const yearData = this.buildYearData(dailyChange, totalCost);

      const monthProfit = sumByPeriod(currentMonth, 7);
      const monthProfitRate = totalCost > 0 ? +((monthProfit / totalCost) * 100).toFixed(2) : 0;

      const yearProfit = sumByPeriod(currentYear, 4);
      const yearProfitRate = totalCost > 0 ? +((yearProfit / totalCost) * 100).toFixed(2) : 0;

      const todayProfitRateFromPortfolio = totalCost > 0
        ? +((todayProfitFromPortfolio / totalCost) * 100).toFixed(2)
        : 0;

      const indexDaily = await indexPromise;

      this.setData({
        allDaily, totalCost, indexDaily,
        compareIndex, compareLabel,
        availableMonths, availableYears,
        selectedMonth, selectedYear,
        dayCalendar, monthCalendar, yearData,
        todayProfit: todayProfitFromPortfolio.toFixed(2),
        monthProfit: monthProfit.toFixed(2),
        yearProfit: yearProfit.toFixed(2),
        todayProfitRate: todayProfitRateFromPortfolio,
        monthProfitRate, yearProfitRate,
        loading: false,
      }, () => {
        setTimeout(() => this.drawChart(), 500);
      });
    } catch (e) {
      console.error("加载收益数据失败:", e);
      this.setData({ loading: false });
    }
  },

  generateMockData() {
    const data = [];
    const now = new Date();
    const totalCost = 100000;
    let value = totalCost;
    let date = new Date(now);
    date.setDate(date.getDate() - 80);

    while (date <= now) {
      const day = date.getDay();
      if (day !== 0 && day !== 6) {
        const change = (Math.random() - 0.48) * 300;
        value += change;
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const profit = +(value - totalCost).toFixed(2);
        data.push({
          date: dateStr,
          value: +value.toFixed(2),
          profit,
          profitRate: +((profit / totalCost) * 100).toFixed(2),
        });
      }
      date.setDate(date.getDate() + 1);
    }
    return data;
  },

  async loadIndexData(indexCode) {
    try {
      let res = await api.fetchMarketIndexClient(indexCode, 80);
      if (!res || res.code !== 0 || !res.data || res.data.length === 0) {
        res = await api.fetchMarketIndex(indexCode, 80);
        if (!res || !res.result || res.result.code !== 0) return [];
        return (res.result.data || []).map(item => ({
          date: item.date, close: item.close,
        })).sort((a, b) => a.date.localeCompare(b.date));
      }
      return (res.data || []).map(item => ({
        date: item.date, close: item.close,
      })).sort((a, b) => a.date.localeCompare(b.date));
    } catch (e) {
      console.error("加载指数数据失败:", e);
      return [];
    }
  },

  buildDayCalendar(allDaily, dailyChange, selectedMonth, totalCost) {
    const dataMap = {};
    allDaily.forEach(d => { dataMap[d.date] = d; });

    const [year, month] = selectedMonth.split('-').map(Number);
    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const startOffset = firstDay;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const weeks = [];
    let week = [];
    let day = 1;

    for (let i = 0; i < startOffset; i++) {
      week.push({ day: '', date: '', profit: null, profitRate: null, empty: true });
    }

    while (day <= daysInMonth) {
      const dateStr = `${selectedMonth}-${String(day).padStart(2, '0')}`;
      let dayProfit = null, dayProfitRate = null;
      if (dailyChange[dateStr] !== undefined) {
        dayProfit = dailyChange[dateStr];
        dayProfitRate = totalCost > 0 ? +((dayProfit / totalCost) * 100).toFixed(2) : 0;
      }
      week.push({
        day, date: dateStr,
        profit: dayProfit, profitRate: dayProfitRate,
        empty: dayProfit === null,
      });
      if (week.length === 7) { weeks.push(week); week = []; }
      day++;
    }

    while (week.length > 0 && week.length < 7) {
      week.push({ day: '', date: '', profit: null, profitRate: null, empty: true });
    }
    if (week.length === 7) weeks.push(week);

    return weeks;
  },

  buildMonthCalendar(dailyChange, year, totalCost) {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => {
      const prefix = `${year}-${String(m).padStart(2, '0')}`;
      let profit = 0;
      for (const [date, chg] of Object.entries(dailyChange)) {
        if (date.startsWith(prefix)) profit += chg;
      }
      profit = +profit.toFixed(2);
      const hasData = Object.keys(dailyChange).some(d => d.startsWith(prefix));
      return { month: m, date: prefix, profit, profitRate: totalCost > 0 ? +((profit / totalCost) * 100).toFixed(2) : 0, empty: !hasData };
    });
  },

  buildYearData(dailyChange, totalCost) {
    const years = [...new Set(Object.keys(dailyChange).map(d => d.slice(0, 4)))].sort();
    return years.map(y => {
      let profit = 0;
      for (const [date, chg] of Object.entries(dailyChange)) {
        if (date.startsWith(y)) profit += chg;
      }
      profit = +profit.toFixed(2);
      const lastDate = Object.keys(dailyChange).filter(d => d.startsWith(y)).sort().pop() || `${y}-12-31`;
      return { date: lastDate, profit, profitRate: totalCost > 0 ? +((profit / totalCost) * 100).toFixed(2) : 0 };
    });
  },

  async loadIndexAndDraw(indexCode) {
    const indexDaily = await this.loadIndexData(indexCode);
    this.setData({ indexDaily }, () => {
      setTimeout(() => this.drawChart(), 300);
    });
  },

  setCompareForTab(tab) {
    const compareIndex = tab === 'day' ? '000001' : '000300';
    const compareLabel = tab === 'day' ? '上证指数' : '沪深300';
    this.setData({ compareIndex, compareLabel });
    this.loadIndexAndDraw(compareIndex);
  },

  switchTab(tab) {
    this.setData({ activeTab: tab });
    this.setCompareForTab(tab);
  },

  onSummaryTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });
    this.setCompareForTab(tab);
  },

  onTabTap(e) {
    const view = e.currentTarget.dataset.tab;
    this.setData({ calendarView: view });
  },

  onMonthChange(e) {
    const idx = e.detail.value;
    const selectedMonth = this.data.availableMonths[idx];
    const dayCalendar = this.buildDayCalendar(this.data.allDaily, this._dailyChange, selectedMonth, this.data.totalCost);
    this.setData({ selectedMonth, dayCalendar }, () => {
      setTimeout(() => this.drawChart(), 300);
    });
  },

  onYearChange(e) {
    const idx = e.detail.value;
    const selectedYear = this.data.availableYears[idx];
    const monthCalendar = this.buildMonthCalendar(this._dailyChange, selectedYear, this.data.totalCost);
    this.setData({ selectedYear, monthCalendar }, () => {
      setTimeout(() => this.drawChart(), 300);
    });
  },

  async onCompareChange(e) {
    const idx = parseInt(e.detail.value);
    if (idx === 0) {
      this.setData({ compareIndex: "", indexDaily: [], compareLabel: "对比指数" }, () => {
        setTimeout(() => this.drawChart(), 300);
      });
      return;
    }
    const indexInfo = this.data.availableIndices[idx - 1];
    wx.showLoading({ title: "加载指数..." });
    const indexDaily = await this.loadIndexData(indexInfo.code);
    wx.hideLoading();
    this.setData({
      compareIndex: indexInfo.code,
      compareLabel: indexInfo.name,
      indexDaily,
    }, () => {
      setTimeout(() => this.drawChart(), 300);
    });
  },

  onToggleMode() {
    this.setData({ displayMode: this.data.displayMode === "amount" ? "rate" : "amount" });
  },

  onGoHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  getChartData() {
    const { activeTab, allDaily, selectedMonth, selectedYear, indexDaily } = this.data;

    // Day tab: use recent daily data for comparison
    if (activeTab === "day") {
      const recent = allDaily.slice(-15);
      if (recent.length >= 2) return this.buildComparisonData(recent, indexDaily);
      return { portfolio: this.getIntradayMock(allDaily), isComparing: false };
    }

    let portfolio;
    if (activeTab === "month") {
      portfolio = allDaily.filter(d => d.date.startsWith(selectedMonth));
    } else {
      const monthMap = {};
      allDaily.forEach(d => {
        if (d.date.startsWith(selectedYear)) {
          monthMap[d.date.slice(0, 7)] = d;
        }
      });
      portfolio = Object.keys(monthMap).sort().map(m => monthMap[m]);
    }

    if (!portfolio.length) return { portfolio: [], isComparing: false };
    return this.buildComparisonData(portfolio, indexDaily);
  },

  buildComparisonData(portfolio, indexDaily) {
    const indexMap = {};
    if (indexDaily && indexDaily.length) {
      indexDaily.forEach(d => { indexMap[d.date] = d.close; });
    }

    // Find first point where BOTH portfolio and index have data
    let startIdx = -1, refClose = null, refValue = null;
    for (let i = 0; i < portfolio.length; i++) {
      const close = this.findIndexClose(portfolio[i].date, indexMap, indexDaily);
      if (close !== null) {
        startIdx = i;
        refClose = close;
        refValue = portfolio[i].value;
        break;
      }
    }

    if (startIdx === -1 || portfolio.length - startIdx < 2) {
      return { portfolio, isComparing: false };
    }

    const merged = portfolio.slice(startIdx).map(p => {
      const close = this.findIndexClose(p.date, indexMap, indexDaily);
      return {
        date: p.date,
        profit: p.profit,
        profitRate: p.profitRate,
        baseRate: +((p.value / refValue - 1) * 100).toFixed(2),
        indexRate: close !== null ? +((close / refClose - 1) * 100).toFixed(2) : null,
      };
    });

    return { portfolio: merged, isComparing: true };
  },

  findIndexClose(dateStr, indexMap, indexDaily) {
    // Direct match for daily dates (e.g. "2026-05-22")
    if (indexMap[dateStr] !== undefined) return indexMap[dateStr];
    // Month key (e.g. "2026-05"): find last trading day's close in that month
    if (dateStr.length === 7 && indexDaily) {
      let lastClose = null;
      for (const d of indexDaily) {
        if (d.date.startsWith(dateStr)) lastClose = d.close;
      }
      return lastClose;
    }
    return null;
  },

  getIntradayMock(allDaily) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const times = ['09:30','10:00','10:30','11:00','11:30','13:00','13:30','14:00','14:30','15:00'];
    const last = allDaily[allDaily.length - 1] || { profit: 0, profitRate: 0 };
    const prev = allDaily.length >= 2 ? allDaily[allDaily.length - 2] : last;
    const startProfit = prev.profit;
    const endProfit = (last.date === todayStr) ? last.profit : startProfit + (Math.random() - 0.48) * 500;
    const totalCost = this.data.totalCost || 100000;
    const data = [];
    times.forEach((t, i) => {
      const ratio = i / (times.length - 1);
      const noise = (Math.random() - 0.5) * (Math.abs(endProfit - startProfit) * 0.3 + 20);
      const profit = +(startProfit + (endProfit - startProfit) * ratio + noise).toFixed(2);
      const profitRate = +((profit / totalCost) * 100).toFixed(2);
      data.push({ date: t, value: 0, profit, profitRate });
    });
    return data;
  },

  drawChart() {
    const { portfolio, isComparing } = this.getChartData();
    if (!portfolio || portfolio.length < 2) return;

    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = 340, h = 200;
    const list = portfolio;

    // Determine values to plot and Y-axis unit
    let values, yUnit;
    if (isComparing) {
      values = list.map(d => d.baseRate);
      const indexRates = list.filter(d => d.indexRate !== null).map(d => d.indexRate);
      const allVals = [...values, ...indexRates];
      const min = Math.min(...allVals), max = Math.max(...allVals);
      const range = max - min || 0.01;
      const pad = range * 0.15;
      this._yRange = { min: min - pad, max: max + pad };
      yUnit = '%';
    } else {
      values = list.map(d => d.profitRate);
      const minP = Math.min(...values), maxP = Math.max(...values);
      const range = maxP - minP || 0.01;
      const pad = range * 0.15;
      this._yRange = { min: minP - pad, max: maxP + pad };
      yUnit = '%';
    }

    const { min: yMin, max: yMax } = this._yRange;
    const m = { top: 24, right: 12, bottom: 36, left: 52 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (list.length - 1)) * i;
    const yp = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, w, h);

    // Draw portfolio gradient and line
    const isUp = values[values.length - 1] >= values[0];
    const pfColor = isUp ? '#E4393C' : '#2E8B57';
    const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
    gradient.addColorStop(0, isUp ? 'rgba(228,57,60,0.10)' : 'rgba(46,139,87,0.10)');
    gradient.addColorStop(1, isUp ? 'rgba(228,57,60,0.01)' : 'rgba(46,139,87,0.01)');
    ctx.beginPath();
    list.forEach((d, i) => { const x = xp(i), y = yp(values[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.lineTo(xp(list.length - 1), h - m.bottom);
    ctx.lineTo(xp(0), h - m.bottom);
    ctx.closePath();
    ctx.setFillStyle(gradient);
    ctx.fill();

    ctx.beginPath();
    list.forEach((d, i) => { const x = xp(i), y = yp(values[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.setStrokeStyle(pfColor);
    ctx.setLineWidth(2);
    ctx.stroke();

    // Draw index comparison line (aligned to same X positions)
    if (isComparing) {
      let idxStarted = false;
      ctx.beginPath();
      list.forEach((d, i) => {
        if (d.indexRate === null) {
          idxStarted = false;
          return;
        }
        const x = xp(i), y = yp(d.indexRate);
        if (!idxStarted) { ctx.moveTo(x, y); idxStarted = true; }
        else { ctx.lineTo(x, y); }
      });
      ctx.setStrokeStyle('#1976D2');
      ctx.setLineWidth(2);
      ctx.stroke();

      // Legend in top-right of chart area
      ctx.setFontSize(9);
      ctx.setTextBaseline('top');
      const legendY = 4;
      // Portfolio
      ctx.setFillStyle(pfColor);
      ctx.fillRect(m.left + 4, legendY, 14, 3);
      ctx.setFillStyle('#666');
      ctx.setTextAlign('left');
      ctx.fillText('我的', m.left + 22, legendY - 1);
      // Index
      ctx.setFillStyle('#1976D2');
      const ixX = m.left + 54;
      ctx.fillRect(ixX, legendY, 14, 3);
      ctx.setFillStyle('#666');
      ctx.fillText(this.data.compareLabel, ixX + 18, legendY - 1);
    }

    // Y-axis labels
    ctx.setFillStyle('#999');
    ctx.setFontSize(10);
    ctx.setTextAlign('right');
    ctx.setTextBaseline('middle');
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      const label = val.toFixed(1) + yUnit;
      ctx.fillText(label, m.left - 6, yp(val));
    }

    // X-axis labels
    ctx.setTextAlign('center');
    ctx.setTextBaseline('top');
    const steps = Math.min(5, list.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (list.length - 1));
      let label;
      if (this.data.activeTab === 'year') {
        label = list[idx].date.slice(5, 7) + '月';
      } else if (this.data.activeTab === 'day') {
        label = list[idx].date.slice(5);
      } else {
        label = list[idx].date.slice(5);
      }
      ctx.fillText(label, xp(idx), h - m.bottom + 8);
    }
    ctx.draw();
  },
});
