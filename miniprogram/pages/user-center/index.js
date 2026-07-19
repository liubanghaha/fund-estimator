const api = require("../../utils/api");

Page({
  data: {
    isLoggedIn: false, avatarUrl: "", nickName: "", openid: "",
    showFeedback: false, feedbackType: "suggestion", feedbackText: "", feedbackImages: [], feedbackSubmitting: false,
    theme: "red",
    // 数据迁移
    showMigrate: false, migrateLoading: false, migrateCode: "", migrateCounts: null, migrateError: "",
  },

  onShow() {
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true, avatarUrl: userInfo.avatarUrl || "", nickName: userInfo.nickName || "", openid: userInfo.openid || "" });
    }
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
  },

  // ==== 数据迁移到网页版 ====
  onMigrate() { this.setData({ showMigrate: !this.data.showMigrate, migrateError: "", migrateCode: "", migrateCounts: null }); },
  async onDoExport() {
    this.setData({ migrateLoading: true, migrateError: "", migrateCode: "", migrateCounts: null });
    try {
      const res = await api.exportData();
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        this.setData({ migrateLoading: false, migrateCode: d.code, migrateCounts: d.counts });
      } else {
        this.setData({ migrateLoading: false, migrateError: (res.result && res.result.msg) || "导出失败" });
      }
    } catch (e) {
      this.setData({ migrateLoading: false, migrateError: "网络错误，请重试" });
    }
  },
  onCopyCode() {
    if (!this.data.migrateCode) return;
    wx.setClipboardData({ data: this.data.migrateCode, success: () => { wx.showToast({ title: "已复制", icon: "success" }); } });
  },
  onCopyOpenid() {
    if (!this.data.openid) return;
    wx.setClipboardData({ data: this.data.openid, success: () => { wx.showToast({ title: "已复制", icon: "success" }); } });
  },

  onToggleTheme() {
    const next = this.data.theme === "red" ? "blue" : "red";
    this.setData({ theme: next });
    wx.setStorageSync("theme", next);
    const pages = getCurrentPages();
    pages.forEach(p => { if (p.setData) p.setData({ theme: next }); });
  },

  // ==== 反馈 ====
  onFeedback() { this.setData({ showFeedback: !this.data.showFeedback }); },
  onTypeTap(e) { this.setData({ feedbackType: e.currentTarget.dataset.type }); },
  onFeedbackInput(e) { this.setData({ feedbackText: e.detail.value }); },
  onAddImage() {
    if (this.data.feedbackImages.length >= 3) { wx.showToast({ title: "最多3张", icon: "none" }); return; }
    wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: (res) => {
      this.setData({ feedbackImages: this.data.feedbackImages.concat([res.tempFiles[0].tempFilePath]) });
    }});
  },
  onRemoveImage(e) { const imgs = this.data.feedbackImages.concat(); imgs.splice(e.currentTarget.dataset.index, 1); this.setData({ feedbackImages: imgs }); },
  async onSubmitFeedback() {
    if (!this.data.feedbackText.trim()) { wx.showToast({ title: "请输入内容", icon: "none" }); return; }
    this.setData({ feedbackSubmitting: true });
    try {
      let urls = [];
      for (const p of this.data.feedbackImages) { const r = await wx.cloud.uploadFile({ cloudPath: `feedback/${Date.now()}.jpg`, filePath: p }); urls.push(r.fileID); }
      await api.submitFeedback({ content: this.data.feedbackText, type: this.data.feedbackType, images: urls });
      wx.showToast({ title: "感谢反馈！", icon: "success" });
      this.setData({ showFeedback: false, feedbackText: "", feedbackImages: [], feedbackSubmitting: false });
    } catch (e) { wx.showToast({ title: "提交失败", icon: "none" }); this.setData({ feedbackSubmitting: false }); }
  },

  onShowVersion() { wx.showModal({ title: "理财笔记", content: "记录你的每一笔投资", showCancel: false }); },

  onLogin() {},
});
