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
    "nav, lastNav": function (nav, lastNav) {
      if (nav != null && lastNav != null) {
        const changeRate = calculator.formatPercent(((nav - lastNav) / lastNav) * 100);
        const isPositive = nav > lastNav;
        const isNegative = nav < lastNav;
        this.setData({ changeRate, isPositive, isNegative });
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
