const api = require("../../utils/api");

const CACHE_KEY = "watchlist_cache";
const GROUPS_CACHE_KEY = "watchlist_groups_cache";

Page({
  data: {
    theme: "red",
    watchlist: [],
    displayList: [],
    loaded: false,
    groups: [],
    activeGroup: "all",
    groupCounts: {},
    batchMode: false,
    selectedCount: 0,
    allSelected: false,
    // 添加弹窗
    showAdd: false,
    addCode: "",
    addName: "",
    // 分组选择
    showGroupPicker: false,
    groupPickerCodes: [],
  },

  onShow() {
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    const cachedGroups = this._getCachedGroups();
    if (cachedGroups.length && !this.data.groups.length) {
      this.setData({ groups: cachedGroups });
    }
    this.fetchWatchlist();
  },

  async fetchWatchlist() {
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.list) {
        this.setData({ watchlist: cached.list, loaded: true });
        this.applyFilter();
        this.updateGroupCounts();
      }
      const res = await api.watchlistList();
      if (res.result && res.result.code === 0) {
        const list = (res.result.data || []).map(w => ({
          _id: w._id, fundCode: w.fundCode, fundName: w.fundName, group: w.group || "",
        }));
        this.setData({ watchlist: list, loaded: true });
        this.applyFilter();
        this.updateGroupCounts();
        wx.setStorage({ key: CACHE_KEY, data: { list, ts: Date.now() } });
        if (res.result.groups) this.setData({ groups: res.result.groups });
      }
    } catch (e) {
      if (!this.data.loaded) this.setData({ loaded: true });
      console.error("获取自选失败:", e);
    }
  },

  // ==== 分组 ====
  applyFilter() {
    const { watchlist, activeGroup } = this.data;
    let list = watchlist;
    if (activeGroup !== "all") {
      list = activeGroup === "ungrouped"
        ? watchlist.filter(w => !w.group)
        : watchlist.filter(w => w.group === activeGroup);
    }
    this.setData({ displayList: list });
  },

  updateGroupCounts() {
    const { watchlist, groups } = this.data;
    const counts = { all: watchlist.length, ungrouped: watchlist.filter(w => !w.group).length };
    for (const w of watchlist) {
      if (w.group) counts[w.group] = (counts[w.group] || 0) + 1;
    }
    const merged = this._getCachedGroups().concat();
    for (const g of groups) { if (!merged.includes(g)) merged.push(g); }
    this.setData({ groupCounts: counts, groups: merged });
  },

  onGroupTap(e) {
    const group = e.currentTarget.dataset.group;
    if (group === this.data.activeGroup) return;
    this.setData({ activeGroup: group }, () => this.applyFilter());
  },

  onAddGroup() {
    this._showGroupInput(name => {
      this._saveGroupToCache(name);
      this.updateGroupCounts();
      wx.showToast({ title: `分组「${name}」已创建`, icon: "success" });
    });
  },

  _showGroupInput(cb) {
    wx.showModal({
      title: "新建分组", editable: true, placeholderText: "输入分组名称", content: "",
      success: res => {
        if (!res.confirm || !res.content) return;
        const name = res.content.trim().slice(0, 20);
        if (!name || name === "all" || name === "ungrouped") return;
        cb(name);
      },
    });
  },

  _getCachedGroups() { try { return wx.getStorageSync(GROUPS_CACHE_KEY) || []; } catch (e) { return []; } },
  _saveGroupToCache(name) {
    const cached = this._getCachedGroups();
    if (!cached.includes(name)) { cached.push(name); wx.setStorageSync(GROUPS_CACHE_KEY, cached); }
  },

  // ==== 添加 ====
  onShowAdd() { this.setData({ showAdd: true, addCode: "", addName: "" }); },
  onCloseAdd() { this.setData({ showAdd: false }); },
  onAddCodeInput(e) { this.setData({ addCode: e.detail.value }); },
  onAddNameInput(e) { this.setData({ addName: e.detail.value }); },
  async onConfirmAdd() {
    const { addCode, addName } = this.data;
    if (!addCode.trim()) { wx.showToast({ title: "请输入产品代码", icon: "none" }); return; }
    if (!addName.trim()) { wx.showToast({ title: "请输入产品名称", icon: "none" }); return; }
    try {
      const res = await api.watchlistAdd(addCode.trim(), addName.trim());
      if (res.result && res.result.code === 0) {
        wx.showToast({ title: "已添加", icon: "success" });
        this.setData({ showAdd: false });
        wx.removeStorageSync(CACHE_KEY);
        this.fetchWatchlist();
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "添加失败", icon: "none" });
      }
    } catch (e) { wx.showToast({ title: "网络错误", icon: "none" }); }
  },

  // ==== 删除 ====
  onDeleteItem(e) {
    const { code } = e.currentTarget.dataset;
    const w = this.data.watchlist.find(x => x.fundCode === code);
    if (!w) return;
    wx.showModal({
      title: "移除关注", content: `确定移除「${w.fundName}」吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.watchlistRemove(code);
          wx.showToast({ title: "已移除", icon: "success" });
          wx.removeStorageSync(CACHE_KEY);
          this.fetchWatchlist();
        } catch (e) { wx.showToast({ title: "移除失败", icon: "none" }); }
      },
    });
  },

  // ==== 移动分组 ====
  onMoveGroup(e) {
    const { code } = e.currentTarget.dataset;
    this.setData({ showGroupPicker: true, groupPickerCodes: [code] });
  },
  onCloseGroupPicker() { this.setData({ showGroupPicker: false }); },
  onPickGroup(e) {
    const group = e.currentTarget.dataset.group;
    this._doMoveGroup(group);
  },
  onPickNewGroup() {
    this._showGroupInput(name => {
      this._saveGroupToCache(name);
      this._doMoveGroup(name);
    });
  },
  async _doMoveGroup(group) {
    const codes = this.data.groupPickerCodes;
    try {
      const res = await api.watchlistSetGroup(codes, group);
      if (res.result && res.result.code === 0) {
        wx.showToast({ title: "已移动", icon: "success" });
        this.setData({ showGroupPicker: false });
        wx.removeStorageSync(CACHE_KEY);
        this.fetchWatchlist();
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "操作失败", icon: "none" });
      }
    } catch (e) { wx.showToast({ title: "网络错误", icon: "none" }); }
  },

  // ==== 批量 ====
  onToggleBatch() {
    const enter = !this.data.batchMode;
    const list = this.data.displayList.map(w => Object.assign({}, w, { _checked: false }));
    this.setData({ batchMode: enter, displayList: list, selectedCount: 0, allSelected: false });
  },
  onToggleSelect(e) {
    const idx = e.currentTarget.dataset.index;
    const list = this.data.displayList.concat();
    list[idx]._checked = !list[idx]._checked;
    this.setData({ displayList: list, selectedCount: list.filter(w => w._checked).length });
  },
  onSelectAll() {
    const allSel = !this.data.allSelected;
    const list = this.data.displayList.map(w => Object.assign({}, w, { _checked: allSel }));
    this.setData({ displayList: list, selectedCount: allSel ? list.length : 0, allSelected: allSel });
  },
  async onBatchDelete() {
    const selected = this.data.displayList.filter(w => w._checked);
    if (selected.length === 0) { wx.showToast({ title: "请先选择", icon: "none" }); return; }
    wx.showModal({
      title: "批量移除", content: `确定移除 ${selected.length} 个自选吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "移除中..." });
        let done = 0;
        for (const w of selected) {
          try { await api.watchlistRemove(w.fundCode); done++; } catch (e) { /* ignore */ }
        }
        wx.hideLoading();
        wx.showToast({ title: `已移除 ${done} 个`, icon: "success" });
        this.setData({ batchMode: false });
        wx.removeStorageSync(CACHE_KEY);
        this.fetchWatchlist();
      },
    });
  },
  onBatchMoveGroup() {
    const selected = this.data.displayList.filter(w => w._checked);
    if (selected.length === 0) { wx.showToast({ title: "请先选择", icon: "none" }); return; }
    this.setData({ showGroupPicker: true, groupPickerCodes: selected.map(w => w.fundCode) });
  },

  noop() {},
});
