Page({
  data: {
    theme: "blue",
    healthScore: null,
    assetAllocation: null,
    fundCodes: [],
    fundNames: [],
    matrix: [],
    pairs: [],
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
          const pairs = matrix.map(m => ({
            key: `${m.fundA}_${m.fundB}`,
            nameA: fundNames[fundCodes.indexOf(m.fundA)],
            nameB: fundNames[fundCodes.indexOf(m.fundB)],
            corr: m.correlation,
          })).sort((a, b) => b.corr - a.corr);
          this.setData({ matrix, pairs, commonDates });
        }
      }

      this.setData({ loading: false });
    } catch (e) {
      console.error("资产分析失败:", e);
      this.setData({ loading: false, loadError: true });
    }
  },
});
