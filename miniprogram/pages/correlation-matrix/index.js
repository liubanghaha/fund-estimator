Page({
  data: {
    theme: "blue",
    healthScore: null,
    assetAllocation: null,
    fundCodes: [],
    fundNames: [],
    pairs: [],
    sharedStocks: [],
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

      // 2. 持仓重合度分析（24小时内同持仓组合命中缓存）
      if (fundCodes.length >= 2) {
        const codeKey = [...fundCodes].sort().join(',');
        const cache = wx.getStorageSync('asset_analysis_cache') || {};
        if (cache.codeKey === codeKey && cache.ts && (Date.now() - cache.ts < 86400000)) {
          // 缓存命中：直接恢复
          this.setData({ sharedStocks: cache.sharedStocks || [], pairs: cache.pairs || [] });
        } else {
          const corrRes = await wx.cloud.callFunction({
            name: "computeCorrelation",
            data: { fundCodes },
          });
          if (corrRes.result && corrRes.result.code === 0) {
            const { pairs, sharedStocks } = corrRes.result.data;
            const enrichStock = (s) => ({
              ...s,
              _open: false,
              funds: (s.funds || []).map(f => ({
                ...f,
                fundName: fundNames[fundCodes.indexOf(f.fundCode)] || f.fundCode,
              })),
            });
            const enrichedPairs = (pairs || []).map(p => ({
              ...p,
              key: `${p.fundA}_${p.fundB}`,
              nameA: fundNames[fundCodes.indexOf(p.fundA)],
              nameB: fundNames[fundCodes.indexOf(p.fundB)],
            }));
            this.setData({ pairs: enrichedPairs, sharedStocks: (sharedStocks || []).map(enrichStock) });
            // 写缓存
            wx.setStorageSync('asset_analysis_cache', {
              codeKey, ts: Date.now(),
              sharedStocks: (sharedStocks || []).map(enrichStock),
              pairs: enrichedPairs,
            });
          }
        }
      }

      this.setData({ loading: false });
    } catch (e) {
      console.error("资产分析失败:", e);
      this.setData({ loading: false, loadError: true });
    }
  },

  onToggleSharedStock(e) {
    const idx = e.currentTarget.dataset.index;
    const stocks = this.data.sharedStocks;
    stocks[idx]._open = !stocks[idx]._open;
    this.setData({ sharedStocks: stocks });
  },
});
