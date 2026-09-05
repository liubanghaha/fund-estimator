const api = require("../../utils/api");
const marketTime = require("../../utils/market-time");
const subscribe = require("../../utils/subscribe");
const track = require("../../utils/track");

const ALL_INDICES = [
  { code: "000001", name: "上证指数" },
  { code: "399001", name: "深证成指" },
  { code: "399006", name: "创业板指" },
  { code: "000300", name: "沪深300" },
  { code: "HSTECH", name: "恒生科技" },
  { code: "HSI", name: "恒生指数" },
  { code: "SPX", name: "标普500" },
  { code: "IXIC", name: "纳斯达克" },
];

const CACHE_KEY = "portfolio_cache";
const INDEX_CACHE_KEY = "index_cache";
const GROUPS_CACHE_KEY = "holding_groups_cache";

Page({
  data: {
    isLoggedIn: false,
    loading: false,
    dataReady: false,
    holdings: [],
    displayHoldings: [],
    amountVisible: true,
    totalAmount: "0.00",
    todayProfit: "0.00",
    todayProfitRate: "0.00",
    totalReturn: "0.00",
    totalReturnRate: "0.00",
    updateTime: "",
    indexCards: ALL_INDICES.slice(0, 6).map((idx) => ({
      name: idx.name, code: idx.code,
      price: "--", change: "--", changeRate: "--", isUp: true,
    })),
    indexExpanded: false,
    indexLoading: false,
    showIndexEdit: false,
    ALL_INDICES,
    activeIndices: ALL_INDICES.slice(0, 6),
    editSelections: {},
    pageHeight: 0,
    indexBarHeight: 110,
    refresherTriggered: false,
    fromCache: false,
    allUpdated: false,
    sortField: "todayProfit",
    sortOrder: "desc",
    batchMode: false,
    alertGlobalOn: false,
    selectedCount: 0,
    allSelected: false,
    loadError: false,
    showTempInfo: false,
    lt: '<',
    gt: '>',
    assetAllocation: null,
    showAssetAlloc: false,
    showColEdit: false,
    colOrder: wx.getStorageSync("colOrder") || ["todayProfit", "totalReturn", "ratio", "drawdown", "valuation"],
    colDefs: {
      todayProfit: { label: "当日收益", sortable: true },
      totalReturn: { label: "累计收益", sortable: true },
      ratio: { label: "占比", sortable: true },
      drawdown: { label: "距高点", sortable: true },
      valuation: { label: "估算", sortable: false, isValuation: true },
    },
    alertTriggered: [], showAlertEdit: false,
    alertEditFundCode: '', alertEditFundName: '', alertEditUpper: '', alertEditLower: '',
    alertEditPeAlert: false,
    // 分组
    groups: [],
    activeGroup: "all",
    groupCounts: {},
    groupSummary: null,
    allGroupsData: [],
    // 分组拖拽
    dragging: false,
    dragIndex: -1,
    dragX: 0,
    _dragStartX: 0,
    _dragStartIdx: -1,
    _dragTimer: null,
    _didLongPress: false,
    _dragMoved: false,
    _tabWidth: 0,
    showGroupEdit: false,
    groupEditFundCode: '',
    groupEditFundName: '',
    showGroupPicker: false,
    groupPickerCodes: [],
    // 分享卡片
    showShareCard: false,
    shareCardRendered: false,
    // 分享落地横幅 + 渠道来源
    shareCard: null,
    entryChannel: "",
  },

  onPageScroll() {},

  // 启用分享到好友和朋友圈
  onShareAppMessage() {
    // 分享令牌预生成（数据就绪后 _refreshShareToken 已缓存），带参数实现「点开看到分享者卡片」引流
    const token = wx.getStorageSync("share_token");
    const hasHolding = this.data.holdings && this.data.holdings.length > 0;
    const p = parseFloat(this.data.todayProfit);
    let title = "韭菜估值宝 · 涨跌有数";
    if (token && hasHolding && p !== 0) {
      title = `我今日收益 ${p > 0 ? "+" : ""}${p.toFixed(2)} 元，你的基金温度多少？`;
    }
    // 分享确认埋点：onShareAppMessage 触发即用户已确认转发；带 token 与否是渠道归因的关键分叉
    track.share({ sharePage: "index", hasToken: !!(token && hasHolding), hasProfit: p !== 0 });
    return {
      title,
      path: token && hasHolding ? `/pages/index/index?share=${token}` : "/pages/index/index",
      imageUrl: "",
    };
  },

  onShareTimeline() {
    return {
      title: '韭菜估值宝 · 持仓收益一目了然',
      imageUrl: '',
    };
  },

  onLoad(options) {
    // 列清洗与迁移：过滤 colDefs 已不存在的残留 key（防表头渲染 undefined），新列追加到尾部
    try {
      const saved = wx.getStorageSync("colOrder");
      if (saved && saved.length) {
        const keys = Object.keys(this.data.colDefs);
        const cleaned = saved.filter(k => keys.indexOf(k) !== -1);
        const missing = keys.filter(k => cleaned.indexOf(k) === -1);
        const merged = [...cleaned, ...missing];
        if (merged.join(',') !== saved.join(',')) {
          this.setData({ colOrder: merged });
          wx.setStorageSync("colOrder", merged);
        }
      }
    } catch (e) { /* ignore */ }
    const { windowHeight, windowWidth } = wx.getSystemInfoSync();
    this._windowWidth = windowWidth;
    this.setData({ pageHeight: windowHeight });
    // 截屏时引导用分享卡片（含小程序码，可导流）
    wx.onUserCaptureScreen &&
      wx.onUserCaptureScreen(() => {
        wx.showToast({
          title: "截图分享不带小程序码，长按右上角「分享」生成收益卡片",
          icon: "none",
          duration: 2500,
        });
      });
    // 分享落地 / 渠道扫码追踪
    this._handleEntry(options || {});
  },

  // 处理进入参数：渠道码 scene 上报 + 分享令牌拉取分享者卡片
  _handleEntry(options) {
    // 渠道小程序码（scene = c_渠道ID）
    if (options.scene) {
      let ch = "";
      try {
        const decoded = decodeURIComponent(options.scene);
        if (decoded.indexOf("c_") === 0) ch = decoded.slice(2);
      } catch (e) { /* ignore */ }
      if (ch) {
        this.setData({ entryChannel: ch });
        api.opsShare("trackVisit", { channelId: ch }).catch(() => {});
        // 渠道落地埋点：服务端 trackVisit 计数保留，此条补客户端上下文（时段/会话/场景值）
        track.shareLanding({ src: "promo_channel", channelId: ch });
      }
    }
    // 分享转发落地（path 带 share=令牌）
    if (options.share) {
      const shareToken = String(options.share).slice(0, 32);
      this._loadShareCard(shareToken);
      // 分享卡落地（漏斗第一环）：到达口径，卡片加载结果异步补埋 err=card_fail
      track.shareLanding({ src: "share_token", token: shareToken });
    }
    // 推送落地追踪已上移 app.js（收益页/详情页落地也能追踪），此处仅保留首页直落场景
    if (options.src === "push" && options.lid) {
      subscribe.bindTrackOpen(options.lid);
    }
  },

  async _loadShareCard(token) {
    try {
      const res = await api.opsShare("getCard", { token });
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        this.setData({
          shareCard: {
            nickName: d.nickName || "朋友",
            todayProfit: d.todayProfit,
            todayProfitRate: d.todayProfitRate,
            totalReturn: d.totalReturn,
            totalReturnRate: d.totalReturnRate,
            fundCount: d.fundCount,
            fundNames: d.fundNames || [],
          },
        });
      } else {
        // 令牌失效等业务失败：横幅不出现，漏斗上必流失，单独标记供失败率统计
        track.shareLanding({ src: "share_token", token, err: "card_fail" });
      }
    } catch (e) {
      track.shareLanding({ src: "share_token", token, err: "card_fail" }); // 链接失效/网络异常
    }
  },

  onCloseShareLanding() {
    this.setData({ shareCard: null });
  },

  // 分享落地引导：未登录先登录，已登录去搜索页添加持仓
  onAddMyHolding() {
    // 落地转化（漏斗第二环）：isLoggedIn 区分"去登录"与"去搜索"两条转化路径
    track.landingConvert({ cta: "add_holding", isLoggedIn: !!this.data.isLoggedIn });
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: "/pages/login/index" });
      return;
    }
    wx.navigateTo({ url: "/pages/search/index" });
  },

  // 数据就绪后预生成分享令牌（数据没变化不重复生成；登出/换号时清除，避免串号）
  _refreshShareToken() {
    if (!this.data.isLoggedIn) {
      wx.removeStorageSync("share_token");
      wx.removeStorageSync("share_token_data");
      return;
    }
    const holdings = this.data.holdings;
    if (!holdings || holdings.length === 0) return;
    const userInfo = wx.getStorageSync("userInfo");
    const openid = (userInfo && userInfo.openid) || "";
    const sig = [this.data.todayProfit, this.data.todayProfitRate, this.data.totalReturn, this.data.totalReturnRate, holdings.length].join("|");
    const cached = wx.getStorageSync("share_token_data");
    if (cached && cached.openid === openid && cached.sig === sig && cached.expireAt > Date.now()) return;
    api.opsShare("createToken", {
      todayProfit: this.data.todayProfit,
      todayProfitRate: this.data.todayProfitRate,
      totalReturn: this.data.totalReturn,
      totalReturnRate: this.data.totalReturnRate,
      fundCount: holdings.length,
      fundNames: holdings.slice(0, 20).map((h) => ({ code: h.fundCode, name: h.fundName })),
      nickName: (userInfo && userInfo.nickName) || "",
    }).then((res) => {
      if (res.result && res.result.code === 0) {
        wx.setStorageSync("share_token", res.result.data.token);
        wx.setStorageSync("share_token_data", { openid, sig, expireAt: Date.now() + 7 * 24 * 3600 * 1000 });
      }
    }).catch(() => {});
  },

  // 首次渲染完成后自动刷新（静默后台拉取，缓存已渲染，不拉起下拉动画）
  onReady() {
    this._ready = true;
    if (this._pendingAutoRefresh) {
      this._pendingAutoRefresh = false;
      // 延迟等页面完全就绪（onLoad 时机页面未就绪）
      setTimeout(() => this._silentRefresh(), 500);
    }
  },

  onShow() {
    // 每次显示同步主题色（tab 切换/返回时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    this._syncAlertSettingsDaily();
    this._maybeShowUpdateLog();
    const now = Date.now();
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });

    // 恢复缓存的分组列表
    const cachedGroups = this._getCachedGroups();
    if (cachedGroups.length && !this.data.groups.length) {
      this.setData({ groups: cachedGroups });
    }

    const savedCodes = wx.getStorageSync("indexCodes");
    let activeIndices = ALL_INDICES.slice(0, 6);
    if (savedCodes && savedCodes.length > 0) {
      const filtered = ALL_INDICES.filter((idx) => savedCodes.indexOf(idx.code) !== -1);
      if (filtered.length > 0) activeIndices = filtered;
    }
    // 值没变时不重复 setData（避免 onShow 频繁触发整页重渲染）
    const curCodes = (this.data.activeIndices || []).map(i => i.code).join(",");
    const nextCodes = activeIndices.map(i => i.code).join(",");
    if (curCodes !== nextCodes) {
      this.setData({ activeIndices });
    }
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.applyCache();
      const indexCached = this.applyIndexCache();
      // 缓存 TTL 检查：60s 内直接复用缓存，超时后台刷新
      const forceRefresh = wx.getStorageSync("portfolio_force_refresh");
      if (forceRefresh) {
        wx.removeStorageSync("portfolio_force_refresh");
        this._lastFetch = 0;
      }
      // 交易日时钟判缓存新鲜度：盘中 30s 短 TTL；盘后净值发布(actualDate=今天)即冻结；
      // 周末/节假日/早盘全天免拉（数据只在交易日变化）
      const portfolioFresh = marketTime.isCacheFresh(this._portfolioCache, { estimateTtl: 30000 });
      const needFetch = this._lastFetch
        ? (now - this._lastFetch > 30000 || !portfolioFresh)
        : !portfolioFresh;
      if (needFetch) {
        this._lastFetch = now;
        // 页面已就绪 → 静默后台刷新（缓存已渲染，不再拉起下拉动画，避免打开页面长时间转圈）
        if (this._ready) {
          this._silentRefresh();
        } else {
          // 首次进入：标记待 onReady 后再刷新（onLoad 时机页面未就绪）
          this._pendingAutoRefresh = true;
        }
      }
      if (!indexCached) this.fetchIndices();
    } else {
      this.setData({ isLoggedIn: false, holdings: [], displayHoldings: [], dataReady: true });
      this.applyIndexCache();
      this.fetchIndices();
      wx.removeStorageSync("portfolio_cache");
      wx.removeStorageSync("profit_detail_cache");
    }
  },

  applyCache() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.holdings && cached.holdings.length > 0) {
        this._cacheTs = cached.ts || 0;
        this._portfolioCache = cached;
        let holdings = cached.holdings;
        holdings = this.formatHoldings(holdings, cached.totalAmount);
        holdings = this.sortHoldings(holdings);
        const allUpdated = holdings.length > 0 && holdings.every(h => h.estimateUpdated);
        // 与 fetchPortfolio 一致的合并渲染：displayHoldings/counts/groups 一次算好
        const { activeGroup, sortField, sortOrder } = this.data;
        let displayHoldings;
        if (activeGroup === "all") displayHoldings = [...holdings];
        else if (activeGroup === "ungrouped") displayHoldings = holdings.filter(h => !h.group);
        else displayHoldings = holdings.filter(h => h.group === activeGroup);
        displayHoldings = this.sortHoldings(displayHoldings, sortField, sortOrder);
        const counts = { all: holdings.length, ungrouped: 0 };
        for (const h of holdings) {
          if (!h.group) counts.ungrouped++;
          else counts[h.group] = (counts[h.group] || 0) + 1;
        }
        // groups（标签渲染）需字符串数组：_mergeGroups 已兼容对象数组（取 name）
        const groups = this._mergeGroups(cached.groups || []);
        const groupSummary = this._computeGroupSummary(activeGroup, cached.groups || []);
        this.setData({
          holdings, displayHoldings, groupCounts: counts, groups, groupSummary,
          totalAmount: cached.totalAmount,
          todayProfit: cached.todayProfit,
          todayProfitRate: cached.todayProfitRate,
          totalReturn: cached.totalReturn,
          totalReturnRate: cached.totalReturnRate,
          updateTime: cached.updateTime || "",
          assetAllocation: cached.assetAllocation || null,
          healthScore: cached.healthScore || null,
          fromCache: true,
          allUpdated,
          allGroupsData: cached.groups || [],
          dataReady: true,
        });
        this._refreshShareToken();
      }
    } catch (e) { /* ignore cache read error */ }
  },

  applyIndexCache() {
    try {
      const cached = wx.getStorageSync(INDEX_CACHE_KEY);
      const codes = this.data.activeIndices.map((i) => i.code).join(",");
      if (cached && cached.codes === codes && cached.cards && cached.cards.length > 0) {
        // 指数行情 15:00 收盘即定格：有缓存先渲染，收盘后写入的直接免拉
        this.setData({ indexCards: cached.cards }, () => this._measureIndexBar());
        return marketTime.isCacheFresh(cached, { estimateTtl: 30000, finalAtClose: true });
      }
    } catch (e) { /* ignore */ }
    // 无缓存时展示占位，让指数栏立即可见
    const placeholders = this.data.activeIndices.map((idx) => ({
      name: idx.name, code: idx.code,
      price: "--", change: "--", changeRate: "--", isUp: true,
    }));
    this.setData({ indexCards: placeholders }, () => this._measureIndexBar());
    return false;
  },

  onToggleAmount() {
    const v = !this.data.amountVisible;
    this.setData({ amountVisible: v });
    wx.setStorageSync("amountVisible", v);
  },

  onTempInfoTap() {
    this.setData({ showTempInfo: !this.data.showTempInfo });
  },

  onToggleAssetAlloc() {
    this.setData({ showAssetAlloc: !this.data.showAssetAlloc });
  },

  onLongPressHeader() {
    this.setData({ showColEdit: true });
  },
  onColMoveUp(e) {
    const idx = e.currentTarget.dataset.index;
    const order = [...this.data.colOrder];
    if (idx <= 0) return;
    [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    this.setData({ colOrder: order });
    wx.setStorageSync("colOrder", order);
  },
  onColMoveDown(e) {
    const idx = e.currentTarget.dataset.index;
    const order = [...this.data.colOrder];
    if (idx >= order.length - 1) return;
    [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
    this.setData({ colOrder: order });
    wx.setStorageSync("colOrder", order);
  },
  onCloseColEdit() {
    this.setData({ showColEdit: false });
  },

  // 新版本功能提示：升级后首次启动弹一次（全新用户不弹，避免打扰）
  _maybeShowUpdateLog() {
    try {
      const cur = getApp().getVersion();
      const seen = wx.getStorageSync("update_seen_version");
      const isReturning = !!wx.getStorageSync(CACHE_KEY); // 有持仓缓存 = 老用户
      if ((isReturning || seen) && seen !== cur) {
        const log = (getApp().getChangelog() || []).find(c => c.version === cur) || (getApp().getChangelog() || [])[0];
        if (log) this.setData({ showUpdateLog: true, updateVersion: log.version, updateItems: log.items });
      }
      wx.setStorageSync("update_seen_version", cur);
    } catch (e) { /* ignore */ }
  },

  onCloseUpdateLog() {
    this.setData({ showUpdateLog: false });
  },

  // ---- 止盈止损提醒 ----
  // 每日一次从云端同步提醒设置（换设备/多端以云端为准；失败静默保持本地）
  _syncAlertSettingsDaily() {
    try {
      const today = marketTime.bjDateStr();
      if (wx.getStorageSync("alertSyncDay") === today) return;
      wx.setStorageSync("alertSyncDay", today);
    } catch (e) { return; }
    wx.cloud.callFunction({
      name: "dailyBriefing",
      data: { action: "alertGet" },
    }).then((r) => {
      const res = r.result;
      const d = res && res.data;
      if (!d || typeof d !== "object") return;
      if (Object.keys(d).length > 0) {
        // 云端有设置：以云端为准
        wx.setStorageSync("alertSettings", d);
      } else {
        // 云端为空但本地有（升级用户首次打开）：反向初始化，防清空
        const local = wx.getStorageSync("alertSettings");
        if (local && Object.keys(local).length > 0) {
          wx.cloud.callFunction({
            name: "dailyBriefing",
            data: { action: "alertSet", settings: local },
          }).catch(() => {});
        }
      }
      // 全局提醒开关同步（本地缓存 + 页面显示）
      if (res && typeof res.globalOn === "boolean") {
        wx.setStorageSync("alertGlobalOn", res.globalOn);
        this.setData({ alertGlobalOn: res.globalOn });
      }
      if (this._checkAlerts) this._checkAlerts();
    }).catch(() => {});
  },

  onAlertUpper(e) { this.setData({ alertEditUpper: e.detail.value }); },
  onAlertLower(e) { this.setData({ alertEditLower: e.detail.value }); },
  onAlertPeToggle(e) { this.setData({ alertEditPeAlert: !this.data.alertEditPeAlert }); },
  onSaveAlert() {
    const { alertEditFundCode, alertEditUpper, alertEditLower, alertEditPeAlert } = this.data;
    const settings = wx.getStorageSync('alertSettings') || {};
    settings[alertEditFundCode] = { upper: parseFloat(alertEditUpper) || 0, lower: parseFloat(alertEditLower) || 0, peAlert: !!alertEditPeAlert };
    wx.setStorageSync('alertSettings', settings);
    // 开启PE提醒时记录当前signal作为基线
    if (alertEditPeAlert) {
      const h = this.data.holdings.find(h => h.fundCode === alertEditFundCode);
      if (h && h.peTemp && h.peTemp.signal) {
        const cache = wx.getStorageSync('peSignalCache') || {};
        cache[alertEditFundCode] = h.peTemp.signal;
        wx.setStorageSync('peSignalCache', cache);
      }
    }
    this.setData({ showAlertEdit: false });
    wx.showToast({ title: '已设置提醒', icon: 'success' });
    // 设置上云（换设备同步；失败静默，本地仍生效）
    wx.cloud.callFunction({
      name: "dailyBriefing",
      data: { action: "alertSet", settings },
    }).catch(() => {});
    // 保存提醒 = 用户明确要提醒，此刻请求推送授权（全漏斗转化率最高点）：
    // 未授权用户弹授权窗；已授权勾「总是保持」的静默 +1 额度
    subscribe.requestAuth("scene_alert");
  },
  onCloseAlertEdit() { this.setData({ showAlertEdit: false }); },
  onDismissAlert() {
    const codes = this.data.alertTriggered.map(t => t.fundCode);
    const dismissed = wx.getStorageSync('alertDismissed') || {};
    codes.forEach(c => { dismissed[c] = Date.now(); });
    wx.setStorageSync('alertDismissed', dismissed);
    this.setData({ alertTriggered: [] });
  },
  _checkAlerts() {
    const settings = wx.getStorageSync('alertSettings') || {};
    const dismissed = wx.getStorageSync('alertDismissed') || {};
    const peCache = wx.getStorageSync('peSignalCache') || {};
    const triggered = [];
    const newPeCache = { ...peCache };
    this.data.holdings.forEach(h => {
      const s = settings[h.fundCode];
      if (!s) return;
      // 今天已解除过的不再触发
      if (dismissed[h.fundCode] && (Date.now() - dismissed[h.fundCode] < 86400000)) return;
      // 涨跌幅提醒
      const rate = parseFloat(h.todayChangeRate);
      if ((s.upper > 0 && rate >= s.upper) || (s.lower < 0 && rate <= s.lower)) {
        triggered.push({ fundCode: h.fundCode, fundName: h.fundName, rate, type: rate >= (s.upper || 999) ? 'up' : 'down' });
      }
      // PE 温度变化提醒
      if (s.peAlert && h.peTemp && h.peTemp.signal && h.peTemp.signal !== 'nodata') {
        const prev = peCache[h.fundCode];
        if (prev && prev !== h.peTemp.signal) {
          const up = (prev === 'low' && h.peTemp.signal !== 'low') || (prev === 'mid' && h.peTemp.signal === 'high');
          const signalMap = { low: '温度偏低', mid: '温度适中', high: '温度偏高' };
          triggered.push({ fundCode: h.fundCode, fundName: h.fundName, rate: 0, type: up ? 'up' : 'down', peChange: `${signalMap[prev]||prev}→${signalMap[h.peTemp.signal]||h.peTemp.signal}` });
        }
        newPeCache[h.fundCode] = h.peTemp.signal;
      }
    });
    wx.setStorageSync('peSignalCache', newPeCache);
    if (triggered.length > 0) this.setData({ alertTriggered: triggered });
  },

  onScrollRefresh() {
    if (!this.data.isLoggedIn) {
      this.setData({ refresherTriggered: false });
      return;
    }
    // 消费 _autoPull 标记（onShow 自动刷新可能通过 scroll-view 触发），避免残留绕过防抖
    const isAuto = this._autoPull;
    this._autoPull = false;
    // 5s 防抖：scroll-view refresher 可被快速连续触发，避免连发请求
    const now = Date.now();
    if (!isAuto && this._lastFetch && now - this._lastFetch < 5000) {
      this.setData({ refresherTriggered: false });
      return;
    }
    this._lastFetch = now;
    subscribe.silentDailyAuth("index_pull"); // 用户手势时机：已授权用户每天静默补一次推送额度
    this.setData({ refresherTriggered: true });
    Promise.all([this.fetchPortfolio(false), this.fetchIndices()]).finally(() => {
      this.setData({ refresherTriggered: false });
    });
  },

  async fetchPortfolio(showLoading = true) {
    if (showLoading) this.setData({ loading: true });
    try {
      const res = await api.getPortfolio();
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        let holdings = (d.holdings || []);
        holdings = this.formatHoldings(holdings, d ? d.totalAmount : cached.totalAmount);
        holdings = this.sortHoldings(holdings);
        const allUpdated = holdings.length > 0 && holdings.every(h => h.estimateUpdated);
        // 合并计算：displayHoldings / groupCounts / groupSummary 一次算好，
        // 与主数据合并成一次 setData，避免多次渲染（原 3-4 次 setData）
        const { activeGroup, sortField, sortOrder } = this.data;
        let displayHoldings;
        if (activeGroup === "all") displayHoldings = [...holdings];
        else if (activeGroup === "ungrouped") displayHoldings = holdings.filter(h => !h.group);
        else displayHoldings = holdings.filter(h => h.group === activeGroup);
        displayHoldings = this.sortHoldings(displayHoldings, sortField, sortOrder);
        const counts = { all: holdings.length, ungrouped: 0 };
        for (const h of holdings) {
          if (!h.group) counts.ungrouped++;
          else counts[h.group] = (counts[h.group] || 0) + 1;
        }
        // groups（标签渲染）需字符串数组：_mergeGroups 已兼容对象数组（取 name）
        const groups = this._mergeGroups(d.groups || []);
        const groupSummary = this._computeGroupSummary(activeGroup, d.groups || []);
        this.setData({
          loading: false, loadError: false, dataReady: true,
          holdings, allUpdated, displayHoldings, groupCounts: counts, groups,
          groupSummary,
          totalAmount: d.totalAmount,
          todayProfit: parseFloat(d.todayProfit) !== 0 ? d.todayProfit : this.data.todayProfit,
          todayProfitRate: parseFloat(d.todayProfitRate) !== 0 ? d.todayProfitRate : this.data.todayProfitRate,
          totalReturn: d.totalReturn,
          totalReturnRate: d.totalReturnRate,
          updateTime: d.updateTime || "",
          assetAllocation: d.assetAllocation || null,
          healthScore: d.healthScore || null,
          showAssetAlloc: this.data.showAssetAlloc, // 保持展开状态
          fromCache: false,
          allGroupsData: d.groups || [],
        });
        this._refreshShareToken();
        this._checkAlerts();
        // 组合级净值日（持仓最大 actualDate）：供 isCacheFresh 判断当晚净值发布后冻结
        const maxActualDate = holdings.reduce((m, h) => (h.actualDate && h.actualDate > m ? h.actualDate : m), "");
        this._portfolioCache = {
          holdings, totalAmount: d.totalAmount, todayProfit: parseFloat(d.todayProfit) !== 0 ? d.todayProfit : this.data.todayProfit, todayProfitRate: parseFloat(d.todayProfitRate) !== 0 ? d.todayProfitRate : this.data.todayProfitRate, totalReturn: d.totalReturn, totalReturnRate: d.totalReturnRate, updateTime: d.updateTime, assetAllocation: d.assetAllocation, healthScore: d.healthScore, groups: d.groups || [], ts: Date.now(),
          actualDate: maxActualDate || undefined,
        };
        wx.setStorage({ key: CACHE_KEY, data: this._portfolioCache });
        return true;
      }
      return false;
    } catch (e) {
      this.setData({ loading: false, dataReady: true, loadError: this.data.holdings.length === 0 });
      console.error("获取持仓失败:", e);
      return false;
    }
  },

  // 下拉刷新：绕过缓存直接拉最新数据，刷新过程有原生动画 + 导航栏 loading 感知
  onPullDownRefresh() {
    const now = Date.now();
    // 用户连续下拉时 5s 防抖（自动刷新已改静默，不再走此入口）
    if (this._lastFetch && now - this._lastFetch < 5000) {
      wx.stopPullDownRefresh();
      return;
    }
    this._lastFetch = now;
    wx.showNavigationBarLoading();
    this.fetchPortfolio(true).finally(() => {
      wx.hideNavigationBarLoading();
      wx.stopPullDownRefresh();
    });
  },

  // 静默后台刷新：缓存已渲染，后台拉取最新数据完成后更新界面，不显示下拉动画/loading
  _silentRefresh() {
    if (this._silentFetching) return;
    this._silentFetching = true;
    Promise.all([this.fetchPortfolio(false), this.fetchIndices()]).finally(() => {
      this._silentFetching = false;
    });
  },

  onSortTap(e) {
    const field = e.currentTarget.dataset.field;
    const { sortField, sortOrder } = this.data;
    let nextField = field;
    let nextOrder = 'desc';
    if (sortField === field) {
      nextOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    }
    const sorted = this.sortHoldings([...this.data.displayHoldings], nextField, nextOrder);
    this.setData({ sortField: nextField, sortOrder: nextOrder, displayHoldings: sorted });
  },

  formatHoldings(list, totalAmount) {
    const total = parseFloat(totalAmount) || 0;
    return list.map(h => {
      // 预计算列表单元格展示字段（避免 WXML 里每格重复三元判断，减轻渲染压力）
      const cr = parseFloat(h.todayChangeRate) || 0;
      const tp = parseFloat(h.todayProfit) || 0;
      const tr = parseFloat(h.totalReturn) || 0;
      const trr = parseFloat(h.totalReturnRate) || 0;
      const mv = parseFloat(h.marketValue) || 0;
      const cn = parseFloat(h.currentNav) || 0;
      const hi = h.navHigh != null ? parseFloat(h.navHigh) : 0;
      const crCls = cr > 0 ? 'up' : cr < 0 ? 'down' : '';
      const tpCls = tp > 0 ? 'up' : tp < 0 ? 'down' : '';
      const trCls = tr > 0 ? 'up' : tr < 0 ? 'down' : '';
      const trrCls = trr > 0 ? 'up' : trr < 0 ? 'down' : '';
      // 估值列：温度信号 → 60日位置 → 无数据
      let valCls = 't-mid', valText = '--';
      const pe = h.peTemp;
      if (pe && pe.signal) {
        valCls = pe.signal === 'low' ? 't-low' : pe.signal === 'high' ? 't-high' : pe.signal === 'nodata' ? 't-nodata' : 't-mid';
        valText = pe.signal === 'low' ? '🟢偏低' : pe.signal === 'high' ? '🔴偏高' : pe.signal === 'nodata' ? '--' : '🟡适中';
      } else if (h.position != null) {
        const low = (h.currentNav != null && parseFloat(h.currentNav) < 0.75) || h.position <= 37;
        const high = !low && h.position >= 63;
        valCls = low ? 't-low' : high ? 't-high' : 't-mid';
        valText = low ? '🟢偏低' : high ? '🔴偏高' : '🟡适中';
      }
      return {
        ...h,
        navHigh: h.navHigh != null ? parseFloat(h.navHigh).toFixed(2) : null,
        navLow: h.navLow != null ? parseFloat(h.navLow).toFixed(2) : null,
        _crCls: crCls, _tpCls: tpCls, _trCls: trCls, _trrCls: trrCls,
        _crText: cr > 0 ? '+' + cr + '%' : cr + '%',
        _trrText: trr > 0 ? '+' + trr + '%' : trr + '%',
        _valCls: valCls, _valText: valText,
        _peSub: pe && pe.signal && pe.signal !== 'nodata' && pe.normPE != null ? pe.normPE : '',
        // 占比/距一年高点（新列预计算）
        _ratioText: total > 0 && mv > 0 ? (mv / total * 100).toFixed(1) + '%' : '--',
        _ddText: (hi > 0 && cn > 0) ? ((cn - hi) / hi * 100).toFixed(1) + '%' : '--',
      };
    });
  },

  sortHoldings(list, field, order) {
    const f = field || this.data.sortField;
    const o = order || this.data.sortOrder;
    const dir = o === 'asc' ? 1 : -1;
    if (f === 'todayProfit') {
      return list.sort((a, b) => {
        if (a.estimateUpdated !== b.estimateUpdated) return a.estimateUpdated ? -1 : 1;
        // 当日收益列按收益率排序（列名不变）
        return dir * ((parseFloat(a.todayProfitRate) || 0) - (parseFloat(b.todayProfitRate) || 0));
      });
    }
    return list.sort((a, b) => dir * (parseFloat(a.totalReturn) - parseFloat(b.totalReturn)));
  },

  async fetchIndices() {
    const activeIndices = this.data.activeIndices;
    if (!activeIndices || activeIndices.length === 0) {
      this.setData({ indexCards: [], indexLoading: false, indexBarHeight: 0 });
      return;
    }
    const FETCH_TIMEOUT = 3000;
    const HK_FETCH_TIMEOUT = 8000; // 港股走云函数多源并行竞速，放宽到 8s
    const A_CODES = ["000001", "399001", "000300", "399006"];
    const fetchOne = async (idx) => {
      const isHK = !A_CODES.includes(idx.code);
      // 全站统一腾讯口径（收益页当天图同源）：腾讯日K优先，东财兜底
      // （原东财优先导致同一指数两处数值不一致：首页 0.74 vs 收益页 0.86）
      const tRes = await Promise.race([
        api.fetchMarketIndexTencent(idx.code, 2).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
      ]);
      if (tRes && tRes.code === 0 && tRes.data && tRes.data.length > 0) {
        return tRes.data;
      }
      if (!isHK) {
        const clientRes = await Promise.race([
          api.fetchMarketIndexClient(idx.code, 2).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
        ]);
        if (clientRes && clientRes.code === 0 && clientRes.data && clientRes.data.length > 0) {
          return clientRes.data;
        }
      }
      const res = await Promise.race([
        api.fetchMarketIndex(idx.code, 2).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), isHK ? HK_FETCH_TIMEOUT : FETCH_TIMEOUT)),
      ]);
      return (res && res.result && res.result.code === 0 && res.result.data) || [];
    };

    const buildCard = (idx, data) => {
      if (data && data.length >= 1) {
        const latest = data[data.length - 1];
        const prev = data.length >= 2 ? data[data.length - 2] : latest;
        const change = +(latest.close - prev.close).toFixed(2);
        const changeRate = prev.close && prev.close !== 0
          ? +((change / prev.close) * 100).toFixed(2) : 0;
        return {
          name: idx.name, code: idx.code,
          price: latest.close.toFixed(2),
          change: change > 0 ? `+${change}` : `${change}`,
          changeRate: changeRate > 0 ? `+${changeRate}` : `${changeRate}`,
          isUp: change >= 0,
        };
      }
      return { name: idx.name, code: idx.code, price: "--", change: "--", changeRate: "--", isUp: true };
    };

    // 以 activeIndices 为准构建 cards，避免与旧 indexCards 长度/顺序不一致
    const cards = activeIndices.map((idx) => {
      const old = this.data.indexCards.find(c => c.code === idx.code);
      return old ? { ...old } : { name: idx.name, code: idx.code, price: "--", change: "--", changeRate: "--", isUp: true };
    });
    this.setData({ indexCards: cards, indexLoading: true });

    const promises = activeIndices.map((idx, i) =>
      fetchOne(idx).then((data) => {
        cards[i] = buildCard(idx, data);
        return cards[i];
      })
    );

    Promise.all(promises).then(() => {
      this.setData({ indexCards: cards });
      const codes = activeIndices.map((i) => i.code).join(",");
      wx.setStorage({ key: INDEX_CACHE_KEY, data: { codes, cards, ts: Date.now() } });
    }).catch(() => {}).finally(() => {
      this.setData({ indexLoading: false });
    });
  },

  onToggleIndex() {
    const indexExpanded = !this.data.indexExpanded;
    this.setData({
      indexExpanded,
      showIndexEdit: false,
    }, () => this._measureIndexBar());
  },

  // 实测指数栏高度（替代硬编码 110/240/470，适配字体缩放/机型差异）
  _measureIndexBar() {
    wx.createSelectorQuery().select('.index-bar').boundingClientRect((rect) => {
      if (rect && rect.height > 0) {
        this.setData({ indexBarHeight: Math.round(rect.height / (wx.getSystemInfoSync().windowWidth / 750)) });
      }
    }).exec();
  },

  onToggleIndexEdit() {
    const show = !this.data.showIndexEdit;
    const selections = {};
    const activeCodes = this.data.activeIndices.map((i) => i.code);
    ALL_INDICES.forEach((idx) => {
      selections[idx.code] = activeCodes.indexOf(idx.code) !== -1;
    });
    this.setData({
      showIndexEdit: show,
      indexExpanded: false,
      editSelections: selections,
    }, () => this._measureIndexBar());
  },

  onToggleIndexItem(e) {
    const { code } = e.currentTarget.dataset;
    const selections = { ...this.data.editSelections };
    selections[code] = !selections[code];
    this.setData({ editSelections: selections });
  },

  onSaveIndexPrefs() {
    const codes = [];
    ALL_INDICES.forEach((idx) => {
      if (this.data.editSelections[idx.code]) codes.push(idx.code);
    });
    if (codes.length === 0) {
      wx.showToast({ title: "至少保留一个指数", icon: "none" });
      return;
    }
    wx.setStorageSync("indexCodes", codes);
    const activeIndices = ALL_INDICES.filter((idx) => codes.indexOf(idx.code) !== -1);
    const indexCards = activeIndices.map((idx) => ({
      name: idx.name, code: idx.code,
      price: "--", change: "--", changeRate: "--", isUp: true,
    }));
    this.setData({
      showIndexEdit: false,
      activeIndices,
      indexCards,
      indexExpanded: false,
    }, () => this._measureIndexBar());
    this.fetchIndices();
    wx.showToast({ title: "已保存", icon: "success", duration: 1200 });
  },

  onTapProfit() {
    wx.navigateTo({ url: "/subpackages/analysis/pages/profit-detail/index" });
  },

  noop() {},

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  onSearch() { wx.navigateTo({ url: "/pages/search/index" }); },
  onScreenshotAdd() {
    // 未登录先引导授权
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: "/pages/login/index" });
      return;
    }
    wx.showActionSheet({
      itemList: ["从相册选择"],
      success: () => {
        wx.chooseMedia({
          count: 1, mediaType: ["image"],
          sourceType: ["album"], sizeType: ["compressed"],
          success: (mediaRes) => {
            const tempPath = mediaRes.tempFiles[0].tempFilePath;
            // 二次压缩，确保不超过 1MB（OCR 服务限制）
            wx.compressImage({
              src: tempPath,
              quality: 50,
              success: (compressRes) => {
                const app = getApp();
                app.globalData._screenshotPath = compressRes.tempFilePath;
                wx.navigateTo({ url: "/pages/add-holding/index?autoScreenshot=1" });
              },
              fail: () => {
                // 压缩失败则使用原图
                const app = getApp();
                app.globalData._screenshotPath = tempPath;
                wx.navigateTo({ url: "/pages/add-holding/index?autoScreenshot=1" });
              },
            });
          },
        });
      },
    });
  },
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  onToggleBatch() {
    const enter = !this.data.batchMode;
    const list = this.data.displayHoldings.map(h => ({ ...h, _checked: false }));
    // 进入批量模式时同步全局提醒开关的本地显示
    const patch = { batchMode: enter, displayHoldings: list, selectedCount: 0, allSelected: false };
    if (enter) patch.alertGlobalOn = !!wx.getStorageSync("alertGlobalOn");
    this.setData(patch);
  },

  // 全局涨跌提醒开关：开启后全部持仓按默认 ±3% 提醒（云端检测端兜底，新持仓自动纳入）
  onToggleGlobalAlert() {
    const next = !this.data.alertGlobalOn;
    this.setData({ alertGlobalOn: next });
    wx.setStorageSync("alertGlobalOn", next);
    wx.cloud.callFunction({
      name: "dailyBriefing",
      data: { action: "alertSet", globalOn: next },
    }).then(() => {
      wx.showToast({ title: next ? "已开启全局提醒" : "已关闭全局提醒", icon: "none", duration: 1500 });
    }).catch(() => {
      // 失败回滚本地（云端为准）
      this.setData({ alertGlobalOn: !next });
      wx.setStorageSync("alertGlobalOn", !next);
      wx.showToast({ title: "设置失败，请重试", icon: "none" });
    });
  },

  onToggleBatchSelect(e) {
    const idx = e.currentTarget.dataset.index;
    const list = [...this.data.displayHoldings];
    list[idx]._checked = !list[idx]._checked;
    const count = list.filter(h => h._checked).length;
    this.setData({ displayHoldings: list, selectedCount: count, allSelected: count === list.length });
  },

  onSelectAll() {
    const allSel = !this.data.allSelected;
    const list = this.data.displayHoldings.map(h => ({ ...h, _checked: allSel }));
    this.setData({ displayHoldings: list, selectedCount: allSel ? list.length : 0, allSelected: allSel });
  },

  async onBatchDelete() {
    const selected = this.data.displayHoldings.filter(h => h._checked);
    if (selected.length === 0) { wx.showToast({ title: "请先选择", icon: "none" }); return; }
    wx.showModal({
      title: "批量删除",
      content: `确定删除 ${selected.length} 个持仓及相关交易记录吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "删除中..." });
        // 写操作限并发 3，避免 N 条串行云函数调用拖慢批量删除
        const CONCURRENT = 3;
        let done = 0, idx = 0;
        const workers = [];
        const run = async () => {
          while (idx < selected.length) {
            const h = selected[idx++];
            try { await api.holdingRemove(h._id); done++; } catch (e) { /* ignore */ }
          }
        };
        for (let i = 0; i < Math.min(CONCURRENT, selected.length); i++) workers.push(run());
        await Promise.all(workers);
        wx.hideLoading();
        wx.showToast({ title: `已删除 ${done} 个`, icon: "success" });
        this.setData({ batchMode: false });
        wx.removeStorageSync("portfolio_cache");
        this.fetchPortfolio();
      },
    });
  },

  onAdjust() {
    const holdings = this.data.holdings;
    if (holdings.length === 0) {
      wx.showToast({ title: "暂无持仓", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/adjust-holding/index" });
  },

  onCorrelation() {
    const holdings = this.data.holdings;
    if (holdings.length < 2) {
      wx.showToast({ title: "至少需要2条记录", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/subpackages/analysis/pages/correlation-matrix/index" });
  },

  // ==== 分享卡片 ====
  onShareCard() {
    const holdings = this.data.holdings;
    if (holdings.length === 0) {
      wx.showToast({ title: "暂无持仓可分享", icon: "none" });
      return;
    }
    this.setData({ showShareCard: true, shareCardRendered: false }, () => {
      wx.nextTick(() => this._renderShareCard());
    });
  },

  _renderShareCard() {
    const query = wx.createSelectorQuery();
    query.select('#shareCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        wx.showToast({ title: '渲染失败', icon: 'none' });
        return;
      }
      const canvas = res[0].node;
      this._shareCanvas = canvas;
      const shareCard = require('../../utils/shareCard');
      const { todayProfit, todayProfitRate, totalAmount, totalReturn, totalReturnRate, holdings, amountVisible } = this.data;
      shareCard.drawShareCard(canvas, {
        todayProfit, todayProfitRate, totalAmount, totalReturn, totalReturnRate,
        fundCount: holdings.length,
        amountVisible,
      }).then(() => {
        this.setData({ shareCardRendered: true });
      }).catch(() => {
        wx.showToast({ title: '渲染失败', icon: 'none' });
      });
    });
  },

  onCloseShareCard() {
    this.setData({ showShareCard: false, shareCardRendered: false });
    this._shareCanvas = null;
  },

  async onSaveShareCard() {
    try {
      const tempPath = await this._getShareCardTempPath();
      if (!tempPath) return;
      // 请求相册授权并保存
      const setting = await new Promise((r) => {
        wx.getSetting({ success: (s) => r(s) });
      });
      if (!setting.authSetting['scope.writePhotosAlbum']) {
        await new Promise((resolve, reject) => {
          wx.authorize({ scope: 'scope.writePhotosAlbum', success: resolve, fail: reject });
        });
      }
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath: tempPath,
          success: resolve,
          fail: reject,
        });
      });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
      this.setData({ showShareCard: false, shareCardRendered: false });
    } catch (e) {
      console.error('保存分享卡片失败:', e);
      if (e.errMsg && e.errMsg.includes('auth deny')) {
        wx.showModal({
          title: '需要相册权限',
          content: '请在设置中允许小程序保存到相册',
          confirmText: '去设置',
          success: (mr) => { if (mr.confirm) wx.openSetting(); },
        });
      } else {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    }
  },

  async onShareToFriend() {
    try {
      const tempPath = await this._getShareCardTempPath();
      if (!tempPath) return;
      wx.showShareImageMenu({ path: tempPath });
    } catch (e) {
      console.error('分享卡片失败:', e);
      wx.showToast({ title: '分享失败，请重试', icon: 'none' });
    }
  },

  _getShareCardTempPath() {
    return new Promise((resolve) => {
      if (!this.data.shareCardRendered) {
        wx.showToast({ title: '卡片生成中...', icon: 'none' });
        resolve(null);
        return;
      }
      const canvas = this._shareCanvas;
      if (!canvas) {
        wx.showToast({ title: '卡片未就绪', icon: 'none' });
        resolve(null);
        return;
      }
      wx.canvasToTempFilePath({
        canvas,
        success: (res) => resolve(res.tempFilePath),
        fail: () => {
          wx.showToast({ title: '生成图片失败', icon: 'none' });
          resolve(null);
        },
      });
    });
  },

  onTapHolding(e) {
    if (this.data.batchMode) return;
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/subpackages/analysis/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onLongPressHolding(e) {
    const { id, code, name } = e.currentTarget.dataset;
    const self = this;
    wx.showActionSheet({
      itemList: ['编辑', '设置提醒', '移动到分组', '删除'],
      success(res) {
        const h = self.data.holdings.find((x) => x._id === id);
        if (!h) return;
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
        } else if (res.tapIndex === 1) {
          self.setData({ showAlertEdit: true, alertEditFundCode: h.fundCode, alertEditFundName: h.fundName });
          const settings = wx.getStorageSync('alertSettings') || {};
          const s = settings[h.fundCode] || { upper: 3, lower: -3 };
          self.setData({ alertEditUpper: String(s.upper || ''), alertEditLower: String(s.lower || ''), alertEditPeAlert: !!s.peAlert });
        } else if (res.tapIndex === 2) {
          self.moveHoldingToGroup([h.fundCode], h.fundName);
        } else if (res.tapIndex === 3) {
          wx.showModal({
            title: "确认删除",
            content: "确定要删除此条持仓吗？",
            success(r) {
              if (!r.confirm) return;
              wx.showLoading({ title: "删除中..." });
              api.holdingRemove(id)
                .then(() => {
                  wx.hideLoading();
                  wx.showToast({ title: "已删除", icon: "success" });
                  self.fetchPortfolio();
                })
                .catch(() => {
                  wx.hideLoading();
                  wx.showToast({ title: "删除失败，请重试", icon: "none" });
                });
            },
          });
        }
      },
    });
  },

  // ========== 分组管理 ==========

  applyGroupFilter() {
    const { holdings, activeGroup, sortField, sortOrder } = this.data;
    let list;
    if (activeGroup === "all") {
      list = [...holdings];
    } else if (activeGroup === "ungrouped") {
      list = holdings.filter(h => !h.group);
    } else {
      list = holdings.filter(h => h.group === activeGroup);
    }
    list = this.sortHoldings(list, sortField, sortOrder);
    const extra = this._computeGroupSummary(activeGroup);
    this.setData({ displayHoldings: list, groupSummary: extra });
  },

  // 纯计算：当前分组的汇总（不 setData，供合并渲染用）
  // allGroupsData 参数可显式传入新值，避免依赖 this.data 的旧值（合并 setData 场景）
  _computeGroupSummary(activeGroup, allGroupsData) {
    const data = allGroupsData !== undefined ? allGroupsData : this.data.allGroupsData;
    if (activeGroup === "all" || !data || data.length === 0) {
      return null;
    }
    const g = data.find(g => g.name === activeGroup);
    return g || null;
  },

  updateGroupCounts() {
    const { holdings, groups } = this.data;
    const counts = { all: holdings.length, ungrouped: 0 };
    for (const h of holdings) {
      if (!h.group) counts.ungrouped++;
      else counts[h.group] = (counts[h.group] || 0) + 1;
    }
    // 合并服务端分组
    const allGroups = this._mergeGroups(groups);
    this.setData({ groupCounts: counts, groups: allGroups });
  },

  updateGroupSummary() {
    this.setData({ groupSummary: this._computeGroupSummary(this.data.activeGroup) });
  },

  onGroupTap(e) {
    if (this._didLongPress || this._dragMoved) return;
    const group = e.currentTarget.dataset.group;
    if (group === this.data.activeGroup) return;
    this.setData({ activeGroup: group }, () => {
      this.applyGroupFilter();
    });
  },

  onAddGroup() {
    this.showGroupInput((groupName) => {
      wx.showToast({ title: `分组「${groupName}」已创建`, icon: "success", duration: 2000 });
      this._saveGroupToCache(groupName);
      this.updateGroupCounts();
      wx.removeStorageSync("portfolio_cache");
      setTimeout(() => {
        wx.showToast({ title: "长按持仓可移入分组", icon: "none", duration: 2000 });
      }, 2200);
    });
  },

  showGroupInput(callback) {
    wx.showModal({
      title: "新建分组",
      editable: true,
      placeholderText: "输入分组名称，如：科技类",
      content: "",
      success: (res) => {
        if (!res.confirm || !res.content) return;
        const name = res.content.trim().slice(0, 20);
        if (!name) return;
        // 防止与内置标识冲突
        if (name === "all" || name === "ungrouped") {
          wx.showToast({ title: "分组名与系统保留字冲突", icon: "none" });
          return;
        }
        callback(name);
      },
    });
  },

  _getCachedGroups() {
    try {
      const list = wx.getStorageSync(GROUPS_CACHE_KEY) || [];
      // 防御：清洗历史污染（曾有 bug 把对象数组写入缓存），只保留字符串分组名
      return Array.isArray(list) ? list.filter(g => typeof g === 'string') : [];
    } catch (e) {
      return [];
    }
  },

  _saveGroupToCache(groupName) {
    const cached = this._getCachedGroups();
    if (!cached.includes(groupName)) {
      cached.push(groupName);
      wx.setStorageSync(GROUPS_CACHE_KEY, cached);
    }
    const merged = this._mergeGroups(this.data.groups);
    if (!merged.includes(groupName)) merged.push(groupName);
    this.setData({ groups: merged });
  },

  _mergeGroups(serverGroups) {
    const cached = this._getCachedGroups();
    const merged = [...cached];
    // 防御：serverGroups 可能是对象数组（取 name）或字符串数组
    for (const g of (serverGroups || [])) {
      const name = typeof g === 'string' ? g : (g && g.name);
      if (name && !merged.includes(name)) merged.push(name);
    }
    return merged;
  },

  moveHoldingToGroup(codes, hintName) {
    this.setData({ showGroupPicker: true, groupPickerCodes: codes });
  },

  onCloseGroupPicker() {
    this.setData({ showGroupPicker: false, groupPickerCodes: [] });
  },

  onPickGroup(e) {
    const group = e.currentTarget.dataset.group;
    const codes = this.data.groupPickerCodes;
    this.setData({ showGroupPicker: false });
    this.doMoveToGroup(codes, group);
  },

  onPickNewGroup() {
    const codes = this.data.groupPickerCodes;
    this.showGroupInput(groupName => {
      this._saveGroupToCache(groupName);
      this.setData({ showGroupPicker: false });
      this.doMoveToGroup(codes, groupName);
    });
  },

  async doMoveToGroup(codes, group) {
    try {
      const res = await api.holdingSetGroup(codes, group);
      if (res.result && res.result.code === 0) {
        wx.showToast({ title: "已移动", icon: "success" });
        wx.removeStorageSync("portfolio_cache");
        wx.setStorageSync("portfolio_force_refresh", true);
        this.fetchPortfolio();
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "操作失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "网络错误", icon: "none" });
    }
  },

  // ========== 分组拖拽排序 ==========

  onGroupTouchStart(e) {
    const touch = e.touches[0];
    const idx = parseInt(e.currentTarget.dataset.index);
    if (isNaN(idx)) return;
    this._dragStartX = touch.clientX;
    this._dragStartIdx = idx;
    this._didLongPress = false;
    this._dragMoved = false;
    this._tabWidth = 0;
    wx.createSelectorQuery().selectAll('.group-tab').boundingClientRect(rects => {
      if (rects && rects.length > 0) {
        const sum = rects.reduce((s, r) => s + r.width, 0);
        this._tabWidth = Math.round(sum / rects.length);
      }
    }).exec();
    clearTimeout(this._dragTimer);
    this._dragTimer = setTimeout(() => {
      this._didLongPress = true;
      wx.vibrateShort({ type: "medium" });
    }, 500);
  },

  onGroupTouchMove(e) {
    if (!this._didLongPress) {
      if (Math.abs(e.touches[0].clientX - this._dragStartX) > 10) {
        clearTimeout(this._dragTimer);
      }
      return;
    }
    const deltaX = e.touches[0].clientX - this._dragStartX;
    if (!this._dragMoved && Math.abs(deltaX) < 6) return;

    if (!this._dragMoved) {
      this._dragMoved = true;
      this.setData({ dragging: true, dragIndex: this._dragStartIdx, dragX: 0 });
    }
    const tw = this._tabWidth || 100;
    const maxLeft = -this._dragStartIdx * tw - 30;
    const maxRight = (this.data.groups.length - 1 - this._dragStartIdx) * tw + 30;
    const clampedX = Math.max(maxLeft, Math.min(maxRight, deltaX));

    const swapOffset = Math.round(clampedX / tw);
    const newIdx = this._dragStartIdx + swapOffset;
    const clamped = Math.max(0, Math.min(newIdx, this.data.groups.length - 1));
    if (clamped !== this.data.dragIndex && this.data.dragIndex >= 0) {
      const groups = [...this.data.groups];
      const [moved] = groups.splice(this.data.dragIndex, 1);
      groups.splice(clamped, 0, moved);
      this.setData({ groups, dragIndex: clamped, dragX: clampedX - swapOffset * tw });
      this._dragStartIdx = clamped;
      this._dragStartX = e.touches[0].clientX;
    } else {
      this.setData({ dragX: clampedX });
    }
  },

  onGroupTouchEnd(e) {
    clearTimeout(this._dragTimer);
    if (this._dragMoved) {
      wx.setStorageSync(GROUPS_CACHE_KEY, [...this.data.groups]);
      this.setData({ dragging: false, dragIndex: -1, dragX: 0 });
      this.updateGroupCounts();
      return;
    }
    // 长按未拖拽 → 弹出菜单
    if (this._didLongPress) {
      const group = e.currentTarget.dataset.group;
      if (group && group !== "all" && group !== "ungrouped") {
        wx.showActionSheet({
          itemList: ["重命名", "删除分组"],
          success: (res) => {
            if (res.tapIndex === 0) this.renameGroup(group);
            else if (res.tapIndex === 1) this.deleteGroup(group);
          },
        });
      }
    }
  },

  renameGroup(oldName) {
    wx.showModal({
      title: "重命名分组",
      editable: true,
      placeholderText: "输入新名称",
      content: oldName,
      success: async (res) => {
        if (!res.confirm || !res.content) return;
        const newNameStr = res.content.trim().slice(0, 20);
        if (!newNameStr || newNameStr === oldName) return;
        try {
          await api.holdingRenameGroup(oldName, newNameStr);
          // 同步本地缓存
          const cached = this._getCachedGroups();
          const idx = cached.indexOf(oldName);
          if (idx >= 0) cached[idx] = newNameStr;
          else if (!cached.includes(newNameStr)) cached.push(newNameStr);
          wx.setStorageSync(GROUPS_CACHE_KEY, cached);
          // 立即更新本地 groups
          const idx2 = this.data.groups.indexOf(oldName);
          if (idx2 >= 0) {
            const gs = [...this.data.groups];
            gs[idx2] = newNameStr;
            this.setData({ groups: gs });
          }
          if (this.data.activeGroup === oldName) {
            this.setData({ activeGroup: newNameStr }, () => this.applyGroupFilter());
          }
          wx.showToast({ title: "已重命名", icon: "success" });
          wx.removeStorageSync("portfolio_cache");
          wx.setStorageSync("portfolio_force_refresh", true);
          this.fetchPortfolio();
        } catch (e) {
          wx.showToast({ title: "重命名失败", icon: "none" });
        }
      },
    });
  },

  deleteGroup(group) {
    wx.showModal({
      title: "删除分组",
      content: `确定删除「${group}」分组吗？组内持仓将变为「未分组」`,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.holdingDeleteGroup(group);
          // 同步本地缓存
          const cached = this._getCachedGroups().filter(g => g !== group);
          wx.setStorageSync(GROUPS_CACHE_KEY, cached);
          // 从当前 groups 中移除（防止 _mergeGroups 加回来）
          const groups = this.data.groups.filter(g => g !== group);
          this.setData({ groups });
          if (this.data.activeGroup === group) {
            this.setData({ activeGroup: "all" }, () => this.applyGroupFilter());
          }
          wx.showToast({ title: "已删除", icon: "success" });
          wx.removeStorageSync("portfolio_cache");
          wx.setStorageSync("portfolio_force_refresh", true);
          this.fetchPortfolio();
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },

  onBatchMoveToGroup() {
    const selected = this.data.displayHoldings.filter(h => h._checked);
    if (selected.length === 0) {
      wx.showToast({ title: "请先选择持仓", icon: "none" });
      return;
    }
    const codes = selected.map(h => h.fundCode);
    this.moveHoldingToGroup(codes);
  },

});
