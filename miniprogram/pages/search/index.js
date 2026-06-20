const api = require("../../utils/api");
Page({
  data: { ready: false, keyword: "", fundList: [], isLoading: false, errorMsg: "", hasSearched: false },
  onLoad(options) {
    this._loaded = true;
    const theme = wx.getStorageSync("theme") || "blue";
    this.setData({ theme });
    if (options.keyword) {
      this.setData({ keyword: decodeURIComponent(options.keyword) });
      wx.nextTick(() => this.onSearch());
    }
  },
  onShow() { if (!this._loaded) { wx.switchTab({ url: "/pages/index/index" }); return; } this.setData({ ready: true }); },
  onInput(e) { this.setData({ keyword: e.detail.value }); },
  async onSearch() {
    const { keyword } = this.data;
    if (!keyword.trim()) { wx.showToast({ title: "请输入基金代码或名称", icon: "none" }); return; }
    this.setData({ isLoading: true, errorMsg: "", hasSearched: true });
    try {
      const res = await api.searchFund(keyword.trim());
      if (res.result && res.result.code === 0) {
        this.setData({ fundList: res.result.data, isLoading: false });
      } else {
        this.setData({ errorMsg: res.result?.msg || "搜索失败", isLoading: false });
      }
    } catch (e) {
      this.setData({ errorMsg: "网络错误，请重试", isLoading: false });
    }
  },
  onTapFund(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name)}` });
  },
  onRetry() {
    this.onSearch();
  },
});
