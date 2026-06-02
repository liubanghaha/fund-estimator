const api = require("../../utils/api");
const calc = require("../../utils/calculator");
const chartUtil = require("../../utils/chart");

Page({
  data: {
    activeTab: "week",
    loading: true,
    empty: false,
    totalCost: 0,
    todayProfit: "0.00",
    todayProfitRate: "0.00",
    weekProfit: "0.00",
    monthProfit: "0.00",
    yearProfit: "0.00",
    weekProfitRate: "0.00",
    monthProfitRate: "0.00",
    yearProfitRate: "0.00",
    calendarView: "day",
    selectedMonth: "",
    availableMonths: [],
    dayCalendar: [],
    monthCalendar: [],
    yearData: [],
    selectedYear: "",
    availableYears: [],
    compareIndex: "000300",
    compareLabel: "沪深300",
    availableIndices: [
      { code: "000300", name: "沪深300" },
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "399006", name: "创业板指" },
    ],
  },

  onLoad() {
    const { windowWidth } = wx.getSystemInfoSync();
    const canvasW = windowWidth - 24;
    const canvasH = Math.round(canvasW * 0.59);
    this._canvasW = canvasW;
    this._canvasH = canvasH;
    this.setData({ canvasW, canvasH });
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const [pfRes, idxRes] = await Promise.all([
        api.getPortfolio(80),
        this.loadIndexData(this.data.compareIndex),
      ]);

      if (!pfRes.result || pfRes.result.code !== 0) {
        this.setData({ loading: false });
        return;
      }
      const data = pfRes.result.data;
      const holdings = data.holdings || [];
      if (holdings.length === 0) {
        this.setData({ loading: false, empty: true });
        return;
      }

      // 有持仓但没有历史走势数据（刚导入），不算 empty
      const empty = false;

      const totalCost = holdings.reduce((sum, h) => sum + h.buyPrice * h.shares, 0);
      const navHistoryMap = data.navHistoryMap || {};

      // 合并遍历：同时计算日变动 + 每日总市值 + 最早创建日
      const dailyChange = {};
      const dateMap = {};
      let earliestCreate = "9999-99-99";
      holdings.forEach((h) => {
        const history = navHistoryMap[h.fundCode] || [];
        let shares = parseFloat(h.shares || h.amount || 0);
        if (!shares && h.marketValue && h.currentNav) {
          shares = parseFloat(h.marketValue) / parseFloat(h.currentNav);
        }
        const startDate = h.createTime ? calc.formatDate(h.createTime) : null;
        if (startDate && startDate < earliestCreate) earliestCreate = startDate;

        history.forEach((item) => {
          if (!dateMap[item.date]) dateMap[item.date] = 0;
          dateMap[item.date] += item.nav * h.shares;
        });

        if (!shares || history.length < 2) return;
        for (let i = 1; i < history.length; i++) {
          const date = history[i].date;
          if (startDate && date < startDate) continue;
          const chg = (history[i].nav - history[i - 1].nav) * shares;
          if (!dailyChange[date]) dailyChange[date] = 0;
          dailyChange[date] += chg;
        }
      });
      for (const d of Object.keys(dailyChange)) {
        dailyChange[d] = +dailyChange[d].toFixed(2);
      }

      const hasHistory = Object.keys(dailyChange).length > 0;
      const todayProfit = parseFloat(data.todayProfit) || 0;
      const indexDaily = idxRes || [];

      let allDaily = Object.entries(dateMap)
        .filter(([date]) => date >= earliestCreate)
        .map(([date, value]) => ({
          date,
          value: +value.toFixed(2),
          profit: +(value - totalCost).toFixed(2),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // 日历数据（即使走势图为空也生成结构）
      const now = new Date();
      const todayStr = calc.formatDate(now);
      const currentMonth = todayStr.slice(0, 7);
      const currentYear = todayStr.slice(0, 4);
      const availableMonths = [...new Set(Object.keys(dateMap).map(d => d.slice(0, 7)))].sort().reverse();
      const availableYears = [...new Set(Object.keys(dateMap).map(d => d.slice(0, 4)))].sort().reverse();
      const selectedMonth = availableMonths.length > 0 ? availableMonths[0] : currentMonth;
      const selectedYear = availableYears.length > 0 ? availableYears[0] : currentYear;
      const dayCalendar = this.buildDayCalendar(allDaily, dailyChange, selectedMonth);
      const monthCalendar = this.buildMonthCalendar(dailyChange, selectedYear);
      const yearData = this.buildYearData(allDaily, dailyChange);

      if (allDaily.length < 2) {
        const showProfit = todayProfit.toFixed(2);
        const showRate = parseFloat(data.todayProfitRate || 0);
        this._allDaily = [];
        this._dailyChange = dailyChange;
        this._indexDaily = indexDaily;
        this.setData({
          totalCost, earliestCreate,
          todayProfit: showProfit, todayProfitRate: showRate,
          weekProfit: showProfit, monthProfit: showProfit, yearProfit: showProfit,
          weekProfitRate: showRate, monthProfitRate: showRate, yearProfitRate: showRate,
          loading: false,
          selectedMonth, availableMonths,
          selectedYear, availableYears,
          dayCalendar, monthCalendar, yearData,
        }, () => this.drawChart());
        return;
      }

      // 本周/本月/本年 收益
      const weekStart = this.getWeekStart(now);

      const sumSince = (prefix, len) => {
        let sum = 0;
        for (const [date, chg] of Object.entries(dailyChange)) {
          if (date.slice(0, len) === prefix) sum += chg;
        }
        return +sum.toFixed(2);
      };

      let weekSum = 0;
      for (const [date, chg] of Object.entries(dailyChange)) {
        if (date >= weekStart) weekSum += chg;
      }
      weekSum = +weekSum.toFixed(2);

      const monthSum = sumSince(currentMonth, 7);
      const yearSum = sumSince(currentYear, 4);

      const finalWeekSum = hasHistory ? weekSum : todayProfit;
      const finalMonthSum = hasHistory ? monthSum : todayProfit;
      const finalYearSum = hasHistory ? yearSum : todayProfit;

      console.log("=== profit sums ===", { hasHistory, todayProfit, weekSum: finalWeekSum, monthSum: finalMonthSum, yearSum: finalYearSum });

      const fmtRate = (profit) => totalCost > 0 ? +((profit / totalCost) * 100).toFixed(2) : 0;

      this._allDaily = allDaily;
      this._dailyChange = dailyChange;
      this._indexDaily = indexDaily;
      this._totalCost = totalCost;

      console.log("=== indexDaily loaded ===", indexDaily.length, "points, first:", indexDaily[0], "last:", indexDaily[indexDaily.length - 1]);
      console.log("=== allDaily ===", allDaily.length, "points, first:", allDaily[0], "last:", allDaily[allDaily.length - 1]);

      this.setData({
        totalCost,
        todayProfit: todayProfit.toFixed(2),
        todayProfitRate: parseFloat(data.todayProfitRate || 0),
        weekProfit: finalWeekSum.toFixed(2),
        monthProfit: finalMonthSum.toFixed(2),
        yearProfit: finalYearSum.toFixed(2),
        weekProfitRate: fmtRate(parseFloat(finalWeekSum)),
        monthProfitRate: fmtRate(parseFloat(finalMonthSum)),
        yearProfitRate: fmtRate(parseFloat(finalYearSum)),
        loading: false,
        earliestCreate,
        selectedMonth, availableMonths,
        selectedYear, availableYears,
        dayCalendar, monthCalendar, yearData,
      }, () => this.drawChart());
    } catch (e) {
      console.error("加载收益数据失败:", e);
      this.setData({ loading: false });
    }
  },

  getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return calc.formatDate(d);
  },

  onSummaryTap(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab }, () => this.drawChart());
  },

  buildDayCalendar(allDaily, dailyChange, month) {
    const dataMap = {};
    allDaily.forEach(d => { dataMap[d.date] = d; });
    const [year, mon] = month.split('-').map(Number);
    const firstDay = new Date(year, mon - 1, 1).getDay();
    const daysInMonth = new Date(year, mon, 0).getDate();
    const weeks = [];
    let week = [];
    for (let i = 0; i < firstDay; i++) week.push({ day: '', empty: true });

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${month}-${String(d).padStart(2, '0')}`;
      const chg = dailyChange[dateStr];
      week.push({ day: d, date: dateStr, profit: chg !== undefined ? chg : null, empty: chg === undefined });
      if (week.length === 7) { weeks.push(week); week = []; }
    }
    while (week.length > 0 && week.length < 7) week.push({ day: '', empty: true });
    if (week.length === 7) weeks.push(week);
    return weeks;
  },

  onMonthChange(e) {
    const idx = e.detail.value;
    const selectedMonth = this.data.availableMonths[idx];
    const dayCalendar = this.buildDayCalendar(this._allDaily, this._dailyChange, selectedMonth);
    this.setData({ selectedMonth, dayCalendar });
  },

  onYearChange(e) {
    const idx = e.detail.value;
    const selectedYear = this.data.availableYears[idx];
    const monthCalendar = this.buildMonthCalendar(this._dailyChange, selectedYear);
    this.setData({ selectedYear, monthCalendar });
  },

  onCalendarTab(e) {
    this.setData({ calendarView: e.currentTarget.dataset.tab });
  },

  buildMonthCalendar(dailyChange, year) {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => {
      const prefix = `${year}-${String(m).padStart(2, '0')}`;
      let profit = 0;
      let hasData = false;
      for (const [date, chg] of Object.entries(dailyChange)) {
        if (date.startsWith(prefix)) { profit += chg; hasData = true; }
      }
      profit = +profit.toFixed(2);
      return { month: m, date: prefix, profit, empty: !hasData };
    });
  },

  buildYearData(allDaily, dailyChange) {
    const years = [...new Set(Object.keys(dailyChange).map(d => d.slice(0, 4)))].sort();
    return years.map(y => {
      let profit = 0;
      for (const [date, chg] of Object.entries(dailyChange)) {
        if (date.startsWith(y)) profit += chg;
      }
      profit = +profit.toFixed(2);
      return { date: y + '-12-31', profit };
    });
  },

  async onSelectIndex(e) {
    const { code, name } = e.currentTarget.dataset;
    if (code === this.data.compareIndex) return;
    wx.showLoading({ title: "加载指数..." });
    const indexDaily = await this.loadIndexData(code);
    this._indexDaily = indexDaily;
    console.log("=== onSelectIndex ===", code, indexDaily.length, indexDaily.slice(0, 2));
    this.setData({ compareIndex: code, compareLabel: name }, () => {
      wx.hideLoading();
      this.drawChart();
    });
  },

  onGoHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  async loadIndexData(indexCode) {
    try {
      const res = await api.fetchMarketIndexClient(indexCode, 80);
      console.log("=== idx res ===", indexCode, res ? res.code : 'null', res && res.data ? res.data.length : 0);
      if (res && res.code === 0 && res.data && res.data.length > 0) {
        return res.data.map(d => ({ date: d.date, close: d.close }));
      }
    } catch (e) { console.error("加载指数失败:", e); }
    return [];
  },

  // ======== 走势图 ========

  getChartData() {
    const { activeTab } = this.data;
    const allDaily = this._allDaily || [];
    const indexDaily = this._indexDaily || [];

    // 无组合数据但有指数数据 → 只画指数
    if (allDaily.length < 2) {
      console.log("=== getChartData indexOnly ===", { idxLen: indexDaily.length, activeTab });
      if (indexDaily.length < 2) return { portfolio: [], isComparing: false };
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      let startDate;
      if (activeTab === "week") startDate = this.getWeekStart(today);
      else if (activeTab === "month") startDate = todayStr.slice(0, 7) + "-01";
      else startDate = todayStr.slice(0, 4) + "-01-01";
      const filtered = indexDaily.filter(d => d.date >= startDate);
      if (filtered.length < 2) return { portfolio: [], isComparing: false };
      const base = filtered[0].close;
      const merged = filtered.map(d => ({
        date: d.date, baseRate: null,
        indexRate: base > 0 ? +((d.close / base - 1) * 100).toFixed(2) : 0,
      }));
      return { portfolio: merged, isComparing: false, indexOnly: true };
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    let startDate;
    if (activeTab === "week") startDate = this.getWeekStart(today);
    else if (activeTab === "month") startDate = todayStr.slice(0, 7) + "-01";
    else startDate = todayStr.slice(0, 4) + "-01-01";

    const portfolio = allDaily.filter(d => d.date >= startDate);
    if (portfolio.length < 2) { console.log("=== getChartData: portfolio too short ===", startDate, portfolio.length); return { portfolio: [], isComparing: false }; }

    const baseVal = portfolio[0].value;

    // 构建指数日期映射
    const idxByDate = {};
    indexDaily.forEach(d => { idxByDate[d.date] = d.close; });
    const idxDates = Object.keys(idxByDate).sort();

    const findClose = (dateStr) => {
      if (idxByDate[dateStr] !== undefined) return idxByDate[dateStr];
      for (let i = idxDates.length - 1; i >= 0; i--) {
        if (idxDates[i] <= dateStr) return idxByDate[idxDates[i]];
      }
      return null;
    };

    const indexBase = findClose(portfolio[0].date);

    const merged = portfolio.map(p => {
      const c = findClose(p.date);
      return {
        date: p.date,
        baseRate: +((p.value / baseVal - 1) * 100).toFixed(2),
        indexRate: (indexBase && c && indexBase > 0) ? +((c / indexBase - 1) * 100).toFixed(2) : null,
      };
    });

    const hasCompare = indexBase !== null && merged.some(d => d.indexRate !== null);
    console.log("=== getChartData ===", {
      tab: activeTab, startDate, actualStart: portfolio[0].date,
      pfLen: portfolio.length, idxLen: indexDaily.length,
      indexBase, hasCompare,
      idxFirst: idxDates[0], idxLast: idxDates[idxDates.length - 1],
      firstMerged: merged[0], lastMerged: merged[merged.length - 1],
    });

    return { portfolio: merged, isComparing: hasCompare };
  },

  _getPfColor(data) {
    if (!data || data.length < 2) return '#E4393C';
    const first = data[0].baseRate, last = data[data.length - 1].baseRate;
    return last >= first ? '#E4393C' : '#2E8B57';
  },

  drawChart() {
    const { portfolio, isComparing, indexOnly } = this.getChartData();
    if (!portfolio || portfolio.length < 2) return;

    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const p = { top: 36, right: 12, bottom: 36, left: 52 };

    if (indexOnly) {
      const data = portfolio.map(d => ({ date: d.date, value: d.indexRate }));
      chartUtil.drawLineChart(ctx, { w, h, data, xField: 'date', yField: 'value',
        color: '#E4393C', padding: p });
    } else if (isComparing) {
      const color = this._getPfColor(portfolio);
      chartUtil.drawDualLineChart(ctx, {
        w, h, data: portfolio, padding: p,
        fieldA: 'baseRate', fieldB: 'indexRate',
        colorA: color, colorB: '#1976D2',
        labelA: '我的', labelB: this.data.compareLabel,
      });
    } else {
      const data = portfolio.map(d => ({ date: d.date, value: d.baseRate }));
      const color = this._getPfColor(portfolio);
      chartUtil.drawLineChart(ctx, { w, h, data, xField: 'date', yField: 'value',
        color, padding: p });
    }
    ctx.draw();
  },

  onProfitTouch(e) {
    const { portfolio, isComparing, indexOnly } = this.getChartData();
    if (!portfolio || portfolio.length < 2) return;
    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const p = { top: 36, right: 12, bottom: 36, left: 52 };
    const baseOpts = { w, h, padding: p };

    if (e.type === 'touchend') {
      this.drawChart();
      return;
    }
    if (e.type === 'touchstart') this.drawChart();

    if (indexOnly) {
      const data = portfolio.map(d => ({ date: d.date, value: d.indexRate }));
      chartUtil.handleTouch(ctx, e, { ...baseOpts, data, color: '#E4393C' });
    } else if (isComparing) {
      const color = this._getPfColor(portfolio);
      chartUtil.handleDualTouch(ctx, e, {
        ...baseOpts, data: portfolio,
        fieldA: 'baseRate', fieldB: 'indexRate',
        colorA: color, colorB: '#1976D2',
        labelA: '我的', labelB: this.data.compareLabel,
      });
    } else {
      const data = portfolio.map(d => ({ date: d.date, value: d.baseRate }));
      const color = this._getPfColor(portfolio);
      chartUtil.handleTouch(ctx, e, { ...baseOpts, data, color });
    }
    ctx.draw();
  },
});
