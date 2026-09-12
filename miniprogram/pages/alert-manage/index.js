const api = require("../../utils/api");

// 我的提醒管理页（产品规划·功能可用性）：提醒规则的汇总管理——
// 全局开关 / 单条启用（enabled 字段向后兼容：旧数据缺省视为启用）/ 删除，改动即时同步云端
Page({
  data: {
    theme: "red",
    globalOn: true,
    rules: [],
    loading: true,
  },

  onLoad() {
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
  },
  onShow() {
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
    this._load();
  },

  _load() {
    const settings = wx.getStorageSync("alertSettings") || {};
    const globalOn = wx.getStorageSync("alertGlobalOn");
    // 基金名优先取首页持仓缓存（alertSettings 里只有 fundCode）
    const pc = wx.getStorageSync("portfolio_cache") || {};
    const nameMap = {};
    (pc.holdings || []).forEach((h) => { nameMap[h.fundCode] = h.fundName; });
    const rules = Object.keys(settings).map((code) => {
      const s = settings[code] || {};
      return {
        fundCode: code,
        fundName: nameMap[code] || code,
        upperText: s.upper > 0 ? "+" + s.upper + "%" : "不限",
        lowerText: s.lower < 0 ? s.lower + "%" : "不限",
        peAlert: !!s.peAlert,
        enabled: s.enabled !== false, // 向后兼容：旧规则缺 enabled 视为启用
      };
    }).sort((a, b) => (a.fundName > b.fundName ? 1 : -1));
    this.setData({
      rules,
      globalOn: globalOn !== "" && globalOn !== undefined ? !!globalOn : true,
      loading: false,
    });
  },

  _syncCloud(settings, globalOn) {
    const payload = {};
    if (settings) payload.settings = settings;
    if (typeof globalOn === "boolean") payload.globalOn = globalOn;
    wx.cloud.callFunction({ name: "dailyBriefing", data: { action: "alertSet", ...payload } }).catch(() => {});
  },

  onToggleGlobal(e) {
    const globalOn = !!e.detail.value;
    this.setData({ globalOn });
    wx.setStorageSync("alertGlobalOn", globalOn);
    this._syncCloud(null, globalOn);
  },

  onToggleRule(e) {
    const code = e.currentTarget.dataset.code;
    const settings = wx.getStorageSync("alertSettings") || {};
    if (!settings[code]) return;
    settings[code].enabled = !(settings[code].enabled !== false); // 缺省启用 → 切换后写明状态
    wx.setStorageSync("alertSettings", settings);
    if (settings[code].enabled === false) {
      // 关用的 PE 提醒顺手清基线，避免重开时拿旧基线误报
      const cache = wx.getStorageSync("peSignalCache") || {};
      delete cache[code];
      wx.setStorageSync("peSignalCache", cache);
    }
    this._load();
    this._syncCloud(settings);
  },

  onDeleteRule(e) {
    const code = e.currentTarget.dataset.code;
    const settings = wx.getStorageSync("alertSettings") || {};
    if (!settings[code]) return;
    wx.showModal({
      title: "删除提醒",
      content: "确定删除该基金的提醒规则？",
      success: (res) => {
        if (!res.confirm) return;
        delete settings[code];
        wx.setStorageSync("alertSettings", settings);
        const cache = wx.getStorageSync("peSignalCache") || {};
        delete cache[code];
        wx.setStorageSync("peSignalCache", cache);
        this._load();
        this._syncCloud(settings);
        wx.showToast({ title: "已删除", icon: "none" });
      },
    });
  },

  onGoHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },
});
