const calculator = {
  calcPeriodReturns(history) {
    if (!history || history.length === 0) return { day: null, week: null, month: null, threeMonth: null, sixMonth: null, year: null };
    const latest = history[0].nav;
    const g = (days) => {
      if (history.length <= days) return null;
      const nav = history[days] && history[days].nav;
      if (!nav) return null;
      return parseFloat(((latest - nav) / nav * 100).toFixed(2));
    };
    return { day: history[0].changeRate || 0, week: g(4), month: g(19), threeMonth: g(64), sixMonth: g(129), year: g(249) };
  },
  getReturnRate(currentValue, costValue) {
    if (!costValue || costValue === 0) return 0;
    return ((currentValue - costValue) / costValue) * 100;
  },
  getReturnAmount(currentValue, costValue) {
    return currentValue - costValue;
  },
  getMarketValue(nav, shares) {
    return (nav || 0) * (shares || 0);
  },
  getChangeColor(value) {
    if (value > 0) return "#E4393C";
    if (value < 0) return "#2E8B57";
    return "#999999";
  },
  formatPercent(value) {
    const v = parseFloat(value);
    if (isNaN(v)) return "--";
    return v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
  },
  formatMoney(value) {
    const v = parseFloat(value);
    if (isNaN(v)) return "--";
    return v.toFixed(2);
  },
};
module.exports = calculator;
