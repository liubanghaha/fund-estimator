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
  },

  onShow() {
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.fetchPortfolio();
    } else {
      this.setData({ isLoggedIn: false, holdings: [] });
    }
  },

  onToggleAmount() {
    const v = !this.data.amountVisible;
    this.setData({ amountVisible: v });
    wx.setStorageSync("amountVisible", v);
  },

  onPullDownRefresh() {
    this.fetchPortfolio().finally(() => {
      wx.stopPullDownRefresh();
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

  onReachBottom() {
    if (this.data.hasMore) {
      this.loadMore();
    }
  },

  onTapProfit() {
    wx.navigateTo({ url: "/pages/profit-detail/index" });
  },

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  onSearch() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  // 左右滑动卡片
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

    // 判断为横向滑动
    if (!this._touchData.moved && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 5) {
      this._touchData.moved = true;
    }
    if (!this._touchData.moved) return;

    const idx = this._touchData.index;
    const px = this.rpxToPx(EXTRA_WIDTH);
    let newX = this._touchData.baseScroll + dx;
    // 限制滑动范围：0 ~ -extraWidth
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

    // 关掉其他卡片的滑动
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
    // 如果卡片已滑开，先收起
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
