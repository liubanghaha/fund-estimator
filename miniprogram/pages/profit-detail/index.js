const api = require("../../utils/api");

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
    this._canvasW = windowWidth - 24;
    this._canvasH = Math.round(this._canvasW * 0.59);
    this.setData({ canvasW: this._canvasW, canvasH: this._canvasH });
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const [pfRes, idxRes] = await Promise.all([
        api.getPortfolio(30),
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

      // 用全部净值历史算日变动
      const dailyChange = {};
      holdings.forEach((h) => {
        const history = navHistoryMap[h.fundCode] || [];
        let shares = parseFloat(h.shares || h.amount || 0);
        if (!shares && h.marketValue && h.currentNav) {
          shares = parseFloat(h.marketValue) / parseFloat(h.currentNav);
        }
        if (!shares || history.length < 2) return;
        for (let i = 1; i < history.length; i++) {
          const date = history[i].date;
          const chg = (history[i].nav - history[i - 1].nav) * shares;
          if (!dailyChange[date]) dailyChange[date] = 0;
          dailyChange[date] += chg;
        }
      });
      for (const d of Object.keys(dailyChange)) {
        dailyChange[d] = +dailyChange[d].toFixed(2);
      }

      // 如果持仓刚创建尚无所史变动，todayProfit 即为首日收益
      const hasHistory = Object.keys(dailyChange).length > 0;
      const todayProfit = parseFloat(data.todayProfit) || 0;

      const indexDaily = idxRes || [];

      // 每日总市值
      const dateMap = {};
      holdings.forEach((h) => {
        (navHistoryMap[h.fundCode] || []).forEach((item) => {
          if (!dateMap[item.date]) dateMap[item.date] = 0;
          dateMap[item.date] += item.nav * h.shares;
        });
      });

      let allDaily = Object.entries(dateMap)
        .map(([date, value]) => ({
          date,
          value: +value.toFixed(2),
          profit: +(value - totalCost).toFixed(2),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // 日历数据（即使走势图为空也生成结构）
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
        const e = allDaily.length > 0 ? allDaily[0].date : todayStr;
        this.setData({
          totalCost, earliestCreate: e,
          todayProfit: showProfit, todayProfitRate: showRate,
          weekProfit: showProfit, monthProfit: showProfit, yearProfit: showProfit,
          weekProfitRate: showRate, monthProfitRate: showRate, yearProfitRate: showRate,
          loading: false,
          selectedMonth, availableMonths,
          selectedYear, availableYears,
          dayCalendar, monthCalendar, yearData,
        }, () => {
          setTimeout(() => this.drawChart(), 800);
        });
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

      const earliestCreate = allDaily.length > 0 ? allDaily[0].date : todayStr;
      this.setData({
        totalCost, earliestCreate,
        todayProfit: todayProfit.toFixed(2),
        todayProfitRate: parseFloat(data.todayProfitRate || 0),
        weekProfit: finalWeekSum.toFixed(2),
        monthProfit: finalMonthSum.toFixed(2),
        yearProfit: finalYearSum.toFixed(2),
        weekProfitRate: fmtRate(parseFloat(finalWeekSum)),
        monthProfitRate: fmtRate(parseFloat(finalMonthSum)),
        yearProfitRate: fmtRate(parseFloat(finalYearSum)),
        loading: false,
        selectedMonth, availableMonths,
        selectedYear, availableYears,
        dayCalendar, monthCalendar, yearData,
      }, () => {
        setTimeout(() => this.drawChart(), 500);
      });
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  onSummaryTap(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab }, () => {
      setTimeout(() => this.drawChart(), 300);
    });
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
      setTimeout(() => this.drawChart(), 300);
    });
  },

  onGoHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  async loadIndexData(indexCode) {
    try {
      const res = await api.fetchMarketIndexClient(indexCode, 30);
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

  drawChart() {
    const { portfolio, isComparing, indexOnly } = this.getChartData();
    if (!portfolio || portfolio.length < 2) return;

    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = this._canvasW || 340, h = this._canvasH || 200;
    const list = portfolio;

    // 取值：indexOnly 时只用 indexRate，否则优先 baseRate
    const vals = indexOnly
      ? list.map(d => d.indexRate)
      : list.map(d => d.baseRate);
    const idxVals = list.filter(d => d.indexRate !== null).map(d => d.indexRate);
    const allVals = [...vals.filter(v => v != null), ...idxVals];
    if (allVals.length === 0) return;
    const min = Math.min(...allVals), max = Math.max(...allVals);
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;

    const m = { top: 24, right: 12, bottom: 36, left: 52 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (list.length - 1)) * i;
    const yp = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, w, h);

    if (!indexOnly) {
      const isUp = vals[vals.length - 1] >= vals[0];
      const pfColor = isUp ? '#E4393C' : '#2E8B57';
      const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
      gradient.addColorStop(0, isUp ? 'rgba(228,57,60,0.10)' : 'rgba(46,139,87,0.10)');
      gradient.addColorStop(1, isUp ? 'rgba(228,57,60,0.01)' : 'rgba(46,139,87,0.01)');
      ctx.beginPath();
      let pfStarted = false;
      list.forEach((d, i) => {
        if (d.baseRate === null) { pfStarted = false; return; }
        const x = xp(i), y = yp(d.baseRate);
        if (!pfStarted) { ctx.moveTo(x, y); pfStarted = true; } else ctx.lineTo(x, y);
      });
      if (pfStarted) {
        ctx.lineTo(xp(list.length - 1), h - m.bottom);
        ctx.lineTo(xp(0), h - m.bottom);
        ctx.closePath();
        ctx.setFillStyle(gradient);
        ctx.fill();
        ctx.beginPath();
        pfStarted = false;
        list.forEach((d, i) => {
          if (d.baseRate === null) { pfStarted = false; return; }
          const x = xp(i), y = yp(d.baseRate);
          if (!pfStarted) { ctx.moveTo(x, y); pfStarted = true; } else ctx.lineTo(x, y);
        });
        ctx.setStrokeStyle(pfColor);
        ctx.setLineWidth(2);
        ctx.stroke();
      }
    }

    // 指数线（有数据时始终画）
    if (idxVals.length >= 2) {
      const showCompare = isComparing || indexOnly;
      const idxColor = indexOnly ? '#E4393C' : '#1976D2';
      ctx.beginPath();
      let started = false;
      list.forEach((d, i) => {
        if (d.indexRate === null) { started = false; return; }
        const x = xp(i), y = yp(d.indexRate);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.setStrokeStyle(idxColor);
      ctx.setLineWidth(2);
      ctx.stroke();

      if (showCompare) {
        ctx.setFontSize(9);
        ctx.setTextBaseline('top');
        if (indexOnly) {
          ctx.setFillStyle('#E4393C');
          ctx.fillRect(m.left + 4, 4, 10, 3);
          ctx.setFillStyle('#666');
          ctx.setTextAlign('left');
          ctx.fillText(this.data.compareLabel, m.left + 17, 1);
        } else {
          const pfColor = vals[vals.length - 1] >= vals[0] ? '#E4393C' : '#2E8B57';
          ctx.setFillStyle(pfColor);
          ctx.fillRect(m.left + 4, 4, 10, 3);
          ctx.setFillStyle('#666');
          ctx.setTextAlign('left');
          ctx.fillText('我的', m.left + 17, 1);
          ctx.setFillStyle('#1976D2');
          ctx.fillRect(m.left + 50, 4, 10, 3);
          ctx.setFillStyle('#666');
          ctx.fillText(this.data.compareLabel, m.left + 63, 1);
        }
      }
    }

    // Y轴
    ctx.setFillStyle('#999');
    ctx.setFontSize(10);
    ctx.setTextAlign('right');
    ctx.setTextBaseline('middle');
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(1) + '%', m.left - 6, yp(val));
    }

    // X轴
    ctx.setTextAlign('center');
    ctx.setTextBaseline('top');
    const steps = Math.min(5, list.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (list.length - 1));
      let label = list[idx].date.slice(5);
      if (this.data.activeTab === 'year') label = list[idx].date.slice(5, 7) + '月';
      ctx.fillText(label, xp(idx), h - m.bottom + 8);
    }

    ctx.draw();
  },
});
