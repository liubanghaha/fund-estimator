const api = require("../../utils/api");
const track = require("../../utils/track");
const HISTORY_KEY = "search_history"; // 搜索历史（最多 10 条，去重、新在前）
Page({
  data: { ready: false, keyword: "", fundList: [], isLoading: false, errorMsg: "", hasSearched: false, history: [], historyVisible: false, fromAdd: false },
  onLoad(options) {
    // 仅带 source=add（如添加持仓流程选基金）时结果项显示「添加持仓」按钮，正常入口行为不变
    if (options.source === "add") this.setData({ fromAdd: true });
    if (options.keyword) {
      this.setData({ keyword: decodeURIComponent(options.keyword) });
      wx.nextTick(() => this.onSearch());
    }
  },
  onShow() { this.setData({ theme: wx.getStorageSync("theme") || "red", ready: true }); },
  onInput(e) { this.setData({ keyword: e.detail.value }); },
  onInputFocus() {
    // 聚焦且输入为空时展示搜索历史
    if (!this.data.keyword.trim()) this.setData({ history: this._loadHistory(), historyVisible: true });
  },
  onInputBlur() {
    // 延迟收起：让历史项的 tap 先触发，避免点击失效
    if (this._historyTimer) clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => this.setData({ historyVisible: false }), 200);
  },
  onTapHistory(e) {
    if (this._historyTimer) clearTimeout(this._historyTimer);
    this.setData({ keyword: e.currentTarget.dataset.kw, historyVisible: false });
    this.onSearch();
  },
  onClearHistory() {
    try { wx.removeStorageSync(HISTORY_KEY); } catch (e) { /* ignore */ }
    this.setData({ history: [], historyVisible: false });
  },
  _loadHistory() {
    try { return wx.getStorageSync(HISTORY_KEY) || []; } catch (e) { return []; }
  },
  _saveHistory(kw) {
    // 去重、新在前，最多保留 10 条
    const list = [kw, ...this._loadHistory().filter((k) => k !== kw)].slice(0, 10);
    try { wx.setStorageSync(HISTORY_KEY, list); } catch (e) { /* ignore */ }
    this.setData({ history: list });
  },
  async onSearch() {
    const { keyword } = this.data;
    if (!keyword.trim()) { wx.showToast({ title: "请输入代码或名称", icon: "none" }); return; }
    this.setData({ isLoading: true, errorMsg: "", hasSearched: true });
    try {
      const res = await api.searchFund(keyword.trim());
      if (res.result && res.result.code === 0) {
        const list = res.result.data || [];
        // 服务降级：搜索源故障时云函数返回 degraded=true，与「未找到」区分提示
        if (res.result.degraded) {
          this.setData({ fundList: [], errorMsg: "搜索服务暂时不可用，请稍后重试", isLoading: false });
          track.searchFund({ kw: keyword.trim().slice(0, 20), hit: null, n: 0, err: "degraded" });
          return;
        }
        this.setData({ fundList: list, isLoading: false });
        if (list.length) this._saveHistory(keyword.trim());
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
  // 结果项「添加持仓」：跳添加持仓页并预填基金（add-holding onLoad 支持 fundCode/fundName 参数）
  onAddHolding(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/add-holding/index?fundCode=${code}&fundName=${encodeURIComponent(name)}` });
  },
  onRetry() {
    this.onSearch();
  },
});
