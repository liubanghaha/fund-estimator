const api = require("../../utils/api");

Page({
  data: { isLoggedIn: false, avatarUrl: "", nickName: "", showFeedback: false, feedbackText: "", feedbackSubmitting: false },
  onShow() {
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({
        isLoggedIn: true,
        avatarUrl: userInfo.avatarUrl || "",
        nickName: userInfo.nickName || "",
      });
    }
  },
  async onLogin() {
    wx.showLoading({ title: "登录中..." });
    try {
      const res = await api.userLogin();
      wx.hideLoading();
      if (res.result && res.result.code === 0) {
        wx.setStorageSync("userInfo", { loggedIn: true, openid: res.result.data.openid });
        this.setData({ isLoggedIn: true });
        wx.showToast({ title: "登录成功", icon: "success" });
      } else {
        wx.showToast({ title: "登录失败，请重试", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("登录失败:", e);
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
  },
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    this.setData({ avatarUrl });
    const userInfo = wx.getStorageSync("userInfo") || {};
    userInfo.avatarUrl = avatarUrl;
    wx.setStorageSync("userInfo", userInfo);
  },
  onLogout() {
    wx.showModal({
      title: "提示", content: "确定要退出登录吗？",
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync("userInfo");
          wx.removeStorageSync("watchlist_cache");
          wx.removeStorageSync("portfolio_cache");
          wx.removeStorageSync("portfolio_force_refresh");
          wx.removeStorageSync("profit_detail_cache_v2");
          wx.removeStorageSync("profit_detail_cache");
          wx.removeStorageSync("index_cache");
          wx.removeStorageSync("indexCodes");
          wx.removeStorageSync("amountVisible");
          const app = getApp();
          if (app && app.globalData) {
            app.globalData._ocrFunds = null;
            app.globalData._screenshotPath = null;
            app.globalData._syncTradeFund = null;
          }
          this.setData({ isLoggedIn: false, avatarUrl: "", nickName: "" });
        }
      },
    });
  },
  onSearchFund() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAddHolding() { wx.navigateTo({ url: "/pages/add-holding/index" }); },
  onFeedback() {
    this.setData({ showFeedback: !this.data.showFeedback, feedbackText: "" });
  },
  onFeedbackInput(e) {
    this.setData({ feedbackText: e.detail.value });
  },
  async onSubmitFeedback() {
    const content = (this.data.feedbackText || "").trim();
    if (!content) { wx.showToast({ title: "请输入反馈内容", icon: "none" }); return; }
    if (content.length > 500) { wx.showToast({ title: "反馈内容不能超过500字", icon: "none" }); return; }
    this.setData({ feedbackSubmitting: true });
    try {
      const res = await api.submitFeedback(content);
      wx.showToast({ title: (res.result && res.result.code === 0) ? "感谢反馈！" : "提交失败，请重试", icon: "none" });
      if (res.result && res.result.code === 0) this.setData({ showFeedback: false, feedbackText: "" });
    } catch (e) {
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
    this.setData({ feedbackSubmitting: false });
  },
  onShowVersion() {
    const accountInfo = wx.getAccountInfoSync ? wx.getAccountInfoSync() : {};
    const version = (accountInfo.miniProgram && accountInfo.miniProgram.version) || "1.0.0";
    const env = (accountInfo.miniProgram && accountInfo.miniProgram.envVersion) || "develop";
    const envMap = { develop: "开发版", trial: "体验版", release: "正式版" };
    wx.showModal({
      title: "涨跌有数",
      content: `版本：${version}\n环境：${envMap[env] || env}`,
      showCancel: false,
      confirmText: "知道了",
    });
  },
});
