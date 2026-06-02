const api = require("../../utils/api");

const CACHE_KEY = "watchlist_cache";

Page({
  data: {
    watchlist: [],
    loaded: false,
    batchMode: false,
  },

  onLoad() {
    this.applyCache();
  },

  onShow() {
    this.fetchWatchlist();
  },

  onPullDownRefresh() {
    this.fetchWatchlist().finally(() => wx.stopPullDownRefresh());
  },

  onTapItem(e) {
    if (this.data.batchMode) {
      this.toggleSelect(e);
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onSearch() {
    wx.navigateTo({ url: "/pages/search/index" });
  },

  onLongPressItem(e) {
    if (this.data.batchMode) return;
    const { code, name } = e.currentTarget.dataset;
    wx.showModal({
      title: "删除自选",
      content: `确定要删除 ${name}(${code}) 吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.watchlistRemove(code);
          wx.showToast({ title: "已删除", icon: "success" });
          this.fetchWatchlist();
        } catch (e) {
          wx.showToast({ title: "删除失败，请重试", icon: "none" });
        }
      },
    });
  },

  onToggleBatch() {
    const enter = !this.data.batchMode;
    const watchlist = this.data.watchlist.map(w => ({ ...w, _checked: false }));
    this.setData({ batchMode: enter, watchlist });
  },

  toggleSelect(e) {
    const idx = e.currentTarget.dataset.index;
    const watchlist = [...this.data.watchlist];
    watchlist[idx]._checked = !watchlist[idx]._checked;
    this.setData({ watchlist });
  },

  onSelectAll() {
    const allChecked = this.data.watchlist.every(w => w._checked);
    const watchlist = this.data.watchlist.map(w => ({ ...w, _checked: !allChecked }));
    this.setData({ watchlist });
  },

  async onBatchDelete() {
    const selected = this.data.watchlist.filter(w => w._checked);
    if (selected.length === 0) {
      wx.showToast({ title: "请先选择基金", icon: "none" });
      return;
    }
    wx.showModal({
      title: "批量删除",
      content: `确定删除选中的 ${selected.length} 个自选基金吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "删除中..." });
        let count = 0;
        for (const w of selected) {
          try {
            await api.watchlistRemove(w.fundCode);
            count++;
          } catch (e) { /* ignore */ }
        }
        wx.hideLoading();
        wx.showToast({ title: `已删除 ${count} 个`, icon: "success" });
        this.setData({ batchMode: false });
        this.fetchWatchlist();
      },
    });
  },

  applyCache() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.watchlist && cached.watchlist.length > 0) {
        this.setData({ watchlist: cached.watchlist, loaded: true });
      }
    } catch (e) {
      // ignore cache error
    }
  },

  async fetchWatchlist() {
    try {
      const res = await api.watchlistList();
      if (res.result && res.result.code === 0 && res.result.data.length > 0) {
        const items = res.result.data;
        const codes = items.map((w) => w.fundCode);
        const estRes = await api.batchFetchEstimate(codes).catch(() => null);
        const estData = (estRes && estRes.result && estRes.result.code === 0 && estRes.result.data) || {};

        const watchlist = items.map((w) => {
          const e = estData[w.fundCode];
          return {
            fundCode: w.fundCode,
            fundName: w.fundName,
            nav: e ? e.nav : null,
            estimatedNav: e ? e.estimatedNav : null,
            estimatedChangeRate: e ? e.estimatedChangeRate : null,
            displayChangeRate: e ? e.displayChangeRate : null,
            estimateTime: e ? e.estimateTime : null,
          };
        });
        this.setData({ watchlist, loaded: true });

        try {
          wx.setStorageSync(CACHE_KEY, { watchlist, time: Date.now() });
        } catch (e) {
          // ignore cache error
        }
      } else {
        this.setData({ watchlist: [], loaded: true });
      }
    } catch (e) {
      if (!this.data.watchlist.length) {
        this.setData({ loaded: true });
      }
    }
  },
});
