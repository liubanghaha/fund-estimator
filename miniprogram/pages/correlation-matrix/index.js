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
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    if (typeof wx.showChangelog === 'function') wx.showChangelog();
    this.fetchAll();
  },

  async fetchAll() {
    this.setData({ loading: true, loadError: false });
    try {
      // 1. 获取持仓 + 健康分 + 资产配置（优先读首页缓存，5分钟内不重复拉）
      let d;
      const portfolioCache = wx.getStorageSync("portfolio_cache");
      if (portfolioCache && portfolioCache.holdings && portfolioCache.updateTime) {
        const cacheAge = Date.now() - (portfolioCache.ts || 0);
        if (cacheAge < 300000) {
          d = portfolioCache;
        }
      }
      if (!d) {
        const res = await wx.cloud.callFunction({ name: "getPortfolio", data: { historyDays: 0 } });
        d = res.result && res.result.data;
      }
      if (!d || !d.holdings || d.holdings.length === 0) {
        this.setData({ loading: false });
        return;
      }

      this.setData({
        healthScore: d.healthScore || null,
        assetAllocation: d.assetAllocation || null,
      }, () => {
        if (d.healthScore) this._drawHealthRing(d.healthScore.score);
      });

      const fundCodes = d.holdings.map(h => h.fundCode);
      const fundNames = d.holdings.map(h => h.fundName);
      this.setData({ fundCodes, fundNames });

      // 2. 持仓重合度分析（持仓季度更新，缓存 30 天；加减仓自动失效）
      if (fundCodes.length >= 2) {
        const codeKey = [...fundCodes].sort().join(',');
        const cache = wx.getStorageSync('asset_analysis_cache') || {};
        if (cache.codeKey === codeKey && cache.ts && (Date.now() - cache.ts < 2592000000)) {
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

  _drawHealthRing(score) {
    const query = wx.createSelectorQuery();
    query.select('#healthCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const dpr = wx.getSystemInfoSync().pixelRatio;
      const w = res[0].width;
      const h = res[0].height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;

      // 底色环
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#EEE';
      ctx.stroke();

      // 进度弧
      const pct = Math.min(1, Math.max(0, score / 100));
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + pct * 2 * Math.PI;
      const color = score >= 80 ? '#4CAF50' : score >= 60 ? '#1976D2' : score >= 40 ? '#FF9800' : '#E4393C';

      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.lineWidth = 8;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.stroke();
    });
  },

  onToggleSharedStock(e) {
    const idx = e.currentTarget.dataset.index;
    const stocks = this.data.sharedStocks;
    stocks[idx]._open = !stocks[idx]._open;
    this.setData({ sharedStocks: stocks });
  },
});
