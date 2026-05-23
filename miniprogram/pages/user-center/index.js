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
      if (!res.result || res.result.code !== 0) {
        wx.hideLoading();
        wx.showToast({ title: "登录失败，请重试", icon: "none" });
        return;
      }
      wx.hideLoading();
      this.getUserProfile(res.result.data.openid);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
  },
  getUserProfile(openid) {
    wx.getUserProfile({
      desc: "用于展示你的微信头像和昵称",
      success: (res) => {
        const userInfo = {
          loggedIn: true,
          openid: openid,
          avatarUrl: res.userInfo.avatarUrl,
          nickName: res.userInfo.nickName,
        };
        wx.setStorageSync("userInfo", userInfo);
        this.setData({
          isLoggedIn: true,
          avatarUrl: userInfo.avatarUrl,
          nickName: userInfo.nickName,
        });
        wx.showToast({ title: "登录成功", icon: "success" });
      },
      fail: () => {
        wx.setStorageSync("userInfo", { loggedIn: true, openid: openid });
        this.setData({ isLoggedIn: true });
        wx.showToast({ title: "登录成功", icon: "success" });
      },
    });
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
