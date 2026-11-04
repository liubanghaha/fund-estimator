const api = require("../../utils/api");
const track = require("../../utils/track");
const recent = require("../../utils/recent");
const HISTORY_KEY = "search_history"; // 搜索历史（最多 10 条，去重、新在前）
Page({
  data: { ready: false, keyword: "", fundList: [], isLoading: false, errorMsg: "", hasSearched: false, history: [], historyVisible: false, fromAdd: false, followMap: {} },
  onLoad(options) {
    // 漏斗埋点：搜索页进入（与 search_fund/search_result_tap 串成 搜索→详情 链路）
    try { track.track("page_enter", { page: "search" }); } catch (e) { /* ignore */ }
    // 仅带 source=add（如添加持仓流程选基金）时结果项显示「添加持仓」按钮，正常入口行为不变
    if (options.source === "add") this.setData({ fromAdd: true });
    if (options.keyword) {
      this.setData({ keyword: decodeURIComponent(options.keyword) });
      wx.nextTick(() => this.onSearch());
    }
  },
  onShow() {
    this.setData({ theme: wx.getStorageSync("theme") || "red", ready: true });
    // R3-b：初始化结果行的关注态（一次拉自选列表建 map，避免逐个 watchlistCheck）
    api.watchlistList().then((res) => {
      if (!res.result || res.result.code !== 0) return;
      const followMap = {};
      (res.result.data || []).forEach(w => { if (w.fundCode) followMap[w.fundCode] = true; });
      this.setData({ followMap });
    }).catch(() => {});
  },
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
    // 东财搜索混入美股/ETF（代码非 6 位数字，如 TSLA/CRSH）：本产品只做基金，
    // 这类结果不进详情页（详情页数据源均为基金接口，进入只会报错）
    if (!/^\d{6}$/.test(String(code || ""))) {
      wx.showToast({ title: "仅支持公募基金", icon: "none" });
      return;
    }
    recent.addFund(code, name); // R6：点进详情即记入「最近查看」
    // 漏斗埋点：搜索结果→详情（此前只有 search_fund 发起，结果点击率是盲区）
    try { track.track("search_result_tap", { fundCode: code, kw: String(this.data.keyword || "").slice(0, 20) }); } catch (e) { /* ignore */ }
    wx.navigateTo({ url: `/subpackages/analysis/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name)}` });
  },

  // R3-b：结果行直接关注（catch 阻止冒泡，不跳详情）；成功后写入最近查看并更新按钮态
  async onFollowTap(e) {
    const { code, name } = e.currentTarget.dataset;
    if (!/^\d{6}$/.test(String(code || ""))) return; // 非基金代码（美股/ETF）不提供关注
    if (this.data.followMap[code]) return;
    try {
      const res = await api.watchlistAdd(code, name);
      if (res.result && res.result.code === 0) {
        recent.addFund(code, name);
        this.setData({ [`followMap.${code}`]: true });
        wx.showToast({ title: "已加自选", icon: "success" });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "操作失败", icon: "none" });
      }
    } catch (err) {
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
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
