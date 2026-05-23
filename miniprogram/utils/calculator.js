const calculator = {
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
