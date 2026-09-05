const api = require("../../utils/api");
const track = require("../../utils/track");
Page({
  data: { ready: false, keyword: "", fundList: [], isLoading: false, errorMsg: "", hasSearched: false },
  onLoad(options) {
    this._loaded = true;
    if (options.keyword) {
      this.setData({ keyword: decodeURIComponent(options.keyword) });
      wx.nextTick(() => this.onSearch());
    }
  },
  onShow() { if (!this._loaded) { wx.switchTab({ url: "/pages/index/index" }); return; } this.setData({ theme: wx.getStorageSync("theme") || "red", ready: true }); },
  onInput(e) { this.setData({ keyword: e.detail.value }); },
  async onSearch() {
    const { keyword } = this.data;
    if (!keyword.trim()) { wx.showToast({ title: "请输入代码或名称", icon: "none" }); return; }
    this.setData({ isLoading: true, errorMsg: "", hasSearched: true });
    try {
      const res = await api.searchFund(keyword.trim());
      if (res.result && res.result.code === 0) {
        const list = res.result.data || [];
        this.setData({ fundList: list, isLoading: false });
        // 搜索质量埋点：命中数 / 无结果是搜索功能质量的核心口径
        track.searchFund({ kw: keyword.trim().slice(0, 20), hit: list.length > 0, n: list.length });
      } else {
        this.setData({ errorMsg: (res.result && res.result.msg) || "搜索失败", isLoading: false });
        track.searchFund({ kw: keyword.trim().slice(0, 20), hit: null, n: 0, err: "api" });
      }
    } catch (e) {
      this.setData({ errorMsg: "网络错误，请重试", isLoading: false });
      track.searchFund({ kw: keyword.trim().slice(0, 20), hit: null, n: 0, err: "network" });
    }
  },
  onTapFund(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/subpackages/analysis/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name)}` });
  },
  onRetry() {
    this.onSearch();
  },
});
