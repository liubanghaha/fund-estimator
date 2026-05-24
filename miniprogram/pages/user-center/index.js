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
  onFeedback() {
    wx.showModal({
      title: "意见反馈",
      content: "如有问题或建议，欢迎通过客服会话反馈",
      confirmText: "联系客服",
      cancelText: "取消",
      success: (res) => {
        if (res.confirm) {
          wx.openCustomerServiceChat
            ? wx.openCustomerServiceChat({})
            : wx.showToast({ title: "请在小程序中联系客服", icon: "none" });
        }
      },
    });
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
