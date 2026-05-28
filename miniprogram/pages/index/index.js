const api = require("../../utils/api");

const EXTRA_WIDTH = 280;
const PAGE_SIZE = 8;

const ALL_INDICES = [
  { code: "000001", name: "上证指数" },
  { code: "399001", name: "深证成指" },
  { code: "000300", name: "沪深300" },
  { code: "399006", name: "创业板指" },
  { code: "HSTECH", name: "恒生科技" },
  { code: "HSI", name: "恒生指数" },
  { code: "SPX", name: "标普500" },
  { code: "IXIC", name: "纳斯达克" },
];

const CACHE_KEY = "portfolio_cache";

Page({
  data: {
    isLoggedIn: false,
    loading: false,
    holdings: [],
    displayCount: PAGE_SIZE,
    hasMore: false,
    amountVisible: true,
    totalAmount: "0.00",
    todayProfit: "0.00",
    todayProfitRate: "0.00",
    totalReturn: "0.00",
    totalReturnRate: "0.00",
    updateTime: "",
    indexCards: [],
    indexExpanded: false,
    indexLoading: false,
    showIndexEdit: false,
    ALL_INDICES,
    activeIndices: ALL_INDICES.slice(0, 6),
    editSelections: {},
    pageHeight: 0,
    indexBarHeight: 0,
    refresherTriggered: false,
    fromCache: false,
    sortField: "todayProfit",
    sortOrder: "desc",
    listScrollX: 0,
    listSliding: false,
  },

  onLoad() {
    const { windowHeight } = wx.getSystemInfoSync();
    this.setData({ pageHeight: windowHeight });
  },

  onShow() {
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });
    const savedCodes = wx.getStorageSync("indexCodes");
    let activeIndices = ALL_INDICES.slice(0, 6);
    if (savedCodes && savedCodes.length > 0) {
      activeIndices = ALL_INDICES.filter((idx) => savedCodes.indexOf(idx.code) !== -1);
    }
    this.setData({ activeIndices });
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.applyCache();
      this.fetchPortfolio();
      this.fetchIndices();
    } else {
      this.setData({ isLoggedIn: false, holdings: [] });
    }
  },

  applyCache() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.holdings && cached.holdings.length > 0) {
        let holdings = cached.holdings;
        holdings = this.sortHoldings(holdings);
        this.setData({
          holdings,
          displayCount: PAGE_SIZE,
          hasMore: holdings.length > PAGE_SIZE,
          totalAmount: cached.totalAmount,
          todayProfit: cached.todayProfit,
          todayProfitRate: cached.todayProfitRate,
          totalReturn: cached.totalReturn,
          totalReturnRate: cached.totalReturnRate,
          updateTime: cached.updateTime || "",
          fromCache: true,
        });
      }
    } catch (e) { /* ignore cache read error */ }
  },

  onToggleAmount() {
    const v = !this.data.amountVisible;
    this.setData({ amountVisible: v });
    wx.setStorageSync("amountVisible", v);
  },

  onScrollRefresh() {
    Promise.all([this.fetchPortfolio(), this.fetchIndices()]).finally(() => {
      this.setData({ refresherTriggered: false });
    });
  },

  async fetchPortfolio() {
    this.setData({ loading: true });
    try {
      const res = await api.getPortfolio();
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        let holdings = (d.holdings || []);
        holdings = this.sortHoldings(holdings);
        this.setData({
          loading: false,
          holdings,
          displayCount: PAGE_SIZE,
          hasMore: holdings.length > PAGE_SIZE,
          totalAmount: d.totalAmount,
          todayProfit: d.todayProfit,
          todayProfitRate: d.todayProfitRate,
          totalReturn: d.totalReturn,
          totalReturnRate: d.totalReturnRate,
          updateTime: d.updateTime || "",
          fromCache: false,
        });
        wx.setStorage({ key: CACHE_KEY, data: { holdings, totalAmount: d.totalAmount, todayProfit: d.todayProfit, todayProfitRate: d.todayProfitRate, totalReturn: d.totalReturn, totalReturnRate: d.totalReturnRate, updateTime: d.updateTime, ts: Date.now() } });
      }
    } catch (e) {
      this.setData({ loading: false });
      console.error("获取持仓失败:", e);
    }
  },

  loadMore() {
    const { holdings, displayCount } = this.data;
    const next = displayCount + PAGE_SIZE;
    this.setData({
      displayCount: next,
      hasMore: next < holdings.length,
    });
  },

  onSortTap(e) {
    const field = e.currentTarget.dataset.field;
    const { sortField, sortOrder } = this.data;
    let nextField = field;
    let nextOrder = 'desc';
    if (sortField === field) {
      nextOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    }
    const sorted = this.sortHoldings([...this.data.holdings], nextField, nextOrder);
    this.setData({ sortField: nextField, sortOrder: nextOrder, holdings: sorted, displayCount: PAGE_SIZE, hasMore: sorted.length > PAGE_SIZE });
  },

  sortHoldings(list, field, order) {
    const f = field || this.data.sortField;
    const o = order || this.data.sortOrder;
    const dir = o === 'asc' ? 1 : -1;
    if (f === 'todayProfit') {
      return list.sort((a, b) => {
        if (a.estimateUpdated !== b.estimateUpdated) return a.estimateUpdated ? -1 : 1;
        return dir * (parseFloat(a.todayProfit) - parseFloat(b.todayProfit));
      });
    }
    return list.sort((a, b) => dir * (parseFloat(a.totalReturn) - parseFloat(b.totalReturn)));
  },

  async fetchIndices() {
    const activeIndices = this.data.activeIndices;
    try {
      const results = await Promise.all(
        activeIndices.map((idx) => api.fetchMarketIndex(idx.code, 2).catch(() => null))
      );
      const indexCards = activeIndices.map((idx, i) => {
        const res = results[i];
        const data = (res && res.result && res.result.code === 0 && res.result.data) || [];
        if (data.length >= 1) {
          const latest = data[data.length - 1];
          const prev = data.length >= 2 ? data[data.length - 2] : latest;
          const change = +(latest.close - prev.close).toFixed(2);
          const changeRate = prev.close && prev.close !== 0
            ? +((change / prev.close) * 100).toFixed(2) : 0;
          return {
            name: idx.name,
            code: idx.code,
            price: latest.close.toFixed(2),
            change: change > 0 ? `+${change}` : `${change}`,
            changeRate: changeRate > 0 ? `+${changeRate}` : `${changeRate}`,
            isUp: change >= 0,
          };
        }
        return { name: idx.name, code: idx.code, price: "--", change: "--", changeRate: "--", isUp: true };
      });
      this.setData({ indexCards, indexLoading: false, indexBarHeight: 110 });
    } catch (e) {
      this.setData({ indexLoading: false });
      console.error("获取指数失败:", e);
    }
  },

  onToggleIndex() {
    const indexExpanded = !this.data.indexExpanded;
    this.setData({
      indexExpanded,
      showIndexEdit: false,
      indexBarHeight: indexExpanded ? 210 : 110,
    });
  },

  onToggleIndexEdit() {
    const show = !this.data.showIndexEdit;
    const selections = {};
    const activeCodes = this.data.activeIndices.map((i) => i.code);
    ALL_INDICES.forEach((idx) => {
      selections[idx.code] = activeCodes.indexOf(idx.code) !== -1;
    });
    this.setData({
      showIndexEdit: show,
      indexExpanded: false,
      editSelections: selections,
      indexBarHeight: show ? 420 : 110,
    });
  },

  onToggleIndexItem(e) {
    const { code } = e.currentTarget.dataset;
    const selections = { ...this.data.editSelections };
    selections[code] = !selections[code];
    this.setData({ editSelections: selections });
  },

  onSaveIndexPrefs() {
    const codes = [];
    ALL_INDICES.forEach((idx) => {
      if (this.data.editSelections[idx.code]) codes.push(idx.code);
    });
    if (codes.length === 0) {
      wx.showToast({ title: "至少保留一个指数", icon: "none" });
      return;
    }
    wx.setStorageSync("indexCodes", codes);
    const activeIndices = ALL_INDICES.filter((idx) => codes.indexOf(idx.code) !== -1);
    this.setData({
      showIndexEdit: false,
      activeIndices,
      indexBarHeight: 110,
      indexExpanded: false,
    });
    this.fetchIndices();
  },

  onScrollToLower() {
    if (this.data.hasMore) {
      this.loadMore();
    }
  },

  onTapProfit() {
    wx.navigateTo({ url: "/pages/profit-detail/index" });
  },

  noop() {},

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  onSearch() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },
  onAdjust() {
    const holdings = this.data.holdings;
    if (holdings.length === 0) {
      wx.showToast({ title: "暂无持仓", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/adjust-holding/index" });
  },

  onTouchStart(e) {
    this._touchData = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      baseScroll: this.data.listScrollX,
      moved: false,
    };
  },

  onTouchMove(e) {
    if (!this._touchData) return;
    const dx = e.touches[0].clientX - this._touchData.startX;
    const dy = e.touches[0].clientY - this._touchData.startY;
    if (!this._touchData.moved && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 5) {
      this._touchData.moved = true;
    }
    if (!this._touchData.moved) return;
    const px = this.rpxToPx(EXTRA_WIDTH);
    let newX = this._touchData.baseScroll + dx;
    newX = Math.min(0, Math.max(-px, newX));
    this.setData({ listScrollX: newX, listSliding: true });
  },

  onTouchEnd(e) {
    if (!this._touchData) return;
    const px = this.rpxToPx(EXTRA_WIDTH);
    const cur = this.data.listScrollX;
    const snapX = Math.abs(cur) > px * 0.3 ? -px : 0;
    this.setData({ listScrollX: snapX, listSliding: false });
    this._touchData = null;
  },

  rpxToPx(rpx) {
    const { windowWidth } = wx.getSystemInfoSync();
    return (rpx / 750) * windowWidth;
  },

  onTapHolding(e) {
    if (this._touchData && this._touchData.moved) return;
    if (this.data.listScrollX < 0) {
      this.setData({ listScrollX: 0, listSliding: false });
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onLongPressHolding(e) {
    const { id } = e.currentTarget.dataset;
    const _this = this;
    wx.showActionSheet({
      itemList: ['编辑', '加减持仓', '删除'],
      success(res) {
        const h = _this.data.holdings.find((x) => x._id === id);
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
        } else if (res.tapIndex === 1) {
          wx.navigateTo({ url: "/pages/adjust-holding/index" });
        } else if (res.tapIndex === 2) {
          wx.showModal({
            title: "确认删除",
            content: "确定要删除此条持仓吗？",
            success(r) {
              if (!r.confirm) return;
              wx.showLoading({ title: "删除中..." });
              wx.cloud.database().collection("holdings").doc(id).remove()
                .then(() => {
                  wx.hideLoading();
                  wx.showToast({ title: "已删除", icon: "success" });
                  _this.fetchPortfolio();
                })
                .catch(() => {
                  wx.hideLoading();
                  wx.showToast({ title: "删除失败", icon: "none" });
                });
            },
          });
        }
      },
    });
  },
});
