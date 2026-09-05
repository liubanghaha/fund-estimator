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
    // 推送灰度看板
    pushDaysIdx: 0,
    pushDays: 7,
    pushLoading: false,
    pushReport: null,
    // 老用户召回
    recallBucketIdx: 0,
    recallBuckets: ["7d", "14d", "30d"],
    recallPreview: null,
    recallSending: false,
    recallReport: null,
    recallReportLoading: false,
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

  // ===== 推送灰度看板 =====
  onPushDaysChange(e) {
    const idx = +e.detail.value;
    this.setData({ pushDaysIdx: idx, pushDays: [7, 14, 30, 90][idx] || 7, pushReport: null });
  },

  async onGenPushReport() {
    this.setData({ pushLoading: true });
    try {
      const res = await api.opsTool("pushReport", { days: this.data.pushDays });
      if (res.result && res.result.code === 0) {
        this.setData({ pushReport: res.result.data });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "生成失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "生成失败", icon: "none" });
    } finally {
      this.setData({ pushLoading: false });
    }
  },

  // ===== 老用户召回 =====
  onRecallBucketChange(e) {
    const idx = +e.detail.value;
    this.setData({ recallBucketIdx: idx, recallPreview: null });
  },

  // 预览目标（dryRun：不落库不发送）
  async onRecallPreview() {
    this.setData({ recallSending: true });
    try {
      const res = await api.opsTool("recallSend", { bucket: this.data.recallBuckets[this.data.recallBucketIdx], limit: 100, dryRun: true });
      if (res.result && res.result.code === 0) {
        this.setData({ recallPreview: res.result.data });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "预览失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "预览失败", icon: "none" });
    } finally {
      this.setData({ recallSending: false });
    }
  },

  // 试水发送：确认弹窗 → 真发（发送组一半，对照组不发只记录）
  async onRecallSend() {
    const r = await new Promise((resolve) => {
      wx.showModal({
        title: "确认发送召回",
        content: "将向发送组用户真实发送推送并消耗其推送额度（对照组仅记录不发送）。额度与收盘小结共用，务必避开 15:30/21:30 前后。确定发送？",
        success: (res) => resolve(res.confirm),
      });
    });
    if (!r) return;
    this.setData({ recallSending: true });
    try {
      const res = await api.opsTool("recallSend", { bucket: this.data.recallBuckets[this.data.recallBucketIdx], limit: 100, dryRun: false });
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        this.setData({ recallPreview: null });
        wx.showModal({
          title: "发送完成",
          content: `发送 ${d.sent || 0} 成功 / ${d.failed || 0} 失败（对照组 ${d.controlCount} 人已记录）。7 日后可生成对照报表。`,
          showCancel: false,
        });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "发送失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "发送失败", icon: "none" });
    } finally {
      this.setData({ recallSending: false });
    }
  },

  async onRecallReport() {
    this.setData({ recallReportLoading: true });
    try {
      const res = await api.opsTool("recallReport");
      if (res.result && res.result.code === 0) {
        const list = (res.result.data && res.result.data.batches) || [];
        // batchTs 转北京时间串（WXML 不做时间运算）
        list.forEach((b) => {
          b.dateStr = new Date(b.batchTs + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ");
        });
        this.setData({ recallReport: list });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "生成失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "生成失败", icon: "none" });
    } finally {
      this.setData({ recallReportLoading: false });
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
