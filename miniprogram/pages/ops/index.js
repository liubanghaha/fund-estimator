const api = require("../../utils/api");

Page({
  data: {
    checking: true,
    isAdmin: false,
    tab: "briefing", // briefing | channels
    // 温度简报
    briefing: null,
    briefingLoading: false,
    // 渠道码
    channels: [],
    channelName: "",
    addingChannel: false,
    generatingCode: "", // 正在生成码的 channelId
    // 埋点周报
    trackDaysIdx: 0,
    trackDays: 7,
    trackLoading: false,
    trackReport: null,
  },

  onShow() {
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    this._checkAdmin();
  },

  async _checkAdmin() {
    try {
      const res = await api.opsTool("registerAdmin");
      const d = res.result && res.result.data;
      const isAdmin = !!(d && d.isAdmin);
      this.setData({ isAdmin, checking: false });
      if (d && d.registered) {
        wx.showToast({ title: "已登记为运营管理员", icon: "none" });
      }
      if (isAdmin) this._loadChannels();
    } catch (e) {
      this.setData({ checking: false });
    }
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  // ===== 温度简报 =====
  async onGenBriefing() {
    this.setData({ briefingLoading: true });
    try {
      const res = await api.opsTool("briefing");
      if (res.result && res.result.code === 0) {
        this.setData({ briefing: res.result.data });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "生成失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "生成失败", icon: "none" });
    } finally {
      this.setData({ briefingLoading: false });
    }
  },

  onCopyBriefing() {
    const copy = this.data.briefing && this.data.briefing.copy;
    if (!copy) return;
    wx.setClipboardData({
      data: copy,
      success: () => wx.showToast({ title: "已复制，去发朋友圈吧", icon: "success" }),
    });
  },

  // ===== 埋点周报 =====
  onTrackDaysChange(e) {
    const idx = +e.detail.value;
    this.setData({ trackDaysIdx: idx, trackDays: [7, 14, 30, 90][idx] || 7, trackReport: null });
  },

  async onGenTrackReport() {
    this.setData({ trackLoading: true });
    try {
      const res = await api.opsTool("trackReport", { days: this.data.trackDays });
      if (res.result && res.result.code === 0) {
        this.setData({ trackReport: res.result.data });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "生成失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "生成失败", icon: "none" });
    } finally {
      this.setData({ trackLoading: false });
    }
  },

  // ===== 渠道管理 =====
  onChannelInput(e) {
    this.setData({ channelName: e.detail.value });
  },

  async onAddChannel() {
    const name = this.data.channelName.trim();
    if (!name) {
      wx.showToast({ title: "请输入渠道名称", icon: "none" });
      return;
    }
    this.setData({ addingChannel: true });
    try {
      const res = await api.opsTool("addChannel", { name });
      if (res.result && res.result.code === 0) {
        this.setData({ channelName: "" });
        this._loadChannels();
      }
    } finally {
      this.setData({ addingChannel: false });
    }
  },

  async _loadChannels() {
    try {
      const res = await api.opsTool("listChannels");
      if (res.result && res.result.code === 0) {
        this.setData({ channels: res.result.data.channels || [] });
      }
    } catch (e) { /* ignore */ }
  },

  async onGenerateCode(e) {
    const channelId = e.currentTarget.dataset.channelId;
    this.setData({ generatingCode: channelId });
    try {
      const res = await api.opsTool("createCode", { channelId });
      if (res.result && res.result.code === 0) {
        const fileID = res.result.data.fileID;
        const urls = await wx.cloud.getTempFileURL({ fileList: [fileID] });
        const url = urls.fileList && urls.fileList[0] && urls.fileList[0].tempFileURL;
        this.setData({ ["codeUrl_" + channelId]: url });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "生成失败", icon: "none" });
      }
    } catch (err) {
      wx.showToast({ title: "生成失败", icon: "none" });
    } finally {
      this.setData({ generatingCode: "" });
    }
  },

  async onRemoveChannel(e) {
    const channelId = e.currentTarget.dataset.channelId;
    const r = await new Promise((resolve) => {
      wx.showModal({ title: "删除渠道", content: "确定删除该渠道？相关访问统计也会清空。", success: resolve });
    });
    if (!r.confirm) return;
    try {
      await api.opsTool("removeChannel", { channelId });
      this._loadChannels();
    } catch (err) { /* ignore */ }
  },
});
