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
};
module.exports = calculator;
