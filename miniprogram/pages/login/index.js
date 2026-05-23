const api = require("../../utils/api");

Page({
  data: {},
  async onLogin() {
    wx.showLoading({ title: "登录中..." });
    try {
      const res = await api.userLogin();
      wx.hideLoading();
      if (res.result && res.result.code === 0) {
        const userProfile = await this.getUserProfile();
        wx.setStorageSync("userInfo", {
          loggedIn: true,
          openid: res.result.data.openid,
          avatarUrl: userProfile.avatarUrl || "",
          nickName: userProfile.nickName || "",
        });
        wx.showToast({ title: "登录成功", icon: "success" });
        setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
      } else {
        wx.showToast({ title: "登录失败，请重试", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("登录失败:", e);
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
  },
  getUserProfile() {
    return new Promise((resolve) => {
      wx.getUserInfo({
        success: (res) => resolve({ avatarUrl: res.userInfo.avatarUrl, nickName: res.userInfo.nickName }),
        fail: () => resolve({ avatarUrl: "", nickName: "" }),
      });
    });
  },
});
