const api = require("../../utils/api");

Page({
  data: { isLoggedIn: false, avatarUrl: "", nickName: "" },
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
          this.setData({ isLoggedIn: false, avatarUrl: "", nickName: "" });
        }
      },
    });
  },
  onSearchFund() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAddHolding() { wx.navigateTo({ url: "/pages/add-holding/index" }); },
});
