const api = require("../../utils/api");

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
    selectedCount: 0,
    allSelected: false,
    loadError: false,
    showTempInfo: false,
    lt: '<',
    gt: '>',
    assetAllocation: null,
    showAssetAlloc: false,
    showColEdit: false,
    colOrder: wx.getStorageSync("colOrder") || ["todayProfit", "totalReturn", "valuation"],
    colDefs: {
      todayProfit: { label: "当日收益", sortable: true },
      totalReturn: { label: "累计收益", sortable: true },
      valuation: { label: "估值", sortable: false, isValuation: true },
    },
    showChangelog: false, changelog: null,
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
  },

  onPageScroll() {},

  // 启用分享到好友和朋友圈
  onShareAppMessage() {
    return {
      title: '韭菜养基宝 · 涨跌有数',
      path: '/pages/index/index',
      imageUrl: '',
    };
  },

  onShareTimeline() {
    return {
      title: '韭菜养基宝 · 持仓估值一目了然',
      imageUrl: '',
    };
  },

  onLoad() {
    const { windowHeight, windowWidth } = wx.getSystemInfoSync();
    this._windowWidth = windowWidth;
    this.setData({ pageHeight: windowHeight });
    // 读取主题色
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
  },

  onShow() {
    const now = Date.now();
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });

    // 恢复缓存的分组列表
    const cachedGroups = this._getCachedGroups();
    if (cachedGroups.length && !this.data.groups.length) {
      this.setData({ groups: cachedGroups });
    }

    // 版本更新日志
    const app = getApp();
    if (app.globalData._pendingChangelog) {
      this.setData({ showChangelog: true, changelog: app.globalData._pendingChangelog });
    }

    const savedCodes = wx.getStorageSync("indexCodes");
    let activeIndices = ALL_INDICES.slice(0, 6);
    if (savedCodes && savedCodes.length > 0) {
      const filtered = ALL_INDICES.filter((idx) => savedCodes.indexOf(idx.code) !== -1);
      if (filtered.length > 0) activeIndices = filtered;
    }
    this.setData({ activeIndices });
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.applyCache();
      this.applyIndexCache();
      // 30秒内不重复拉取数据（截图导入成功后强制刷新）
      const forceRefresh = wx.getStorageSync("portfolio_force_refresh");
      if (forceRefresh) {
        wx.removeStorageSync("portfolio_force_refresh");
        this._lastFetch = 0;
      }
      if (!this._lastFetch || now - this._lastFetch > 30000) {
        this._lastFetch = now;
        this.fetchPortfolio();
        this.fetchIndices();
      }
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
        let holdings = cached.holdings;
        holdings = this.formatHoldings(holdings);
        holdings = this.sortHoldings(holdings);
        const allUpdated = holdings.length > 0 && holdings.every(h => h.estimateUpdated);
        this.setData({
          holdings,
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
        });
        this.applyGroupFilter();
        this.updateGroupCounts();
      }
    } catch (e) { /* ignore cache read error */ }
  },

  applyIndexCache() {
    try {
      const cached = wx.getStorageSync(INDEX_CACHE_KEY);
      const codes = this.data.activeIndices.map((i) => i.code).join(",");
      if (cached && cached.codes === codes && cached.cards && cached.cards.length > 0) {
        this.setData({ indexCards: cached.cards, indexBarHeight: 110 });
        return true;
      }
    } catch (e) { /* ignore */ }
    // 无缓存时展示占位，让指数栏立即可见
    const placeholders = this.data.activeIndices.map((idx) => ({
      name: idx.name, code: idx.code,
      price: "--", change: "--", changeRate: "--", isUp: true,
    }));
    this.setData({ indexCards: placeholders, indexBarHeight: 110 });
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
  onCloseChangelog() {
    this.setData({ showChangelog: false });
    getApp().markChangelogRead();
  },

  // ---- 止盈止损提醒 ----
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
          const signalMap = { low: '低估', mid: '正常', high: '高估' };
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
    this._lastFetch = Date.now();
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
        holdings = this.formatHoldings(holdings);
        holdings = this.sortHoldings(holdings);
        const allUpdated = holdings.length > 0 && holdings.every(h => h.estimateUpdated);
        this.setData({
          loading: false, loadError: false, dataReady: true,
          holdings, allUpdated,
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
        this.applyGroupFilter();
        this.updateGroupCounts();
        this._checkAlerts();
        wx.setStorage({ key: CACHE_KEY, data: { holdings, totalAmount: d.totalAmount, todayProfit: parseFloat(d.todayProfit) !== 0 ? d.todayProfit : this.data.todayProfit, todayProfitRate: parseFloat(d.todayProfitRate) !== 0 ? d.todayProfitRate : this.data.todayProfitRate, totalReturn: d.totalReturn, totalReturnRate: d.totalReturnRate, updateTime: d.updateTime, assetAllocation: d.assetAllocation, healthScore: d.healthScore, groups: d.groups || [], ts: Date.now() } });
      }
    } catch (e) {
      this.setData({ loading: false, dataReady: true, loadError: this.data.holdings.length === 0 });
      console.error("获取持仓失败:", e);
    }
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

  formatHoldings(list) {
    return list.map(h => ({
      ...h,
      navHigh: h.navHigh != null ? parseFloat(h.navHigh).toFixed(2) : null,
      navLow: h.navLow != null ? parseFloat(h.navLow).toFixed(2) : null,
    }));
  },

  sortHoldings(list, field, order) {
    const f = field || this.data.sortField;
    const o = order || this.data.sortOrder;
    const dir = o === 'asc' ? 1 : -1;
    if (f === 'todayProfit') {
      return list.sort((a, b) => {
        if (a.estimateUpdated !== b.estimateUpdated) return a.estimateUpdated ? -1 : 1;
        return dir * (parseFloat(a.todayProfit) - parseFloat(b.todayProfit));
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
    const A_CODES = ["000001", "399001", "000300", "399006"];
    const fetchOne = async (idx) => {
      if (A_CODES.includes(idx.code)) {
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
        new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
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
      indexBarHeight: indexExpanded ? 240 : 110,
    });
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
      indexBarHeight: show ? 470 : 110,
    });
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
      indexBarHeight: 110,
      indexExpanded: false,
    });
    this.fetchIndices();
    wx.showToast({ title: "已保存", icon: "success", duration: 1200 });
  },

  onTapProfit() {
    wx.navigateTo({ url: "/pages/profit-detail/index" });
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
    this.setData({ batchMode: enter, displayHoldings: list, selectedCount: 0, allSelected: false });
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
        const db = wx.cloud.database();
        let done = 0;
        for (const h of selected) {
          try {
            await db.collection("holdings").doc(h._id).remove();
            await db.collection("transactions").where({ fundCode: h.fundCode }).remove();
            done++;
          } catch (e) { /* ignore */ }
        }
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
    wx.navigateTo({ url: "/pages/correlation-matrix/index" });
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
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
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
          const s = settings[h.fundCode] || { upper: 15, lower: -10 };
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
    this.setData({ displayHoldings: list }, () => {
      this.updateGroupSummary();
    });
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
    const { activeGroup, allGroupsData } = this.data;
    if (activeGroup === "all" || !allGroupsData || allGroupsData.length === 0) {
      this.setData({ groupSummary: null });
      return;
    }
    const g = allGroupsData.find(g => g.name === activeGroup);
    this.setData({ groupSummary: g || null });
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
      return wx.getStorageSync(GROUPS_CACHE_KEY) || [];
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
    for (const g of serverGroups) {
      if (!merged.includes(g)) merged.push(g);
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
        wx.showToast({ title: res.result?.msg || "操作失败", icon: "none" });
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
