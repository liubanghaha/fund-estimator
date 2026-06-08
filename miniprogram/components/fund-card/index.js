const calculator = require("../../utils/calculator");

Component({
  properties: {
    fundCode: { type: String, value: "" },
    fundName: { type: String, value: "" },
    nav: { type: Number, value: null },
    lastNav: { type: Number, value: null },
    changeRate: { type: String, value: "" },
    showTap: { type: Boolean, value: true },
  },
  observers: {
    "nav, lastNav, changeRate": function (nav, lastNav, changeRate) {
      if (changeRate && changeRate !== "") {
        const v = parseFloat(changeRate);
        this.setData({ isPositive: v > 0, isNegative: v < 0 });
        return;
      }
      if (nav != null && lastNav != null && lastNav !== 0) {
        const cr = calculator.formatPercent(((nav - lastNav) / lastNav) * 100);
        this.setData({ changeRate: cr, isPositive: nav > lastNav, isNegative: nav < lastNav });
      }
    },
  },
  data: {
    isPositive: false,
    isNegative: false,
    changeAmount: "",
  },
  methods: {
    onTap() {
      if (this.properties.showTap) {
        this.triggerEvent("tap", { fundCode: this.properties.fundCode });
      }
    },
  },
});
