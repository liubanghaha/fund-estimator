const api = require("../../utils/api");

const EXTRA_WIDTH = 260;
const PAGE_SIZE = 8;

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
    pageHeight: 0,
    indexBarHeight: 0,
    refresherTriggered: false,
  },

  onLoad() {
    const { windowHeight } = wx.getSystemInfoSync();
    this.setData({ pageHeight: windowHeight });
  },

  onShow() {
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.fetchPortfolio();
      this.fetchIndices();
    } else {
      this.setData({ isLoggedIn: false, holdings: [] });
    }
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
        const holdings = (d.holdings || []).map((h) => ({
          ...h, _scrollX: 0, _transition: false,
        }));
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
        });
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

  async fetchIndices() {
    const INDEX_LIST = [
      { code: "000001", name: "上证指数" },
      { code: "399001", name: "深证成指" },
      { code: "000300", name: "沪深300" },
      { code: "399006", name: "创业板指" },
      { code: "HSTECH", name: "恒生科技" },
      { code: "HSI", name: "恒生指数" },
    ];
    try {
      const results = await Promise.all(
        INDEX_LIST.map((idx) => api.fetchMarketIndex(idx.code, 2).catch(() => null))
      );
      const indexCards = INDEX_LIST.map((idx, i) => {
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
      indexBarHeight: indexExpanded ? 210 : 110,
    });
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

  onTouchStart(e) {
    const idx = e.currentTarget.dataset.index;
    const h = this.data.holdings[idx];
    this._touchData = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      index: idx,
      baseScroll: h._scrollX || 0,
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
    const idx = this._touchData.index;
    const px = this.rpxToPx(EXTRA_WIDTH);
    let newX = this._touchData.baseScroll + dx;
    newX = Math.min(0, Math.max(-px, newX));
    this.setData({
      [`holdings[${idx}]._scrollX`]: newX,
      [`holdings[${idx}]._transition`]: false,
    });
  },

  onTouchEnd(e) {
    if (!this._touchData) return;
    const idx = this._touchData.index;
    const holdings = this.data.holdings;
    const px = this.rpxToPx(EXTRA_WIDTH);
    for (let i = 0; i < holdings.length; i++) {
      if (i !== idx && holdings[i]._scrollX !== 0) {
        holdings[i]._scrollX = 0;
        holdings[i]._transition = true;
      }
    }
    const cur = holdings[idx]._scrollX || 0;
    if (Math.abs(cur) > px * 0.3) {
      holdings[idx]._scrollX = -px;
    } else {
      holdings[idx]._scrollX = 0;
    }
    holdings[idx]._transition = true;
    this.setData({ holdings });
    this._touchData = null;
  },

  rpxToPx(rpx) {
    const { windowWidth } = wx.getSystemInfoSync();
    return (rpx / 750) * windowWidth;
  },

  onTapHolding(e) {
    const idx = e.currentTarget.dataset.index;
    const holdings = this.data.holdings;
    if (this._touchData && this._touchData.moved) return;
    if (holdings[idx] && holdings[idx]._scrollX < 0) {
      holdings[idx]._scrollX = 0;
      holdings[idx]._transition = true;
      this.setData({ holdings });
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onLongPressHolding(e) {
    const { id } = e.currentTarget.dataset;
    const _this = this;
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success(res) {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
        } else if (res.tapIndex === 1) {
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
