const api = require("../../utils/api");
const subscribe = require("../../utils/subscribe");

// 我的提醒管理页（产品规划·功能可用性）：提醒规则的汇总管理——
// 全局开关 / 单条启用（enabled 字段向后兼容：旧数据缺省视为启用）/ 删除，改动即时同步云端
Page({
  data: {
    theme: "red",
    globalOn: true,
    rules: [],
    loading: true,
    quota: 0,        // 推送额度：>0 提醒才能送到微信（一次性订阅，一次授权=一条）
    quotaLoaded: false,
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
    // 历史脏数据自愈：跌阈值存成正数的规则永远不会触发（旧版界面还把它显示成"不限"）
    let healed = false;
    Object.keys(settings).forEach((code) => {
      const r = settings[code] || {};
      if (typeof r.lower === "number" && r.lower > 0) { r.lower = -r.lower; healed = true; }
    });
    if (healed) {
      wx.setStorageSync("alertSettings", settings);
      this._syncCloud(settings);
    }
    // 推送额度（提醒只消耗 FUND 池，必须看 quotaNew——合计值含播报额度，
    // 只授权过播报的用户会看到"有额度"实际提醒全跳过，2026-10-06 审查）
    api.dailyBriefing({ action: "alertGet" })
      .then((r) => {
        const res = (r && r.result) || {};
        this.setData({ quota: res.quotaNew || 0, quotaLoaded: true });
        // 云端回来的 settings 已带 name（服务端按代码补过）→ 覆盖本地并刷新列表，
        // 之前这里只取了额度，返回的名字被丢掉了
        const cloud = res.data || {};
        const settings0 = wx.getStorageSync("alertSettings") || {};
        let changed = false;
        Object.keys(cloud).forEach((code) => {
          // 本地已不存在的规则（在途回包期间被用户删除）不再补名——否则"只有 name 无阈值"
          // 的残骸会被 _load 当规则展示，下次 _syncCloud 又同步回云端，删除等于白删
          if (!settings0[code]) return;
          const nm = cloud[code] && cloud[code].name;
          if (!nm) return;
          const cur = settings0[code] || {};
          if (cur.name !== nm) {
            settings0[code] = Object.assign({}, cur, { name: nm });
            changed = true;
          }
        });
        if (changed) {
          wx.setStorageSync("alertSettings", settings0);
          const nameOf = (code) => (settings0[code] && settings0[code].name) || "";
          const rules = this.data.rules
            .map((r) => (nameOf(r.fundCode) ? Object.assign({}, r, { fundName: nameOf(r.fundCode) }) : r))
            .sort((a, b) => (a.fundName > b.fundName ? 1 : -1));
          this.setData({ rules });
        }
      })
      .catch(() => this.setData({ quotaLoaded: true }));
    const globalOn = wx.getStorageSync("alertGlobalOn");
    // 基金名兜底顺序：规则里自带的名字（新规则会写）→ 首页持仓缓存 → 自选缓存 → 代码。
    // 早先只查持仓缓存，卖出/仅自选的基金会退化成裸代码（2026-10-22 反馈：规则里有些是代码有些是名称）
    const nameMap = {};
    const wlCache = wx.getStorageSync("watchlist_cache") || {};
    (wlCache.list || wlCache.watchlist || []).forEach((w) => {
      if (w && w.fundCode && w.fundName) nameMap[w.fundCode] = w.fundName;
    });
    const pc = wx.getStorageSync("portfolio_cache") || {};
    (pc.holdings || []).forEach((h) => { if (h && h.fundCode) nameMap[h.fundCode] = h.fundName; });
    let needBackfill = false;
    const rules = Object.keys(settings).map((code) => {
      const s = settings[code] || {};
      const name = s.name || nameMap[code] || "";
      if (!s.name && name) needBackfill = true; // 老规则补名，下次同步回云端
      return {
        fundCode: code,
        fundName: name || code,
        upperText: s.upper > 0 ? "+" + s.upper + "%" : "不限",
        lowerText: s.lower < 0 ? s.lower + "%" : "不限",
        peAlert: !!s.peAlert,
        enabled: s.enabled !== false, // 向后兼容：旧规则缺 enabled 视为启用
      };
    }).sort((a, b) => (a.fundName > b.fundName ? 1 : -1));
    if (needBackfill) {
      const healed = {};
      Object.keys(settings).forEach((code) => {
        const s = settings[code] || {};
        healed[code] = s.name ? s : { ...s, name: nameMap[code] || "" };
      });
      wx.setStorageSync("alertSettings", healed);
      this._syncCloud(healed);
    }
    this.setData({
      rules,
      // 初值与首页 data / 云端默认一致（false）；"" 表示从未设置过
      globalOn: globalOn !== "" && globalOn !== undefined ? !!globalOn : false,
      loading: false,
    });
    // 本地两处缓存都没有名字的（已卖出、仅自选过、历史测试规则）→ 去服务端按代码查一次
    // 查不到的（如 TEST01 这类测试规则）记一笔，避免每次进页面重复请求
    const tried = wx.getStorageSync("alert_name_tried") || {};
    const unknown = rules
      .filter(r => (!r.fundName || r.fundName === r.fundCode) && !tried[r.fundCode])
      .map(r => r.fundCode);
    if (unknown.length) this._resolveNames(unknown);
  },

  // 按基金代码补名字：searchFund 支持 6 位代码查询，命中后回写本地 + 云端，
  // 下次打开就是名字（2026-10-22 反馈：提醒规则里代码和名称混着显示）
  async _resolveNames(codes) {
    if (this._nameResolving) return;
    this._nameResolving = true;
    try {
      const found = {};
      await Promise.all((codes || []).filter(c => /^\d{6}$/.test(c)).map(async (code) => {
        try {
          const res = await api.searchFund(code);
          const list = (res && res.result && res.result.data) || [];
          const hit = list.find((x) => (x.fundCode || x.code) === code);
          if (hit && hit.fundName) found[code] = hit.fundName;
        } catch (e) { /* 单只失败不影响其它 */ }
      }));
      const keys = Object.keys(found);
      // 没查到的记入 tried，下次不再请求
      const tried = wx.getStorageSync("alert_name_tried") || {};
      (codes || []).forEach(c => { if (!found[c]) tried[c] = 1; });
      wx.setStorageSync("alert_name_tried", tried);
      if (!keys.length) return;
      const settings = wx.getStorageSync("alertSettings") || {};
      keys.forEach((code) => {
        settings[code] = Object.assign({}, settings[code] || {}, { name: found[code] });
      });
      wx.setStorageSync("alertSettings", settings);
      this._syncCloud(settings);
      const rules = this.data.rules
        .map((r) => (found[r.fundCode] ? Object.assign({}, r, { fundName: found[r.fundCode] }) : r))
        .sort((a, b) => (a.fundName > b.fundName ? 1 : -1));
      this.setData({ rules });
    } finally {
      this._nameResolving = false;
    }
  },

  _syncCloud(settings, globalOn) {
    const payload = {};
    if (settings) payload.settings = settings;
    if (typeof globalOn === "boolean") payload.globalOn = globalOn;
    api.dailyBriefing({ action: "alertSet", ...payload }).catch(() => {});
  },

  // 补充推送额度：微信一次性订阅，一次授权 = 一条可发送额度。
  // 每次点击都真的拉起授权；结果如实反馈（拒绝/失败不再假装成功）
  onTopUp() {
    if (this._topping) return;
    this._topping = true;
    subscribe.requestQuotaTopUp("alert_manage").then((r) => {
      this._topping = false;
      if (r && r.ok) {
        wx.showToast({ title: "已补充 " + (r.added || 1) + " 条额度", icon: "success" });
        setTimeout(() => this._load(), 600);
        return;
      }
      // 开发者工具无法授权（要求真机点击手势），把原始原因给出来，别让人猜
      wx.showModal({
        title: "没能补充额度",
        content: (r && r.errMsg ? r.errMsg + "\n\n" : "") + "微信一次性订阅只能在真机上点「允许」获取额度；模拟器/开发者工具里授权不生效。",
        showCancel: false,
        confirmText: "知道了",
      });
    });
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
