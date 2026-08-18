const api = require("../../utils/api");

Page({
  data: {
    isLoggedIn: false, avatarUrl: "", nickName: "", openid: "",
    showFeedback: false, feedbackType: "suggestion", feedbackText: "", feedbackImages: [], feedbackSubmitting: false,
    theme: "red",
    // 网页版登录
    showWeb: false,
    // 数据迁移（迁移码）
    showMigrate: false,
    migrateCode: "",
    migrateLoading: false,
  },

  onShow() {
    // 从首页公告「去迁移数据」跳转而来：自动展开迁移面板
    const app = getApp();
    if (app.globalData._autoShowMigrate) {
      app.globalData._autoShowMigrate = false;
      if (!this.data.showMigrate) this.onMigrate();
    }
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true, avatarUrl: userInfo.avatarUrl || "", nickName: userInfo.nickName || "", openid: userInfo.openid || "" });
    }
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
  },

  // ==== 数据迁移（在新小程序输入迁移码同步数据） ====
  async onMigrate() {
    const next = !this.data.showMigrate;
    this.setData({ showMigrate: next });
    if (!next || this.data.migrateCode) return;
    this.fetchMigrateCode();
  },

  async fetchMigrateCode() {
    if (!this.data.isLoggedIn) { wx.showToast({ title: "登录后才能查看", icon: "none" }); return; }
    this.setData({ migrateLoading: true });
    try {
      const res = await api.getMigrationCode();
      const r = res.result || {};
      if (r.code === 0) {
        this.setData({ migrateCode: r.data.code });
      } else if (r.code === 404) {
        this.setData({ migrateCode: "" });
        wx.showToast({ title: "未找到你的迁移码", icon: "none" });
      } else {
        wx.showToast({ title: r.msg || "获取失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "网络异常", icon: "none" });
    }
    this.setData({ migrateLoading: false });
  },

  onCopyMigrateCode() {
    if (this.data.migrateCode) {
      wx.setClipboardData({ data: this.data.migrateCode, success: () => { wx.showToast({ title: "已复制", icon: "success" }); } });
    } else if (!this.data.migrateLoading) {
      // 迁移码为空时点击 → 触发获取（原逻辑直接 return，点了没反应）
      this.fetchMigrateCode();
    }
  },

  // ==== 网页版登录（复制账户ID） ====
  onWebLogin() { this.setData({ showWeb: !this.data.showWeb }); },
  onCopyOpenid() {
    if (!this.data.openid) { wx.showToast({ title: "登录后才能复制", icon: "none" }); return; }
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

  onLogout() {
    wx.showModal({
      title: "提示",
      content: "确定要退出登录吗？",
      success: (res) => {
        if (!res.confirm) return;
        // 标记显式退出（保留 loggedIn:false，首页据此不自动静默登录），并清除本地缓存避免串号
        wx.setStorageSync("userInfo", { loggedIn: false });
        wx.removeStorageSync("ledger_cache");
        wx.removeStorageSync("holding_groups_cache");
        wx.removeStorageSync("watchlist_cache");
        this.setData({ isLoggedIn: false, avatarUrl: "", nickName: "", openid: "", showWeb: false });
        wx.showToast({ title: "已退出", icon: "success" });
      },
    });
  },

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
});
