const calculator = {
  // 选择当前净值：实际已更新用实际值，否则用估算值，都没有用昨日净值
  selectNav(yesterdayNav, actualNav, estimatedNav) {
    const nav = parseFloat(yesterdayNav);
    const aNav = parseFloat(actualNav);
    const eNav = parseFloat(estimatedNav);
    if (!isNaN(aNav) && aNav !== nav) return aNav;
    if (!isNaN(eNav)) return eNav;
    return !isNaN(aNav) ? aNav : nav;
  },

  // 选择当前涨跌幅：与 selectNav 逻辑一致
  selectChangeRate(yesterdayNav, actualNav, estimatedChangeRate, actualChangeRate) {
    const nav = parseFloat(yesterdayNav);
    const aNav = parseFloat(actualNav);
    if (!isNaN(aNav) && aNav !== nav) return parseFloat(actualChangeRate) || 0;
    if (estimatedChangeRate != null) return parseFloat(estimatedChangeRate);
    return parseFloat(actualChangeRate) || 0;
  },

  // 格式化日期为 YYYY-MM-DD
  formatDate(dateOrTs) {
    const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs);
    if (isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },
  calcPeriodReturns(history) {
    if (!history || history.length === 0) return { day: null, week: null, month: null, threeMonth: null, sixMonth: null, year: null };
    const latest = history[0].nav;
    const g = (days) => {
      if (history.length <= days) return null;
      const nav = history[days] && history[days].nav;
      if (nav == null || isNaN(nav)) return null;
      return parseFloat(((latest - nav) / nav * 100).toFixed(2));
    };
    return { day: history[0].changeRate || 0, week: g(4), month: g(19), threeMonth: g(64), sixMonth: g(129), year: g(249), threeYear: g(749) };
  },
  formatPercent(value) {
    const v = parseFloat(value);
    if (isNaN(v)) return "--";
    if (Math.abs(v) < 0.005) return "0.00%";
    return v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
  },

  // 最大回撤：返回最大回撤率(%)、峰值日期、谷底日期、距峰值的当前回撤
  calcMaxDrawdown(history) {
    if (!history || history.length < 5) return { drawdown: null, peakDate: null, troughDate: null, currentDrawdown: null };
    let peak = history[history.length - 1].nav;
    let peakDate = history[history.length - 1].date;
    let maxDD = 0, ddPeakDate = peakDate, ddTroughDate = peakDate;
    for (let i = history.length - 2; i >= 0; i--) {
      const nav = history[i].nav;
      if (!nav || nav <= 0) continue;
      if (nav > peak) { peak = nav; peakDate = history[i].date; }
      const dd = (nav - peak) / peak * 100;
      if (dd < maxDD) { maxDD = dd; ddPeakDate = peakDate; ddTroughDate = history[i].date; }
    }
    const currentDD = history[0].nav > 0 ? (history[0].nav - peak) / peak * 100 : null;
    return { drawdown: parseFloat(maxDD.toFixed(2)), peakDate: ddPeakDate, troughDate: ddTroughDate, currentDrawdown: currentDD != null ? parseFloat(currentDD.toFixed(2)) : null };
  },

  // 年化波动率
  calcVolatility(history) {
    if (!history || history.length < 20) return null;
    const returns = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i].nav > 0 && history[i - 1].nav > 0) {
        returns.push((history[i].nav - history[i - 1].nav) / history[i - 1].nav);
      }
    }
    if (returns.length < 10) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    return parseFloat((Math.sqrt(variance) * Math.sqrt(250) * 100).toFixed(2));
  },

  // 夏普比率（无风险利率 2.5%）
  calcSharpe(history) {
    if (!history || history.length < 20) return null;
    const volatility = this.calcVolatility(history);
    if (!volatility || volatility === 0) return null;
    const days = Math.min(250, history.length);
    const latest = history[0].nav;
    const past = history[days - 1] && history[days - 1].nav;
    if (!past || past <= 0) return null;
    const annualizedReturn = (Math.pow(latest / past, 250 / days) - 1) * 100;
    const riskFree = 2.5;
    return parseFloat(((annualizedReturn - riskFree) / volatility).toFixed(2));
  },
};
module.exports = calculator;
