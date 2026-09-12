const api = require("../../utils/api");
const subscribe = require("../../utils/subscribe");
const ADMIN_CACHE_KEY = "ops_admin_cache"; // 管理员标记缓存：true 缓存 7 天 / false 缓存 1 天

Page({
  data: {
    isLoggedIn: false, avatarUrl: "", nickName: "",
    showBrief: false, briefAuthed: false, briefSubmitting: false,
    showFeedback: false,
    feedbackType: "suggestion",
    feedbackText: "",
    feedbackImages: [],
    feedbackSubmitting: false,
    // 实时估值数据源：数据源一=新浪实时估值（默认）| 数据源二=自算估值
    estimateSrcText: "数据源一",
    // 数据迁移（旧版本用户认领数据）
    showMigrate: false,
    migrateCode: "",
    migrating: false,
    isOpsAdmin: false,
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
    this.setData({
      theme,
      briefAuthed: subscribe.hasAuthed(),
      estimateSrcText: api.estimateSrc() === "self" ? "数据源二" : "数据源一",
    });
    // 运营助手入口（仅管理员可见；页面本身另有管理员门禁）
    this._checkOpsAdmin();
  },

  // checkAdmin 结果缓存：命中不发请求，避免每次 onShow 都打云函数
  _checkOpsAdmin() {
    try {
      const cached = wx.getStorageSync(ADMIN_CACHE_KEY);
      const ttl = cached && cached.isAdmin ? 7 * 24 * 3600000 : 24 * 3600000;
      if (cached && cached.ts && Date.now() - cached.ts < ttl) {
        this.setData({ isOpsAdmin: !!cached.isAdmin });
        return;
      }
    } catch (e) { /* ignore */ }
    api.opsTool("checkAdmin").then((res) => {
      const isOpsAdmin = !!(res.result && res.result.data && res.result.data.isAdmin);
      try { wx.setStorageSync(ADMIN_CACHE_KEY, { isAdmin: isOpsAdmin, ts: Date.now() }); } catch (e) { /* ignore */ }
      this.setData({ isOpsAdmin });
    }).catch(() => {});
  },

  onOpenOps() {
    wx.navigateTo({ url: "/pages/ops/index" });
  },

  // 实时估值数据源切换：数据源一=新浪实时估值（独立第三方估算，推荐）；
  // 数据源二=自主估算（跟踪指数/持仓股加权）。改变立即对详情页/走势/加减仓生效。
  onEstimateSrc() {
    wx.showActionSheet({
      itemList: ["数据源一", "数据源二"],
      success: (res) => {
        const key = res.tapIndex === 1 ? "self" : "sina";
        wx.setStorageSync("estimate_src", key);
        this.setData({ estimateSrcText: key === "self" ? "数据源二" : "数据源一" });
        wx.showToast({ title: key === "self" ? "已切换为数据源二" : "已切换为数据源一", icon: "none" });
        // 云端同步加 500ms 去抖：快速连切时只发最后一次选择，避免异步乱序导致云端 src 落到旧值
        if (this._alertSrcTimer) clearTimeout(this._alertSrcTimer);
        this._alertSrcTimer = setTimeout(() => {
          wx.cloud.callFunction({ name: "dailyBriefing", data: { action: "alertSrc", src: key } }).catch(() => {});
        }, 500);
        // 首页/详情缓存按旧源口径算过，切源后强制失效，下次打开用新源重拉
        try {
          wx.removeStorageSync("portfolio_cache");
          wx.setStorageSync("portfolio_force_refresh", true);
        } catch (e) { /* ignore */ }
      },
      fail: () => {},
    });
  },

  onBriefing() {
    this.setData({ showBrief: !this.data.showBrief });
  },

  async onBriefingAuth() {
    this.setData({ briefSubmitting: true });
    const r = await subscribe.requestAuth("user_center");
    this.setData({ briefSubmitting: false, briefAuthed: subscribe.hasAuthed() });
    if (r.ok) wx.showToast({ title: "已订阅收盘播报", icon: "none", duration: 2000 });
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
    wx.showToast({ title: "主题已切换", icon: "none", duration: 2000 });
  },

  // 头部「点击登录」：未登录时触发登录；已登录点击无动作
  onNicknameTap() {
    if (!this.data.isLoggedIn) this.onLogin();
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
          wx.removeStorageSync("estimate_src");
          wx.removeStorageSync("holding_groups_cache");
          wx.removeStorageSync("news_cache");
          wx.removeStorageSync("track_queue_v1");
          wx.removeStorageSync("ops_admin_cache");
          const app = getApp();
          if (app && app.globalData) {
            app.globalData._ocrFunds = null;
            app.globalData._screenshotPath = null;
          }
          this.setData({ isLoggedIn: false, avatarUrl: "", nickName: "", isOpsAdmin: false });
        }
      },
    });
  },

  onSearchFund() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAddHolding() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  // ========== 数据迁移（输入迁移码认领旧数据） ==========

  onMigrate() {
    if (this.data.showMigrate) {
      this.setData({ showMigrate: false, migrateCode: "" });
    } else {
      this.setData({ showMigrate: true });
    }
  },

  onMigrateInput(e) {
    this.setData({ migrateCode: e.detail.value });
  },

  async onSubmitMigrate() {
    const code = (this.data.migrateCode || "").trim();
    if (!code) { wx.showToast({ title: "请输入迁移码", icon: "none" }); return; }
    if (!this.data.isLoggedIn) { wx.showToast({ title: "请先登录", icon: "none" }); return; }
    this.setData({ migrating: true });
    try {
      const res = await api.bindMigrationCode(code);
      const r = res.result || {};
      if (r.code === 0) {
        wx.showToast({ title: "迁移成功！", icon: "success" });
        wx.setStorageSync("migrated", true);
        this.setData({ showMigrate: false, migrateCode: "", migrating: false });
      } else {
        wx.showToast({ title: r.msg || "迁移失败", icon: "none" });
        this.setData({ migrating: false });
      }
    } catch (e) {
      wx.showToast({ title: "网络异常，请重试", icon: "none" });
      this.setData({ migrating: false });
    }
  },

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
        const errDetail = (res.result && res.result.errCode) ? ` [${res.result.errCode}]` : "";
        wx.showToast({ title: ((res.result && res.result.msg) || "提交失败") + errDetail, icon: "none", duration: 3000 });
      }
    } catch (e) {
      wx.hideLoading();
      console.error("提交反馈异常:", e);
      wx.showToast({ title: e.errMsg || "网络错误，请重试", icon: "none" });
    }
    this.setData({ feedbackSubmitting: false });
  },

  onShowVersion() {
    const log = getApp().getChangelog() || [];
    this.setData({
      appVersion: getApp().getVersion() || "1.0.0",
      versionLog: log.length ? [log[0]] : [],
      showVersionLog: true,
    });
  },
  onCloseVersionLog() {
    this.setData({ showVersionLog: false });
  },
});
