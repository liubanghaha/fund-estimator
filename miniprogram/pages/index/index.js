const api = require("../../utils/api");

Page({
  data: {
    isLoggedIn: false,
    holdings: [],
    totalAmount: "0.00",
    todayProfit: "0.00",
    todayProfitRate: "0.00",
    totalReturn: "0.00",
    totalReturnRate: "0.00",
    updateTime: "",
  },

  onShow() {
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.fetchPortfolio();
    } else {
      this.setData({ isLoggedIn: false, holdings: [] });
    }
  },

  async fetchPortfolio() {
    try {
      const res = await api.getPortfolio();
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        this.setData({
          holdings: (d.holdings || []).map((h) => ({ ...h, _swiped: false })),
          totalAmount: d.totalAmount,
          todayProfit: d.todayProfit,
          todayProfitRate: d.todayProfitRate,
          totalReturn: d.totalReturn,
          totalReturnRate: d.totalReturnRate,
          updateTime: d.updateTime || "",
        });
      }
    } catch (e) {
      console.error("获取持仓失败:", e);
    }
  },

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  onSearch() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  // 左滑删除
  onTouchStart(e) {
    const idx = e.currentTarget.dataset.index;
    this._touchData = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, index: idx };
  },

  onTouchEnd(e) {
    if (!this._touchData) return;
    const deltaX = e.changedTouches[0].clientX - this._touchData.startX;
    const deltaY = e.changedTouches[0].clientY - this._touchData.startY;
    const idx = this._touchData.index;
    const holdings = this.data.holdings;

    if (deltaX < -40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
      for (let i = 0; i < holdings.length; i++) {
        if (i !== idx) holdings[i]._swiped = false;
      }
      holdings[idx]._swiped = true;
    } else {
      holdings[idx]._swiped = false;
    }

    this.setData({ holdings });
    this._touchData = null;
  },

  onTapHolding(e) {
    const holdings = this.data.holdings;
    const idx = e.currentTarget.dataset.index;
    if (holdings[idx] && holdings[idx]._swiped) {
      holdings[idx]._swiped = false;
      this.setData({ holdings });
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onDeleteHolding(e) {
    const id = e.currentTarget.dataset.id;
    const _this = this;
    wx.showModal({
      title: "确认删除",
      content: "确定要删除此持仓记录吗？",
      success(res) {
        if (!res.confirm) return;
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
  },
});
