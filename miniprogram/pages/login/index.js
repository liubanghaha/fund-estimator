const api = require("../../utils/api");

Page({
  data: {},
  onLoad() {
    // 主题初始化（wxml 根节点按 theme 切换主题类）
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
  },
  async onLogin() {
    wx.showLoading({ title: "登录中..." });
    try {
      const res = await api.userLogin();
      wx.hideLoading();
      if (res.result && res.result.code === 0) {
        wx.setStorageSync("userInfo", { loggedIn: true, openid: res.result.data.openid });
        wx.showToast({ title: "登录成功", icon: "success" });
        setTimeout(() => {
          // 从用户中心等页面进入的返回原页；直接打开登录页（栈内无上级）时才回首页
          if (getCurrentPages().length > 1) wx.navigateBack();
          else wx.reLaunch({ url: "/pages/index/index" });
        }, 800);
      } else {
        wx.showToast({ title: "登录失败，请重试", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("登录失败:", e);
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
  },
});
