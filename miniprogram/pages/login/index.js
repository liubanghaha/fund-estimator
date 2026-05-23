const api = require("../../utils/api");

Page({
  data: {},
  async onLogin() {
    wx.showLoading({ title: "登录中..." });
    try {
      const res = await api.userLogin();
      if (!res.result || res.result.code !== 0) {
        wx.hideLoading();
        wx.showToast({ title: "登录失败，请重试", icon: "none" });
        return;
      }
      // 云登录成功，接着获取微信头像昵称授权
      wx.hideLoading();
      this.getUserProfile(res.result.data.openid);
    } catch (e) {
      wx.hideLoading();
      console.error("登录失败:", e);
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
    }
  },
  getUserProfile(openid) {
    wx.getUserProfile({
      desc: "用于展示你的微信头像和昵称",
      success: (res) => {
        wx.setStorageSync("userInfo", {
          loggedIn: true,
          openid: openid,
          avatarUrl: res.userInfo.avatarUrl,
          nickName: res.userInfo.nickName,
        });
        wx.showToast({ title: "登录成功", icon: "success" });
        setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
      },
      fail: () => {
        // 用户拒绝授权，仍可登录，只是用默认头像
        wx.setStorageSync("userInfo", { loggedIn: true, openid: openid });
        wx.showToast({ title: "登录成功", icon: "success" });
        setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
      },
    });
  },
});
