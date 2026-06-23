const api = require("../../utils/api");

Page({
  data: {
    isLoggedIn: false, avatarUrl: "", nickName: "",
    showFeedback: false,
    feedbackType: "suggestion",
    feedbackText: "",
    feedbackImages: [],
    feedbackSubmitting: false,
  },

  onShow() {
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({
        isLoggedIn: true,
        avatarUrl: userInfo.avatarUrl || "",
        nickName: userInfo.nickName || "",
      });
    }
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
  },

  onToggleTheme() {
    const next = this.data.theme === "red" ? "blue" : "red";
    this.setData({ theme: next });
    wx.setStorageSync("theme", next);
    // 更新所有栈内页面
    const pages = getCurrentPages();
    pages.forEach(p => {
      if (p.setData) p.setData({ theme: next });
    });
    wx.showToast({ title: "重启小程序后全部生效", icon: "none", duration: 2000 });
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

  // ========== 意见反馈 ==========

  onFeedback() {
    if (this.data.showFeedback) {
      // 收起时重置表单
      this.setData({
        showFeedback: false,
        feedbackType: "suggestion",
        feedbackContact: "",
        feedbackText: "",
        feedbackImages: [],
      });
    } else {
      this.setData({ showFeedback: true });
    }
  },

  onTypeTap(e) {
    this.setData({ feedbackType: e.currentTarget.dataset.type });
  },

  onFeedbackInput(e) {
    this.setData({ feedbackText: e.detail.value });
  },

  onAddImage() {
    const remaining = 3 - this.data.feedbackImages.length;
    if (remaining <= 0) return;
    wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: (res) => {
        const paths = res.tempFiles.map(f => f.tempFilePath);
        this.setData({
          feedbackImages: [...this.data.feedbackImages, ...paths],
        });
      },
    });
  },

  onRemoveImage(e) {
    const idx = e.currentTarget.dataset.index;
    const images = [...this.data.feedbackImages];
    images.splice(idx, 1);
    this.setData({ feedbackImages: images });
  },

  async onSubmitFeedback() {
    const content = (this.data.feedbackText || "").trim();
    if (!content) {
      wx.showToast({ title: "请输入反馈内容", icon: "none" });
      return;
    }
    if (content.length > 500) {
      wx.showToast({ title: "反馈内容不能超过500字", icon: "none" });
      return;
    }

    this.setData({ feedbackSubmitting: true });
    wx.showLoading({ title: "提交中..." });

    try {
      // 先上传图片到云存储
      let imageFileIDs = [];
      if (this.data.feedbackImages.length > 0) {
        const uploadTasks = this.data.feedbackImages.map((path, i) =>
          wx.cloud.uploadFile({
            cloudPath: `feedback/${Date.now()}_${i}.jpg`,
            filePath: path,
          }).then(res => res.fileID).catch(() => null)
        );
        const results = await Promise.all(uploadTasks);
        imageFileIDs = results.filter(id => id !== null);
      }

      // 提交反馈
      const res = await api.submitFeedback({
        content,
        type: this.data.feedbackType,
        images: imageFileIDs,
      });

      wx.hideLoading();
      if (res.result && res.result.code === 0) {
        wx.showToast({ title: "感谢反馈！", icon: "success" });
        this.setData({
          showFeedback: false,
          feedbackType: "suggestion",
          feedbackContact: "",
          feedbackText: "",
          feedbackImages: [],
        });
      } else {
        const errDetail = res.result?.errCode ? ` [${res.result.errCode}]` : "";
        wx.showToast({ title: (res.result?.msg || "提交失败") + errDetail, icon: "none", duration: 3000 });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("提交反馈异常:", e);
      wx.showToast({ title: e.errMsg || "网络错误，请重试", icon: "none" });
    }
    this.setData({ feedbackSubmitting: false });
  },

  onShowVersion() {
    this.setData({
      appVersion: getApp().getVersion() || "1.0.0",
      versionLog: getApp().getChangelog() || [],
      showVersionLog: true,
    });
  },
  onCloseVersionLog() {
    this.setData({ showVersionLog: false });
  },
});
