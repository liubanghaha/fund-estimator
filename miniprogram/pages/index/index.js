const api = require("../../utils/api");

const CACHE_KEY = "ledger_cache";
const GROUPS_CACHE_KEY = "holding_groups_cache";
const CACHE_TTL = 300000; // 5 分钟

Page({
  data: {
    theme: "red",
    isLoggedIn: false,
    loading: false,
    dataReady: false,
    holdings: [],
    displayHoldings: [],
    amountVisible: true,
    totalCost: "0.00",
    refresherTriggered: false,
    fromCache: false,
    batchMode: false,
    selectedCount: 0,
    allSelected: false,
    // 分组
    groups: [],
    activeGroup: "all",
    groupCounts: {},
    showGroupPicker: false,
    groupPickerCodes: [],
    // 手动盈亏
    showCalc: false,
    calcCode: "",
    calcName: "",
    calcShares: "",
    calcCost: "",
    calcPrice: "",
    calcResult: null,
  },

  onLoad() {
    this.setData({});
  },

  onShow() {
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    const now = Date.now();
    const amountVisible = wx.getStorageSync("amountVisible");
    if (amountVisible !== "") this.setData({ amountVisible: !!amountVisible });

    const cachedGroups = this._getCachedGroups();
    if (cachedGroups.length && !this.data.groups.length) {
      this.setData({ groups: cachedGroups });
    }

    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.applyCache();
      const forceRefresh = wx.getStorageSync("portfolio_force_refresh");
      if (forceRefresh) {
        wx.removeStorageSync("portfolio_force_refresh");
        this._lastFetch = 0;
      }
      const cacheAge = this._cacheTs ? (now - this._cacheTs) : Infinity;
      if (!this._lastFetch || now - this._lastFetch > 30000 || cacheAge > CACHE_TTL) {
        this._lastFetch = now;
        this.fetchHoldings();
      }
    } else {
      this.setData({ isLoggedIn: false, holdings: [], displayHoldings: [], dataReady: true });
      wx.removeStorageSync(CACHE_KEY);
    }
  },

  applyCache() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.holdings && cached.holdings.length > 0) {
        this._cacheTs = cached.ts || 0;
        const holdings = cached.holdings;
        this.setData({ holdings, totalCost: cached.totalCost || "0.00", fromCache: true });
        this.applyGroupFilter();
        this.updateGroupCounts();
      }
    } catch (e) { /* ignore */ }
  },

  onToggleAmount() {
    const v = !this.data.amountVisible;
    this.setData({ amountVisible: v });
    wx.setStorageSync("amountVisible", v);
  },

  onScrollRefresh() {
    if (!this.data.isLoggedIn) {
      this.setData({ refresherTriggered: false });
      return;
    }
    this._lastFetch = Date.now();
    this.fetchHoldings().finally(() => {
      this.setData({ refresherTriggered: false });
    });
  },

  async fetchHoldings(showLoading = false) {
    if (showLoading) this.setData({ loading: true });
    try {
      const res = await api.getPortfolio(0);
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        const holdings = (d.holdings || []).map(h => ({
          _id: h._id,
          fundCode: h.fundCode,
          fundName: h.fundName,
          shares: h.shares || "0",
          buyPrice: h.buyPrice || "0.00",
          totalCost: h.totalCost || h.marketValue || "0.00",
          group: h.group || "",
        }));
        const totalCost = holdings.reduce((s, h) => s + parseFloat(h.totalCost || 0), 0).toFixed(2);
        this.setData({
          loading: false, dataReady: true, holdings, totalCost,
          groups: d.groups || [],
        });
        this.applyGroupFilter();
        this.updateGroupCounts();
        wx.setStorage({ key: CACHE_KEY, data: { holdings, totalCost, ts: Date.now() } });
      }
    } catch (e) {
      this.setData({ loading: false, dataReady: true });
      console.error("获取记录失败:", e);
    }
  },

  // ==== 分组 ====
  applyGroupFilter() {
    const { holdings, activeGroup } = this.data;
    let list;
    if (activeGroup === "all") {
      list = holdings.concat();
    } else if (activeGroup === "ungrouped") {
      list = holdings.filter(h => !h.group);
    } else {
      list = holdings.filter(h => h.group === activeGroup);
    }
    this.setData({ displayHoldings: list });
  },

  updateGroupCounts() {
    const { holdings, groups } = this.data;
    const counts = { all: holdings.length, ungrouped: 0 };
    for (const h of holdings) {
      if (!h.group) counts.ungrouped++;
      else counts[h.group] = (counts[h.group] || 0) + 1;
    }
    const allGroups = this._mergeGroups(groups);
    this.setData({ groupCounts: counts, groups: allGroups });
  },

  onGroupTap(e) {
    const group = e.currentTarget.dataset.group;
    if (group === this.data.activeGroup) return;
    this.setData({ activeGroup: group }, () => {
      this.applyGroupFilter();
    });
  },

  onAddGroup() {
    this._showGroupInput((groupName) => {
      wx.showToast({ title: `分组「${groupName}」已创建`, icon: "success" });
      this._saveGroupToCache(groupName);
      this.updateGroupCounts();
      wx.removeStorageSync(CACHE_KEY);
    });
  },

  _showGroupInput(callback) {
    wx.showModal({
      title: "新建分组",
      editable: true,
      placeholderText: "输入分组名称",
      content: "",
      success: (res) => {
        if (!res.confirm || !res.content) return;
        const name = res.content.trim().slice(0, 20);
        if (!name) return;
        if (name === "all" || name === "ungrouped") {
          wx.showToast({ title: "分组名与系统保留字冲突", icon: "none" });
          return;
        }
        callback(name);
      },
    });
  },

  _getCachedGroups() {
    try { return wx.getStorageSync(GROUPS_CACHE_KEY) || []; } catch (e) { return []; }
  },
  _saveGroupToCache(name) {
    const cached = this._getCachedGroups();
    if (!cached.includes(name)) { cached.push(name); wx.setStorageSync(GROUPS_CACHE_KEY, cached); }
    const merged = this._mergeGroups(this.data.groups);
    if (!merged.includes(name)) merged.push(name);
    this.setData({ groups: merged });
  },
  _mergeGroups(serverGroups) {
    const cached = this._getCachedGroups();
    const merged = cached.concat();
    for (const g of serverGroups) { if (!merged.includes(g)) merged.push(g); }
    return merged;
  },

  // ==== 移动分组 ====
  moveHoldingToGroup(codes) {
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
    this._showGroupInput(groupName => {
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
        wx.removeStorageSync(CACHE_KEY);
        this.fetchHoldings();
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "操作失败", icon: "none" });
      }
    } catch (e) { wx.showToast({ title: "网络错误", icon: "none" }); }
  },
  onBatchMoveToGroup() {
    const selected = this.data.displayHoldings.filter(h => h._checked);
    if (selected.length === 0) { wx.showToast({ title: "请先选择记录", icon: "none" }); return; }
    this.moveHoldingToGroup(selected.map(h => h.fundCode));
  },

  // ==== 资产管理 ====
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  onTapHolding(e) {
    if (this.data.batchMode) return;
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
  },

  onLongPressHolding(e) {
    const { id, code } = e.currentTarget.dataset;
    const h = this.data.holdings.find(x => x._id === id);
    if (!h) return;
    const self = this;
    wx.showActionSheet({
      itemList: ['编辑', '手动算盈亏', '移动到分组', '删除'],
      success(res) {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/add-holding/index?id=${id}` });
        } else if (res.tapIndex === 1) {
          self.setData({
            showCalc: true, calcCode: h.fundCode, calcName: h.fundName,
            calcShares: h.shares, calcCost: h.totalCost || h.buyPrice,
            calcPrice: "", calcResult: null,
          });
        } else if (res.tapIndex === 2) {
          self.moveHoldingToGroup([h.fundCode]);
        } else if (res.tapIndex === 3) {
          wx.showModal({
            title: "确认删除", content: "确定要删除此条记录吗？",
            success(r) {
              if (!r.confirm) return;
              wx.showLoading({ title: "删除中..." });
              api.holdingRemove(id).then(() => {
                wx.hideLoading(); wx.showToast({ title: "已删除", icon: "success" });
                wx.removeStorageSync(CACHE_KEY);
                self.fetchHoldings();
              }).catch(() => {
                wx.hideLoading(); wx.showToast({ title: "删除失败", icon: "none" });
              });
            },
          });
        }
      },
    });
  },

  // ==== 手动盈亏计算 ====
  onCalcPriceInput(e) { this.setData({ calcPrice: e.detail.value }); },
  onDoCalc() {
    const { calcShares, calcCost, calcPrice } = this.data;
    const shares = parseFloat(calcShares);
    const cost = parseFloat(calcCost);
    const price = parseFloat(calcPrice);
    if (!price || price <= 0) { wx.showToast({ title: "请输入有效价格", icon: "none" }); return; }
    const currentValue = shares * price;
    const profit = currentValue - cost;
    const profitRate = cost > 0 ? ((profit / cost) * 100).toFixed(2) : "0.00";
    this.setData({
      calcResult: {
        currentValue: currentValue.toFixed(2),
        profit: profit.toFixed(2),
        profitRate,
        isUp: profit >= 0,
      },
    });
  },
  onCloseCalc() { this.setData({ showCalc: false, calcResult: null }); },

  // ==== 批量操作 ====
  onToggleBatch() {
    const enter = !this.data.batchMode;
    const list = this.data.displayHoldings.map(h => Object.assign({}, h, { _checked: false }));
    this.setData({ batchMode: enter, displayHoldings: list, selectedCount: 0, allSelected: false });
  },
  onToggleBatchSelect(e) {
    const idx = e.currentTarget.dataset.index;
    const list = this.data.displayHoldings.concat();
    list[idx]._checked = !list[idx]._checked;
    this.setData({ displayHoldings: list, selectedCount: list.filter(h => h._checked).length });
  },
  onSelectAll() {
    const allSel = !this.data.allSelected;
    const list = this.data.displayHoldings.map(h => Object.assign({}, h, { _checked: allSel }));
    this.setData({ displayHoldings: list, selectedCount: allSel ? list.length : 0, allSelected: allSel });
  },
  async onBatchDelete() {
    const selected = this.data.displayHoldings.filter(h => h._checked);
    if (selected.length === 0) { wx.showToast({ title: "请先选择", icon: "none" }); return; }
    wx.showModal({
      title: "批量删除", content: `确定删除 ${selected.length} 个记录吗？`,
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
        wx.removeStorageSync(CACHE_KEY);
        this.fetchHoldings();
      },
    });
  },

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  noop() {},
});
