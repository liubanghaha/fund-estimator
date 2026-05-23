const api = require("../../utils/api");

Page({
  data: {
    watchlist: [],
    loaded: false,
  },

  onShow() {
    this.fetchWatchlist();
  },

  async fetchWatchlist() {
    try {
      const res = await api.watchlistList();
      if (res.result && res.result.code === 0 && res.result.data.length > 0) {
        const items = res.result.data;
        const estimates = await Promise.all(
          items.map((w) => api.fetchFundEstimate(w.fundCode).catch(() => null))
        );
        const watchlist = items.map((w, i) => {
          const e = estimates[i] && estimates[i].result && estimates[i].result.code === 0
            ? estimates[i].result.data : null;
          return {
            fundCode: w.fundCode,
            fundName: w.fundName,
            nav: e ? e.nav : null,
            estimatedNav: e ? e.estimatedNav : null,
            estimatedChangeRate: e ? e.estimatedChangeRate : null,
            estimateTime: e ? e.estimateTime : null,
          };
        });
        this.setData({ watchlist, loaded: true });
      } else {
        this.setData({ watchlist: [], loaded: true });
      }
    } catch (e) {
      this.setData({ loaded: true });
    }
  },

  onTapItem(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onSearch() {
    wx.navigateTo({ url: "/pages/search/index" });
  },
});
