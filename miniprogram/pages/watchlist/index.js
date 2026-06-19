const api = require("../../utils/api");

const CACHE_KEY = "watchlist_cache";
const GROUPS_CACHE_KEY = "watchlist_groups_cache";
const PINNED_KEY = "watchlist_pinned";
const POLL_INTERVAL = 10000;

// 交易时段判断
function isTradingTime() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const h = now.getHours(), m = now.getMinutes();
  const t = h * 60 + m;
  return t >= 570 && t <= 900; // 9:30-15:00
}

Page({
  data: {
    watchlist: [],
    displayList: [],
    loaded: false,
    loadError: false,
    batchMode: false,
    checkedMap: {},
    groups: [],
    activeGroup: "all",
    holdingCodes: [],
    // 拖拽排序
    dragging: false,
    dragIndex: -1,
    dragX: 0,
    _dragStartX: 0,
    _dragStartIdx: -1,
    _dragTimer: null,
    _didLongPress: false,
    _tabWidth: 0,
    groupCounts: {},
    sortField: "",
    sortOrder: "",
    searchKeyword: "",
    updateTime: "",
    summary: { avg: 0, up: 0, down: 0, total: 0 },
    pinnedCodes: [],
    hotFunds: [
      { code: "005827", name: "易方达蓝筹精选混合" },
      { code: "161725", name: "招商中证白酒指数(LOF)A" },
      { code: "003095", name: "中欧医疗健康混合A" },
      { code: "320007", name: "诺安成长混合" },
      { code: "110011", name: "易方达中小盘混合" },
    ],
    // 左滑删除
    _swiping: false,
    _swipeIdx: -1,
    _swipeX: 0,
    _swipeStartX: 0,
    _swipeStartY: 0,
  },

  applyGroupFilter() {
    const { watchlist, activeGroup, holdingCodes, checkedMap, sortField, sortOrder, searchKeyword } = this.data;
    let list;
    if (activeGroup === "all") list = watchlist;
    else if (activeGroup === "holding") list = watchlist.filter(w => holdingCodes.includes(w.fundCode));
    else if (activeGroup === "ungrouped") list = watchlist.filter(w => !w.group && !holdingCodes.includes(w.fundCode));
    else list = watchlist.filter(w => w.group === activeGroup);

    // 搜索筛选
    const kw = searchKeyword.trim().toLowerCase();
    if (kw) {
      list = list.filter(w =>
        w.fundName.toLowerCase().includes(kw) || w.fundCode.includes(kw)
      );
    }

    // 排序
    if (sortField === "change") {
      list = [...list].sort((a, b) => {
        const va = a.displayChangeRate != null ? a.displayChangeRate : -999;
        const vb = b.displayChangeRate != null ? b.displayChangeRate : -999;
        return sortOrder === "asc" ? va - vb : vb - va;
      });
    } else if (sortField === "name") {
      list = [...list].sort((a, b) => a.fundName.localeCompare(b.fundName, "zh"));
    }

    // 置顶优先
    const { pinnedCodes } = this.data;
    if (pinnedCodes.length) {
      const pinned = list.filter(w => pinnedCodes.includes(w.fundCode));
      const rest = list.filter(w => !pinnedCodes.includes(w.fundCode));
      list = [...pinned, ...rest];
    }

    // 勾选状态
    list = list.map(w => ({ ...w, _checked: !!checkedMap[w.fundCode], _isPinned: pinnedCodes.includes(w.fundCode) }));
    this.setData({ displayList: list });
  },

  // 仅在数据变更时更新分组数量（不在每次筛选/排序时重算）
  updateGroupCounts() {
    const { watchlist, holdingCodes } = this.data;
    const counts = { all: watchlist.length, holding: 0, ungrouped: 0 };
    let up = 0, down = 0, sum = 0, valid = 0;
    for (const w of watchlist) {
      if (holdingCodes.includes(w.fundCode)) counts.holding++;
      if (!w.group && !holdingCodes.includes(w.fundCode)) counts.ungrouped++;
      if (w.group) counts[w.group] = (counts[w.group] || 0) + 1;
      if (w.displayChangeRate != null) {
        sum += w.displayChangeRate;
        valid++;
        if (w.displayChangeRate > 0) up++;
        else if (w.displayChangeRate < 0) down++;
      }
    }
    this.setData({
      groupCounts: counts,
      summary: { avg: valid ? +(sum / valid).toFixed(2) : 0, up, down, total: valid },
    });
  },

  onLoad() {
    this.applyCache();
    this.setData({ pinnedCodes: this._getPinnedCodes() });
  },

  onShow() {
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.fetchWatchlist();
      this._startPolling();
    } else {
      this.setData({
        watchlist: [], displayList: [], loaded: true, groups: [], activeGroup: "all",
        checkedMap: {}, sortField: "", sortOrder: "", searchKeyword: "", updateTime: "",
        holdingCodes: [], groupCounts: {}, summary: { avg: 0, up: 0, down: 0, total: 0 },
      });
      wx.removeStorageSync(CACHE_KEY);
    }
  },

  onHide() {
    this._stopPolling();
  },

  onUnload() {
    this._stopPolling();
  },

  onPullDownRefresh() {
    this.setData({ searchKeyword: "" });
    this.fetchWatchlist().finally(() => wx.stopPullDownRefresh());
  },

  // ========== 列表交互 ==========

  onTapItem(e) {
    if (this.data.batchMode) {
      this.toggleSelect(e);
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onSearch() {
    const kw = this.data.searchKeyword;
    if (kw) {
      wx.navigateTo({ url: `/pages/search/index?keyword=${encodeURIComponent(kw)}` });
    } else {
      wx.navigateTo({ url: "/pages/search/index" });
    }
  },

  onTapHotFund(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name)}` });
  },

  onLongPressItem(e) {
    if (this.data.batchMode) return;
    const { code, name } = e.currentTarget.dataset;
    const { activeGroup } = this.data;
    const itemList = ["删除自选", "移动到分组"];
    const pinned = this.data.pinnedCodes.includes(code);
    itemList.push(pinned ? "取消置顶" : "置顶");
    if (activeGroup !== "all" && activeGroup !== "holding" && activeGroup !== "ungrouped") {
      itemList.push("移出分组");
    }
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const action = itemList[res.tapIndex];
        if (action === "删除自选") {
          wx.showModal({
            title: "删除自选",
            content: `确定要删除 ${name}(${code}) 吗？`,
            success: async (r) => {
              if (!r.confirm) return;
              try {
                await api.watchlistRemove(code);
                wx.showToast({ title: "已删除", icon: "success" });
                this.fetchWatchlist();
              } catch (e) {
                wx.showToast({ title: "删除失败", icon: "none" });
              }
            },
          });
        } else if (action === "移动到分组") {
          this.moveFundsToGroup([code], name);
        } else if (action === "置顶" || action === "取消置顶") {
          this.togglePin(code);
        } else if (action === "移出分组") {
          this.doMoveToGroup([code], "");
        }
      },
    });
  },

  // ========== 批量操作 ==========

  onToggleBatch() {
    const enter = !this.data.batchMode;
    this.setData({ batchMode: enter, checkedMap: {} });
  },

  toggleSelect(e) {
    const code = e.currentTarget.dataset.code;
    const map = { ...this.data.checkedMap };
    if (map[code]) delete map[code];
    else map[code] = true;
    this.setData({ checkedMap: map }, () => this.applyGroupFilter());
  },

  onSelectAll() {
    const allChecked = this.data.displayList.every(w => this.data.checkedMap[w.fundCode]);
    if (allChecked) {
      this.setData({ checkedMap: {} }, () => this.applyGroupFilter());
    } else {
      const map = {};
      this.data.displayList.forEach(w => { map[w.fundCode] = true; });
      this.setData({ checkedMap: map }, () => this.applyGroupFilter());
    }
  },

  async onBatchDelete() {
    const codes = Object.keys(this.data.checkedMap);
    if (codes.length === 0) {
      wx.showToast({ title: "请先选择基金", icon: "none" });
      return;
    }
    wx.showModal({
      title: "批量删除",
      content: `确定删除选中的 ${codes.length} 个自选基金吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: "删除中..." });
        let count = 0;
        for (const code of codes) {
          try {
            await api.watchlistRemove(code);
            count++;
          } catch (e) { /* ignore */ }
        }
        wx.hideLoading();
        wx.showToast({ title: `已删除 ${count} 个`, icon: "success" });
        this.setData({ batchMode: false, checkedMap: {} });
        this.fetchWatchlist();
      },
    });
  },

  onBatchMoveToGroup() {
    const codes = Object.keys(this.data.checkedMap);
    if (codes.length === 0) {
      wx.showToast({ title: "请先选择基金", icon: "none" });
      return;
    }
    this.moveFundsToGroup(codes);
  },

  moveFundsToGroup(codes, hintName) {
    const { groups } = this.data;
    const itemList = [...groups, "未分组", "新建分组"];
    wx.showActionSheet({
      itemList,
      success: (res) => {
        const group = itemList[res.tapIndex];
        if (group === "未分组") {
          this.doMoveToGroup(codes, "");
        } else if (group === "新建分组") {
          this.showGroupInput(groupName => {
            this._saveGroupToCache(groupName);
            this.doMoveToGroup(codes, groupName);
          });
        } else {
          this.doMoveToGroup(codes, group);
        }
      },
    });
  },

  _saveGroupToCache(groupName) {
    const cached = this._getCachedGroups();
    if (!cached.includes(groupName)) {
      cached.push(groupName);
      wx.setStorageSync(GROUPS_CACHE_KEY, cached);
    }
    const merged = this._mergeGroups(this.data.groups);
    if (!merged.includes(groupName)) merged.push(groupName);
    this.setData({ groups: merged, activeGroup: groupName });
  },

  async doMoveToGroup(codes, group) {
    try {
      const res = await api.watchlistSetGroup(codes, group);
      if (res.result && res.result.code === 0) {
        wx.showToast({ title: "已移动", icon: "success" });
        this.setData({ batchMode: false, checkedMap: {} });
        this.fetchWatchlist();
      } else {
        wx.showToast({ title: res.result?.msg || "操作失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "网络错误", icon: "none" });
    }
  },

  // ========== 分组标签 ==========

  onAddToGroup() {
    this.setData({ activeGroup: "all", batchMode: true, checkedMap: {} }, () => this.applyGroupFilter());
  },

  onGroupTap(e) {
    // 长按操作期间忽略短按，避免菜单+切换同时触发
    if (this._didLongPress || this._dragMoved) return;
    const group = e.currentTarget.dataset.group;
    if (group === this.data.activeGroup) return;
    this.setData({ activeGroup: group }, () => this.applyGroupFilter());
  },

  onAddGroup() {
    this.showGroupInput((groupName) => {
      wx.showToast({ title: `分组「${groupName}」已创建`, icon: "success", duration: 2000 });
      this._saveGroupToCache(groupName);
      this.applyGroupFilter();
      setTimeout(() => {
        wx.showToast({ title: "长按基金可移入分组", icon: "none", duration: 2000 });
      }, 2200);
    });
  },

  // ========== 拖拽排序 ==========

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
      return;
    }
    // 长按未拖拽 → 弹出菜单
    if (this._didLongPress) {
      const group = e.currentTarget.dataset.group;
      if (group && group !== "all" && group !== "ungrouped" && group !== "holding") {
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
        const newName = res.content.trim().slice(0, 20);
        if (!newName || newName === oldName) return;
        try {
          await api.watchlistRenameGroup(oldName, newName);
          // 同步本地缓存
          const cached = this._getCachedGroups();
          const idx = cached.indexOf(oldName);
          if (idx >= 0) cached[idx] = newName;
          else if (!cached.includes(newName)) cached.push(newName);
          wx.setStorageSync(GROUPS_CACHE_KEY, cached);
          // 立即更新本地 groups
          const idx2 = this.data.groups.indexOf(oldName);
          if (idx2 >= 0) {
            const gs = [...this.data.groups];
            gs[idx2] = newName;
            this.setData({ groups: gs });
          }
          if (this.data.activeGroup === oldName) {
            this.setData({ activeGroup: newName });
          }
          wx.showToast({ title: "已重命名", icon: "success" });
          this.fetchWatchlist();
        } catch (e) {
          wx.showToast({ title: "重命名失败", icon: "none" });
        }
      },
    });
  },

  deleteGroup(group) {
    wx.showModal({
      title: "删除分组",
      content: `确定删除「${group}」分组吗？组内基金将变为「未分组」`,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.watchlistDeleteGroup(group);
          // 同步本地缓存
          const cached = this._getCachedGroups().filter(g => g !== group);
          wx.setStorageSync(GROUPS_CACHE_KEY, cached);
          if (this.data.activeGroup === group) {
            this.setData({ activeGroup: "all" });
          }
          wx.showToast({ title: "已删除", icon: "success" });
          this.fetchWatchlist();
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
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
        if (name) callback(name);
      },
    });
  },

  // ========== 数据加载 ==========

  applyCache() {
    const userInfo = wx.getStorageSync("userInfo");
    if (!userInfo || !userInfo.loggedIn) return;
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.watchlist && cached.watchlist.length > 0) {
        this.setData({ watchlist: cached.watchlist, loaded: true }, () => {
          this.applyGroupFilter();
          this.updateGroupCounts();
        });
      }
      // 恢复缓存的分组
      const cachedGroups = this._getCachedGroups();
      if (cachedGroups.length && !this.data.groups.length) {
        this.setData({ groups: cachedGroups });
      }
    } catch (e) {
      // ignore cache error
    }
  },

  _getCachedGroups() {
    try {
      return wx.getStorageSync(GROUPS_CACHE_KEY) || [];
    } catch (e) {
      return [];
    }
  },

  _mergeGroups(serverGroups) {
    const cached = this._getCachedGroups();
    // 以缓存顺序为基础，合并服务端新增的分组（追加到末尾）
    const merged = [...cached];
    for (const g of serverGroups) {
      if (!merged.includes(g)) merged.push(g);
    }
    // 清理缓存中已在服务端存在的分组
    const toKeep = cached.filter(g => !serverGroups.includes(g));
    if (toKeep.length !== cached.length) {
      wx.setStorageSync(GROUPS_CACHE_KEY, toKeep);
    }
    return merged;
  },

  async fetchWatchlist() {
    try {
      const [listRes, groupsRes] = await Promise.all([
        api.watchlistList(),
        api.watchlistGetGroups().catch(() => ({ result: { code: 0, data: [] } })),
      ]);

      // 拉取持仓代码（用于「持有的」分组）
      this._fetchHoldingCodes().catch(() => {});

      // 处理分组列表（合并服务端 + 本地缓存）
      let serverGroups = [];
      if (groupsRes.result && groupsRes.result.code === 0) {
        serverGroups = groupsRes.result.data || [];
      }
      const groups = this._mergeGroups(serverGroups);
      this.setData({ groups });

      if (listRes.result && listRes.result.code === 0 && listRes.result.data.length > 0) {
        const items = listRes.result.data;
        const codes = items.map((w) => w.fundCode);
        const estRes = await api.batchFetchEstimate(codes).catch(() => null);
        const estData = (estRes && estRes.result && estRes.result.code === 0 && estRes.result.data) || {};

        const watchlist = items.map((w) => {
          const e = estData[w.fundCode];
          return {
            fundCode: w.fundCode,
            fundName: w.fundName,
            group: w.group || "",
            nav: e ? e.nav : null,
            estimatedNav: e ? e.estimatedNav : null,
            estimatedChangeRate: e ? e.estimatedChangeRate : null,
            displayChangeRate: e ? e.displayChangeRate : null,
            estimateTime: e ? e.estimateTime : null,
          };
        });
        // 使用估算数据中的实际时间
        const updateTime = items.reduce((best, w) => {
          const e = estData[w.fundCode];
          return (e && e.estimateTime) || best;
        }, "") || this._nowStr();

        this.setData({ watchlist, loaded: true, loadError: false, updateTime }, () => {
          this.applyGroupFilter();
          this.updateGroupCounts();
        });

        try {
          wx.setStorageSync(CACHE_KEY, { watchlist, groups, time: Date.now() });
        } catch (e) {
          // ignore cache error
        }
      } else {
        this.setData({ watchlist: [], displayList: [], loaded: true, loadError: false });
      }
    } catch (e) {
      this.setData({ loaded: true, loadError: !this.data.watchlist.length });
    }
  },

  onRetry() {
    this.setData({ loaded: false, loadError: false });
    this.fetchWatchlist();
  },

  // ========== 轮询刷新 ==========

  _startPolling() {
    this._stopPolling();
    if (!isTradingTime()) return;
    this._pollTimer = setInterval(() => {
      if (!isTradingTime()) { this._stopPolling(); return; }
      this._refreshEstimates();
    }, POLL_INTERVAL);
  },

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  async _refreshEstimates() {
    const codes = this.data.watchlist.map(w => w.fundCode);
    if (!codes.length) return;
    try {
      const estRes = await api.batchFetchEstimate(codes);
      if (!estRes || !estRes.result || estRes.result.code !== 0) return;
      const estData = estRes.result.data || {};
      const watchlist = this.data.watchlist.map(w => {
        const e = estData[w.fundCode];
        if (!e) return w;
        return {
          ...w,
          nav: e.nav || w.nav,
          estimatedNav: e.estimatedNav || w.estimatedNav,
          estimatedChangeRate: e.estimatedChangeRate != null ? e.estimatedChangeRate : w.estimatedChangeRate,
          displayChangeRate: e.displayChangeRate != null ? e.displayChangeRate : w.displayChangeRate,
          estimateTime: e.estimateTime || w.estimateTime,
        };
      });
      // 取最新估算时间
      const updateTime = codes.reduce((best, c) => {
        const e = estData[c];
        return (e && e.estimateTime) || best;
      }, "") || this._nowStr();
      this.setData({ watchlist, updateTime }, () => {
        this.applyGroupFilter();
        this.updateGroupCounts();
      });
    } catch (e) { /* 静默 */ }
  },

  // ========== 置顶 ==========

  _getPinnedCodes() {
    try { return wx.getStorageSync(PINNED_KEY) || []; } catch (e) { return []; }
  },

  togglePin(code) {
    let pinned = this._getPinnedCodes();
    const idx = pinned.indexOf(code);
    if (idx >= 0) pinned.splice(idx, 1);
    else pinned.push(code);
    wx.setStorageSync(PINNED_KEY, pinned);
    this.setData({ pinnedCodes: pinned }, () => this.applyGroupFilter());
    wx.showToast({ title: idx >= 0 ? "已取消置顶" : "已置顶", icon: "success", duration: 1000 });
  },

  // ========== 左滑删除 ==========

  onItemTouchStart(e) {
    if (this.data.batchMode || this.data.dragging) return;
    // 先关闭其他打开的滑动
    if (this.data._swipeIdx >= 0) {
      this.setData({ _swipeIdx: -1, _swipeX: 0 });
    }
    const touch = e.touches[0];
    this._swipeStartX = touch.clientX;
    this._swipeStartY = touch.clientY;
    this._swiping = true;
  },

  onItemTouchMove(e) {
    if (!this._swiping) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    const dx = x - this._swipeStartX;
    const dy = Math.abs(y - this._swipeStartY);
    // 竖向移动 > 横向 → 普通滚动，取消滑动
    if (dy > Math.abs(dx)) { this._swiping = false; return; }
    if (dx > 0) return; // 只允许左滑
    const idx = parseInt(e.currentTarget.dataset.index);
    this.setData({ _swipeIdx: idx, _swipeX: Math.max(dx, -120) });
  },

  onItemTouchEnd(e) {
    this._swiping = false;
    const { _swipeIdx, _swipeX } = this.data;
    if (_swipeIdx < 0) return;
    if (_swipeX < -60) {
      // 保持展开
      this.setData({ _swipeX: -120 });
    } else {
      // 收回
      this.setData({ _swipeIdx: -1, _swipeX: 0 });
    }
  },

  onSwipeDelete(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name;
    wx.showModal({
      title: "删除自选",
      content: `确定删除 ${name}(${code}) 吗？`,
      success: async (res) => {
        if (!res.confirm) {
          this.setData({ _swipeIdx: -1, _swipeX: 0 });
          return;
        }
        try {
          await api.watchlistRemove(code);
          wx.showToast({ title: "已删除", icon: "success" });
          this.setData({ _swipeIdx: -1, _swipeX: 0 });
          this.fetchWatchlist();
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },

  onSortTap() {
    const { sortField, sortOrder } = this.data;
    // 循环切换: 默认 → 涨跌↓ → 涨跌↑ → 名称
    let nextField = "", nextOrder = "";
    if (!sortField) { nextField = "change"; nextOrder = "desc"; }
    else if (sortField === "change" && sortOrder === "desc") { nextField = "change"; nextOrder = "asc"; }
    else if (sortField === "change" && sortOrder === "asc") { nextField = "name"; nextOrder = ""; }
    this.setData({ sortField: nextField, sortOrder: nextOrder }, () => this.applyGroupFilter());
    const labels = { "": "排序", "change_desc": "涨跌↓", "change_asc": "涨跌↑", "name": "名称" };
    const key = nextField ? `${nextField}${nextOrder ? '_' + nextOrder : ''}` : "";
    wx.showToast({ title: labels[key] || "默认", icon: "none", duration: 1000 });
  },

  onSearchInput(e) {
    clearTimeout(this._searchTimer);
    const val = e.detail.value;
    this.setData({ searchKeyword: val });
    this._searchTimer = setTimeout(() => {
      this.applyGroupFilter();
    }, 200);
  },

  onClearSearch() {
    clearTimeout(this._searchTimer);
    this.setData({ searchKeyword: "" }, () => this.applyGroupFilter());
  },

  _nowStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  },

  _holdingCacheTime: 0,
  async _fetchHoldingCodes() {
    if (Date.now() - this._holdingCacheTime < 60000) return;
    try {
      const db = wx.cloud.database();
      const res = await db.collection("holdings").field({ fundCode: true }).get();
      const codes = (res.data || []).map(h => h.fundCode).filter(Boolean);
      this._holdingCacheTime = Date.now();
      this.setData({ holdingCodes: codes }, () => {
        this.updateGroupCounts();
        if (this.data.activeGroup === "holding") this.applyGroupFilter();
      });
    } catch (e) {
      // 静默失败，不影响主流程
    }
  },
});
