Page({
  data: {
    theme: "blue",
    healthScore: null,
    assetAllocation: null,
    fundCodes: [],
    fundNames: [],
    matrix: [],
    warnings: [],
    commonDates: 0,
    loading: true,
    loadError: false,
  },

  onLoad() {
    const theme = wx.getStorageSync("theme") || "blue";
    this.setData({ theme });
    if (typeof wx.showChangelog === 'function') wx.showChangelog();
    this.fetchAll();
  },

  async fetchAll() {
    this.setData({ loading: true, loadError: false });
    try {
      // 1. 获取持仓 + 健康分 + 资产配置
      const res = await wx.cloud.callFunction({ name: "getPortfolio", data: { historyDays: 0 } });
      const d = res.result && res.result.data;
      if (!d || !d.holdings || d.holdings.length === 0) {
        this.setData({ loading: false });
        return;
      }

      this.setData({
        healthScore: d.healthScore || null,
        assetAllocation: d.assetAllocation || null,
      });

      const fundCodes = d.holdings.map(h => h.fundCode);
      const fundNames = d.holdings.map(h => h.fundName);
      this.setData({ fundCodes, fundNames });

      // 2. 计算相关性（至少2只基金）
      if (fundCodes.length >= 2) {
        const corrRes = await wx.cloud.callFunction({
          name: "computeCorrelation",
          data: { fundCodes },
        });
        if (corrRes.result && corrRes.result.code === 0) {
          const { matrix, commonDates } = corrRes.result.data;
          const warnings = [];
          matrix.forEach(m => {
            if (m.correlation >= 0.7) {
              const nameA = fundNames[fundCodes.indexOf(m.fundA)];
              const nameB = fundNames[fundCodes.indexOf(m.fundB)];
              warnings.push(`${nameA} 和 ${nameB} 高度相关 (${m.correlation})，建议仅保留一只`);
            }
          });
          this.setData({ matrix, commonDates, warnings });
        }
      }

      this.setData({ loading: false });
    } catch (e) {
      console.error("资产分析失败:", e);
      this.setData({ loading: false, loadError: true });
    }
  },

  getCorr(row, col) {
    if (row === col) return "1.00";
    const { fundCodes, matrix } = this.data;
    const a = fundCodes[row], b = fundCodes[col];
    if (row > col) {
      const m = matrix.find(x => x.fundA === b && x.fundB === a);
      return m ? m.correlation.toFixed(2) : "--";
    }
    const m = matrix.find(x => x.fundA === a && x.fundB === b);
    return m ? m.correlation.toFixed(2) : "--";
  },

  getCorrClass(row, col) {
    const val = this.getCorr(row, col);
    if (val === "--") return "";
    const v = parseFloat(val);
    if (v >= 0.7) return "high";
    if (v >= 0.4) return "mid";
    return "low";
  },
});
