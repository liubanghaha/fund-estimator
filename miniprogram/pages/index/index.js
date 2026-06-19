const api = require("../../utils/api");

const EXTRA_WIDTH = 280;

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

Page({
  data: {
    isLoggedIn: false,
    loading: false,
    dataReady: false,
    holdings: [],
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
    listScrollX: 0,
    listSliding: false,
    batchMode: false,
    selectedCount: 0,
    allSelected: false,
    loadError: false,
  },

  onLoad() {
    const { windowHeight, windowWidth } = wx.getSystemInfoSync();
    this._windowWidth = windowWidth;
    this.setData({ pageHeight: windowHeight });
  },

  onShow() {
    const now = Date.now();
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });
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
      this.setData({ isLoggedIn: false, holdings: [] });
      wx.removeStorageSync("portfolio_cache");
      wx.removeStorageSync("profit_detail_cache");
    }
  },

  applyCache() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.holdings && cached.holdings.length > 0) {
        let holdings = cached.holdings;
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
          fromCache: true,
          allUpdated,
        });
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

  onScrollRefresh() {
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
          fromCache: false,
        });
        wx.setStorage({ key: CACHE_KEY, data: { holdings, totalAmount: d.totalAmount, todayProfit: parseFloat(d.todayProfit) !== 0 ? d.todayProfit : this.data.todayProfit, todayProfitRate: parseFloat(d.todayProfitRate) !== 0 ? d.todayProfitRate : this.data.todayProfitRate, totalReturn: d.totalReturn, totalReturnRate: d.totalReturnRate, updateTime: d.updateTime, ts: Date.now() } });
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
    const sorted = this.sortHoldings([...this.data.holdings], nextField, nextOrder);
    this.setData({ sortField: nextField, sortOrder: nextOrder, holdings: sorted });
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
    wx.showActionSheet({
      itemList: ["从相册选择"],
      success: () => {
        wx.chooseMedia({
          count: 1, mediaType: ["image"],
          sourceType: ["album"], sizeType: ["compressed"],
          success: (mediaRes) => {
            const app = getApp();
            app.globalData._screenshotPath = mediaRes.tempFiles[0].tempFilePath;
            wx.navigateTo({ url: "/pages/add-holding/index?autoScreenshot=1" });
          },
        });
      },
    });
  },
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  onToggleBatch() {
    const enter = !this.data.batchMode;
    const holdings = this.data.holdings.map(h => ({ ...h, _checked: false }));
    this.setData({ batchMode: enter, holdings, selectedCount: 0, allSelected: false });
  },

  onToggleBatchSelect(e) {
    const idx = e.currentTarget.dataset.index;
    const holdings = [...this.data.holdings];
    holdings[idx]._checked = !holdings[idx]._checked;
    const count = holdings.filter(h => h._checked).length;
    this.setData({ holdings, selectedCount: count, allSelected: count === holdings.length });
  },

  onSelectAll() {
    const allSel = !this.data.allSelected;
    const holdings = this.data.holdings.map(h => ({ ...h, _checked: allSel }));
    this.setData({ holdings, selectedCount: allSel ? holdings.length : 0, allSelected: allSel });
  },

  async onBatchDelete() {
    const selected = this.data.holdings.filter(h => h._checked);
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

  onTouchStart(e) {
    this._touchData = {
      startX: e.touches[0].clientX,
      baseScroll: this.data.listScrollX,
      currentX: this.data.listScrollX,
      moved: false,
    };
  },

  onTouchMove(e) {
    if (!this._touchData) return;
    const dx = e.touches[0].clientX - this._touchData.startX;
    if (!this._touchData.moved && Math.abs(dx) > 3) {
      this._touchData.moved = true;
    }
    if (!this._touchData.moved) return;
    const px = this.rpxToPx(EXTRA_WIDTH);
    let newX = this._touchData.baseScroll + dx;
    newX = Math.min(0, Math.max(-px, newX));
    this._touchData.currentX = newX;
    this.setData({ listScrollX: newX, listSliding: true });
  },

  onTouchEnd(e) {
    if (!this._touchData) return;
    const px = this.rpxToPx(EXTRA_WIDTH);
    const cur = this._touchData.currentX;
    const snapX = Math.abs(cur) > px * 0.3 ? -px : 0;
    this.setData({ listScrollX: snapX, listSliding: false });
    this._touchData = null;
  },

  rpxToPx(rpx) {
    return (rpx / 750) * (this._windowWidth || 375);
  },

  onTapHolding(e) {
    if (this._touchData && this._touchData.moved) return;
    if (this.data.listScrollX < 0) {
      this.setData({ listScrollX: 0, listSliding: false });
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onLongPressHolding(e) {
    const { id } = e.currentTarget.dataset;
    const _this = this;
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success(res) {
        const h = _this.data.holdings.find((x) => x._id === id);
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
        } else if (res.tapIndex === 1) {
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
                  _this.fetchPortfolio();
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
});
