const api = require("../../utils/api");
const marketTime = require("../../utils/market-time");
const track = require("../../utils/track");

const CACHE_KEY = "watchlist_cache";
const GROUPS_CACHE_KEY = "watchlist_groups_cache";
const PINNED_KEY = "watchlist_pinned";
const POLL_INTERVAL = 30000;  // 盘中轮询间隔 30 秒（原 10 秒，每次调用含多只基金的外部请求）

// 交易时段判断
function isTradingTime() {
  // 交易日时钟（含节假日表）：交易日 9:25~15:00 视作盘中（含集合竞价段），午休不轮询
  return marketTime.marketPhase() === "trading" && !marketTime.isLunchBreak();
}

// 涨跌幅展示串：固定两位小数（0.8 → +0.80%），服务端已归一到两位数值，
// 但 Number 会丢掉末尾 0，所以显示文本必须在 JS 里算好（WXML 不能调方法）
function rateText(v) {
  if (v == null || v === "") return "--";
  const n = parseFloat(v);
  if (!isFinite(n)) return "--";
  if (Math.abs(n) < 0.005) return "0.00%";
  return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
}

Page({
  data: {
    watchlist: [],
    displayList: [],
    // 温度异动摘要（null=未加载/无异动，条子不渲染）
    tempMoves: null,
    tempStripHidden: false,
    tempSignalMap: {},
    // 区间收益表（添加后/近1周/近1月/近3月/近6月/近3年/近5年/成立来，服务端算好展示串）
    perfMap: {},
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
    stale: false,
    summary: { avg: 0, up: 0, down: 0, total: 0 },
	    pinnedCodes: [],
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
    const PERF_SORT_KEYS = ["added", "w1", "m1", "m3", "m6", "y3", "y5", "incept"];
    if (sortField === "change") {
      list = [...list].sort((a, b) => {
        const va = a.displayChangeRate != null ? a.displayChangeRate : -999;
        const vb = b.displayChangeRate != null ? b.displayChangeRate : -999;
        return sortOrder === "asc" ? va - vb : vb - va;
      });
    } else if (sortField === "name") {
      list = [...list].sort((a, b) => a.fundName.localeCompare(b.fundName, "zh"));
    } else if (PERF_SORT_KEYS.includes(sortField)) {
      const pv = (w) => {
        const s = this.data.perfMap[w.fundCode];
        const v = s ? s[sortField] : null;
        return typeof v === "number" && isFinite(v) ? v : -Infinity;
      };
      list = [...list].sort((a, b) => {
        const va = pv(a), vb = pv(b);
        return sortOrder === "asc" ? va - vb : vb - va; // -Infinity 恒沉底
      });
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
  // 统一统计入口（合并此前 updateGroupCounts 与轮询路径的两份循环）。
  // counts = tab 角标（全量口径）；summary = 汇总条（跟随可见列表，
  // total = 可见只数而非有涨跌值的只数，修掉估值缺失时显示"0只自选"的假象）
  _statsFrom(list, allWatchlist) {
    const { holdingCodes } = this.data;
    const counts = { all: allWatchlist.length, holding: 0, ungrouped: 0 };
    for (const w of allWatchlist) {
      if (holdingCodes.includes(w.fundCode)) counts.holding++;
      if (!w.group && !holdingCodes.includes(w.fundCode)) counts.ungrouped++;
      if (w.group) counts[w.group] = (counts[w.group] || 0) + 1;
    }
    let up = 0, down = 0, sum = 0, valid = 0;
    for (const w of list) {
      if (w.displayChangeRate != null) {
        sum += w.displayChangeRate;
        valid++;
        if (w.displayChangeRate > 0) up++;
        else if (w.displayChangeRate < 0) down++;
      }
    }
    return {
      counts,
      summary: { avg: valid ? +(sum / valid).toFixed(2) : 0, up, down, total: list.length },
    };
  },

  // 重算 tab 角标 + 汇总条：先按当前分组/搜索/排序刷新可见列表，再对可见列表统计
  updateGroupCounts() {
    this.applyGroupFilter();
    const { counts, summary } = this._statsFrom(this.data.displayList, this.data.watchlist);
    this.setData({ groupCounts: counts, summary });
  },

  onLoad() {
    try { track.track("page_enter", { page: "watchlist" }); } catch (e) { /* ignore */ }
    this._loadHoldingCodes(); // 先同步读日缓存，首帧即有"持有"角标（不等网络）
    this._loadWatchStats();   // 温度/区间收益日缓存就地套用，首帧即有列
    this.applyCache();
    this.setData({ pinnedCodes: this._getPinnedCodes() });
  },

  // 首次渲染完成后自动调起下拉刷新动画（onShow 已标记需要刷新时）
  onReady() {
    this._ready = true;
  },

  onShow() {
    // 每次显示同步主题色（tab 切换/返回时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this._enterList();
    } else {
      // 打开即用：静默登录（openid 云端直取，无授权弹窗）拿到后按正常流程加载；失败给「加载失败」重试
      getApp().ensureLogin().then((ok) => {
        if (ok) this._enterList();
        else this.setData({ loaded: true, loadError: true });
      });
    }
  },

  _enterList() {
    // 30s 节流 + 交易日时钟：盘中照常自动刷新；盘后净值发布即冻结、周末/节假日全天免拉
    // 过期改静默刷新（转圈动画仅保留用户手动下拉）——30s 轮询已兜实时性
    const now = Date.now();
    const cacheFresh = marketTime.isCacheFresh(this._wlCache, { estimateTtl: 30000 });
    if ((!this._lastFetch || now - this._lastFetch > 30000) && !cacheFresh) {
      this._lastFetch = now;
      this.fetchWatchlist();
    }
    this._startPolling();
  },

  onHide() {
    this._stopPolling();
  },

  onUnload() {
    this._stopPolling();
    // 搜索防抖/拖拽回弹两个短定时器一并清理（页面卸载后空 setData 的隐患）
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
  },

  onPullDownRefresh() {
    // 保留当前搜索词，仅刷新数据
    this._loadWatchStats(true);
    this.fetchWatchlist().finally(() => wx.stopPullDownRefresh());
  },

  // ========== 列表交互 ==========

  onTapItem(e) {
    if (this.data.batchMode) {
      this.toggleSelect(e);
      return;
    }
    // 左滑展开态：首次点击只收回滑块，不跳详情
    if (this.data._swipeIdx >= 0) {
      this.setData({ _swipeIdx: -1, _swipeX: 0 });
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/subpackages/analysis/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onSearch() {
    const kw = this.data.searchKeyword;
    if (kw) {
      wx.navigateTo({ url: `/pages/search/index?keyword=${encodeURIComponent(kw)}` });
    } else {
      wx.navigateTo({ url: "/pages/search/index" });
    }
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
        // 写操作限并发 3，避免 N 条串行云函数调用拖慢批量删除
        const CONCURRENT = 3;
        let ok = 0, fail = 0, idx = 0;
        const workers = [];
        const run = async () => {
          while (idx < codes.length) {
            const code = codes[idx++];
            try {
              const r = await api.watchlistRemove(code);
              // 业务失败（code !== 0）也计入失败数，避免静默吞掉
              if (r && r.result && r.result.code === 0) ok++;
              else fail++;
            } catch (e) { fail++; }
          }
        };
        for (let i = 0; i < Math.min(CONCURRENT, codes.length); i++) workers.push(run());
        await Promise.all(workers);
        wx.hideLoading();
        if (fail > 0) {
          wx.showToast({ title: `成功 ${ok} 个，失败 ${fail} 个`, icon: "none" });
        } else {
          wx.showToast({ title: `已删除 ${ok} 个`, icon: "success" });
        }
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
        wx.showToast({ title: (res.result && res.result.msg) || "操作失败", icon: "none" });
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
      // 合并为单条 toast（原两条连续 toast 会互相覆盖）
      wx.showToast({ title: `已创建分组「${groupName}」，长按基金可移入分组`, icon: "none", duration: 2000 });
      this._saveGroupToCache(groupName);
      this.applyGroupFilter();
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
    this._lastDragTs = 0;
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
      // 高频 touchmove 节流：30ms 内跳过 setData，松手时由 touchend 强制落点
      const now = Date.now();
      if (now - (this._lastDragTs || 0) < 30) return;
      this._lastDragTs = now;
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
      // 开盘后不认隔日缓存：里面的涨跌/估算净值是上一交易日的，顶着"今日"渲染会误导
      // （与首页/走势页/详情页同一守卫；休市相位照认——那本就是最近一份有效数据）
      if (cached && !marketTime.cacheIsToday(cached.ts)) return;
      if (cached && cached.watchlist && cached.watchlist.length > 0) {
        this._wlCache = cached;
        // 旧版本缓存没有 displayChangeRateText（两位数展示串）：读缓存时补齐，避免开页空白
        const cachedList = cached.watchlist.map((w) => (
          w.displayChangeRateText !== undefined ? w : { ...w, displayChangeRateText: rateText(w.displayChangeRate) }
        ));
        // 计数放进 setData 回调：读的必须是落地后的 watchlist（旧写法在 setData 前算，
        // 读到旧数组导致 tab 计数定格全 0）
        this.setData({ watchlist: cachedList, loaded: true }, () => {
          this.updateGroupCounts();
        });
      }
      // 恢复缓存的分组：优先用 watchlist_cache 自带的 groups 快照（fetchWatchlist 写入时
      // 就在载荷里），旧的独立分组键为空（新设备/清缓存）时 tab 不再丢自定义分组
      const cachedGroups = (cached.groups && cached.groups.length) ? cached.groups : this._getCachedGroups();
      if (cachedGroups.length && !this.data.groups.length) {
        this.setData({ groups: cachedGroups });
      }
    } catch (e) {
      // ignore cache error
    }
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

  _mergeGroups(serverGroups) {
    const cached = this._getCachedGroups();
    // 防御：serverGroups 可能是对象数组（取 name）或字符串数组
    const serverNames = [];
    for (const g of (serverGroups || [])) {
      const name = typeof g === 'string' ? g : (g && g.name);
      if (name && !serverNames.includes(name)) serverNames.push(name);
    }
    // 以缓存顺序为基础，合并服务端新增的分组（追加到末尾）
    const merged = [...cached];
    for (const g of serverNames) {
      if (!merged.includes(g)) merged.push(g);
    }
    // 清理缓存中已在服务端存在的分组
    const toKeep = cached.filter(g => !serverNames.includes(g));
    if (toKeep.length !== cached.length) {
      wx.setStorageSync(GROUPS_CACHE_KEY, toKeep);
    }
    return merged;
  },

  async fetchWatchlist() {
    try {
      // 估算预取（2026-10-24 优化）：此前 batchFetchEstimate 串行等 list 返回后再发，
      // 首开多等一整段 RTT（实测冷启动 6s / 热 1.1s）。估算是按 codes 查的，而缓存里就有
      // 上次的 codes——进函数立刻并行发起；list 回来后 codes 一致直接复用，不一致重发。
      const cachedCodes = (this._wlCache && this._wlCache.watchlist || [])
        .map(w => w.fundCode).filter(Boolean);
      const estPromise = cachedCodes.length
        ? api.batchFetchEstimate(cachedCodes).catch(() => null)
        : null;
      // holdingList 与 list/groups 无依赖，三路并行（原串行多一轮 RTT）
      const [listRes, groupsRes] = await Promise.all([
        api.watchlistList(),
        api.watchlistGetGroups().catch(() => ({ result: { code: 0, data: [] } })),
        this._loadHoldingCodes(),
      ]);

      // 处理分组列表（合并服务端 + 本地缓存）
      let serverGroups = [];
      if (groupsRes.result && groupsRes.result.code === 0) {
        serverGroups = groupsRes.result.data || [];
      }
      const groups = this._mergeGroups(serverGroups);
      this.setData({ groups });

      if (listRes.result && listRes.result.code === 0 && ((listRes.result.data || []).length > 0)) {
        const items = listRes.result.data;
        const codes = items.map((w) => w.fundCode);
        let estRes = null;
        if (estPromise) {
          estRes = await estPromise;
          const preCodes = cachedCodes.slice().sort().join(',');
          const curCodes = codes.slice().sort().join(',');
          if (preCodes !== curCodes) estRes = null; // 自选有增删：预取作废重发
        }
        if (!estRes) estRes = await api.batchFetchEstimate(codes).catch(() => null);
        const estData = (estRes && estRes.result && estRes.result.code === 0 && estRes.result.data) || {};

        const watchlist = items.map((w) => {
          const e = estData[w.fundCode];
          return {
            fundCode: w.fundCode,
            fundName: w.fundName,
            group: w.group || "",
            nav: e ? e.nav : null,
            estimatedNav: e ? e.estimatedNav : null,
            displayChangeRate: e ? e.displayChangeRate : null,
            displayChangeRateText: rateText(e ? e.displayChangeRate : null),
            estimateTime: e ? e.estimateTime : null,
          };
        });
        // 使用估算数据中的实际时间。休市/缺 estimateTime 时不兜底当前时间——
        // 那会把"上一交易日的冻结数据"标成"刚刚更新"（2026-10-19 修复）
        const updateTime = items.reduce((best, w) => {
          const e = estData[w.fundCode];
          return (e && e.estimateTime) || best;
        }, "");

        // 计数依赖 this.data.watchlist，必须在 setData 落地后算（旧写法读到旧数组，
        // tab 计数会定格全 0）
        this.setData({ watchlist, loaded: true, loadError: false, updateTime, stale: false }, () => {
          this.updateGroupCounts();
        });
        this._loadWatchStats();

        try {
          // ts/actualDate 供交易日时钟判新鲜度（盘后净值发布即冻结、周末免拉）
          const maxActualDate = items.reduce((m, w) => {
            const ad = estData[w.fundCode] && estData[w.fundCode].actualDate;
            return ad && ad > m ? ad : m;
          }, "");
          this._wlCache = { watchlist, groups, time: Date.now(), ts: Date.now(), actualDate: maxActualDate || undefined };
          wx.setStorageSync(CACHE_KEY, this._wlCache);
        } catch (e) {
          // ignore cache error
        }
      } else {
        this.setData({ watchlist: [], displayList: [], loaded: true, loadError: false, stale: false });
      }
    } catch (e) {
      this.setData({ loaded: true, loadError: !this.data.watchlist.length });
    }
  },


  // 表头列排序：再次点击切换升/降序，切列默认降序（名称列默认升序）
  onColSortTap(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    if (this.data.sortField === field) {
      this.setData({ sortOrder: this.data.sortOrder === "desc" ? "asc" : "desc" }, () => this.applyGroupFilter());
    } else {
      this.setData({ sortField: field, sortOrder: field === "name" ? "asc" : "desc" }, () => this.applyGroupFilter());
    }
  },

  onTempStripClose() {
    wx.setStorageSync("watchlist_temp_moves_dismissed", marketTime.bjDateStr());
    this.setData({ tempStripHidden: true });
  },

  onTempFundTap(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/subpackages/analysis/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || "")}` });
  },

  // ========== 温度异动摘要 + 区间收益表（perf 单请求同时供两块） ==========

  // 温度按天变 + 区间收益按天变：日内走本地缓存，下拉刷新强制重拉；当日首开要等
  // 服务端现场拉全量净值（可能数十秒），超时/失败静默（摘要条不出现、表格列出 --）
  async _loadWatchStats(force) {
    if (this._statsLoading && !force) return; // 防重入：并发调用会重复打东财
    this._statsLoading = true;
    try {
      const today = marketTime.bjDateStr();
      const cached = force ? null : wx.getStorageSync("watchlist_stats_v2");
      if (cached && cached.date === today && cached.funds) {
        this._applyWatchStats(cached);
        return;
      }
      const res = await api.watchlistPerf();
      const d = res && res.result && res.result.code === 0 && res.result.data;
      if (!d || !d.date) return;
      const payload = { date: d.date, funds: d.funds || {}, moves: d.moves || [], signals: d.signals || {} };
      wx.setStorageSync("watchlist_stats_v2", payload);
      this._applyWatchStats(payload);
    } catch (e) { /* 静默 */ }
    finally { this._statsLoading = false; }
  },

  _applyWatchStats(payload) {
    const SIGNAL_CN = { low: "偏低", mid: "适中", high: "偏高" };
    const nameBy = {};
    this.data.watchlist.forEach((w) => { nameBy[w.fundCode] = w.fundName; });
    // 区间表：未覆盖的基金补 "--" 默认值，WXML 免判空
    const perfMap = {};
    Object.entries(payload.funds || {}).forEach(([code, s]) => { perfMap[code] = s; });
    this.data.watchlist.forEach((w) => {
      if (!perfMap[w.fundCode]) {
        perfMap[w.fundCode] = { addedText: "--", w1Text: "--", m1Text: "--", m3Text: "--", m6Text: "--", y3Text: "--", y5Text: "--", inceptText: "--" };
      }
    });
    // 异动摘要：转热（→高温）排前、转冷次之，最多 3 只，其余折成"等N只"
    const moves = payload.moves || [];
    const items = moves
      .slice()
      .sort((a, b) => (a.cur === "high" ? 0 : 1) - (b.cur === "high" ? 0 : 1))
      .slice(0, 3)
      .map((m) => ({
        fundCode: m.fundCode,
        name: nameBy[m.fundCode] || m.fundCode,
        prevText: SIGNAL_CN[m.prev] || m.prev,
        curText: SIGNAL_CN[m.cur] || m.cur,
        cur: m.cur,
      }));
    // 用户当天点过 ✕ 则不再展示（次日有新异动会重新出现）
    const dismissed = wx.getStorageSync("watchlist_temp_moves_dismissed") === marketTime.bjDateStr();
    this.setData({
      perfMap,
      tempSignalMap: payload.signals || {},
      tempStripHidden: dismissed,
      tempMoves: { count: moves.length, items, more: Math.max(0, moves.length - items.length) },
    });
  },

  onRetry() {
    this.setData({ loaded: false, loadError: false });
    this.fetchWatchlist();
  },

  // ========== 轮询刷新 ==========

  _startPolling() {
    this._stopPolling();
    if (!isTradingTime()) { this._startPhaseWatch(); return; }
    this._pollTimer = setInterval(() => {
      // 退出轮询时把相位监听接回去（_stopPolling 会连相位定时器一起清），
      // 否则 11:30 午休这一次退出之后整个下午没人再拉起刷新
      if (!isTradingTime()) { this._stopPolling(); this._startPhaseWatch(); return; }
      this._refreshEstimates();
    }, POLL_INTERVAL);
  },

  // 非交易时段只盯相位（本地判断）：9:25/13:00 到点自动重载，页面开着也会切到今日估值
  _startPhaseWatch() {
    this._stopPhaseWatch();
    this._phaseTimer = setInterval(() => {
      if (!isTradingTime()) return;
      this._stopPhaseWatch();
      this.fetchWatchlist();
      this._startPolling();   // 起回盘中轮询（_startPolling 内部会先清定时器）
    }, 30000);
  },

  _stopPhaseWatch() {
    if (this._phaseTimer) { clearInterval(this._phaseTimer); this._phaseTimer = null; }
  },

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._stopPhaseWatch();
  },

  async _refreshEstimates() {
    if (this._estFetching) return; // 防重入（手动重试可与在途轮询并发）
    const codes = this.data.watchlist.map(w => w.fundCode);
    // 空列表先行返回且不置位（旧写法先置位再 return，自选清空场景标志永久不复位，
    // 轮询与"更新失败"重试全部静默失效）
    if (!codes.length) return;
    this._estFetching = true;
    const markStale = () => { if (this.data.watchlist.length) this.setData({ stale: true }); };
    try {
      const estRes = await api.batchFetchEstimate(codes);
      if (!estRes || !estRes.result || estRes.result.code !== 0) { markStale(); return; }
      const estData = estRes.result.data || {};
      const watchlist = this.data.watchlist.map(w => {
        const e = estData[w.fundCode];
        if (!e) return w;
        return {
          ...w,
          nav: e.nav || w.nav,
          // 用 !== undefined 而不是真值/null 判断：服务端明确回 null（今日未出估值）时要让
          // 涨幅显示 -- 、"估"标与旧值一起清掉，不能被上一轮的值兜住
          estimatedNav: e.estimatedNav !== undefined ? e.estimatedNav : w.estimatedNav,
          displayChangeRate: e.displayChangeRate !== undefined ? e.displayChangeRate : w.displayChangeRate,
          displayChangeRateText: e.displayChangeRate !== undefined ? rateText(e.displayChangeRate) : w.displayChangeRateText,
          estimateTime: e.estimateTime !== undefined ? e.estimateTime : w.estimateTime,
        };
      });
      // 对比新旧估值字段，无变化则跳过 setData（首次渲染走 fetchWatchlist，不经过此处）
      const prevMap = {};
      for (const w of this.data.watchlist) prevMap[w.fundCode] = w;
      const changed = watchlist.some(w => {
        const p = prevMap[w.fundCode];
        return !p || p.nav !== w.nav || p.estimatedNav !== w.estimatedNav || p.displayChangeRate !== w.displayChangeRate || p.estimateTime !== w.estimateTime;
      });
      if (!changed && !this.data.stale) return;
      // 取最新估算时间（休市/缺 estimateTime 时不兜底当前时间，同 fetchWatchlist）
      const updateTime = codes.reduce((best, c) => {
        const e = estData[c];
        return (e && e.estimateTime) || best;
      }, "");
      // 合并渲染：displayList + counts 一次算好，一次 setData（原 3 次）
      const { activeGroup, holdingCodes, checkedMap, sortField, sortOrder, searchKeyword, pinnedCodes } = this.data;
      let list;
      if (activeGroup === "all") list = watchlist;
      else if (activeGroup === "holding") list = watchlist.filter(w => holdingCodes.includes(w.fundCode));
      else if (activeGroup === "ungrouped") list = watchlist.filter(w => !w.group && !holdingCodes.includes(w.fundCode));
      else list = watchlist.filter(w => w.group === activeGroup);
      const kw = searchKeyword.trim().toLowerCase();
      if (kw) {
        list = list.filter(w => w.fundName.toLowerCase().includes(kw) || w.fundCode.includes(kw));
      }
      const PERF_SORT_KEYS = ["added", "w1", "m1", "m3", "m6", "y3", "y5", "incept"];
      if (sortField === "change") {
        list = [...list].sort((a, b) => {
          const va = a.displayChangeRate != null ? a.displayChangeRate : -999;
          const vb = b.displayChangeRate != null ? b.displayChangeRate : -999;
          return sortOrder === "asc" ? va - vb : vb - va;
        });
      } else if (sortField === "name") {
        list = [...list].sort((a, b) => a.fundName.localeCompare(b.fundName, "zh"));
      } else if (PERF_SORT_KEYS.includes(sortField)) {
        const pv = (w) => {
          const s = this.data.perfMap[w.fundCode];
          const v = s ? s[sortField] : null;
          return typeof v === "number" && isFinite(v) ? v : -Infinity;
        };
        list = [...list].sort((a, b) => {
          const va = pv(a), vb = pv(b);
          return sortOrder === "asc" ? va - vb : vb - va;
        });
      }
      if (pinnedCodes.length) {
        const pinned = list.filter(w => pinnedCodes.includes(w.fundCode));
        const rest = list.filter(w => !pinnedCodes.includes(w.fundCode));
        list = [...pinned, ...rest];
      }
      list = list.map(w => ({ ...w, _checked: !!checkedMap[w.fundCode], _isPinned: pinnedCodes.includes(w.fundCode) }));
      const { counts, summary } = this._statsFrom(list, watchlist);
      this.setData({
        watchlist, updateTime, displayList: list,
        groupCounts: counts,
        summary,
        stale: false,
      });
    } catch (e) {
      // 轮询失败：有数据时标记 stale，提示条展示「更新失败」
      markStale();
    } finally {
      this._estFetching = false;
    }
  },

  // 轮询失败后点「更新失败」手动重试
  onPollRetry() {
    this._refreshEstimates();
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
    const idx = parseInt(e.currentTarget.dataset.index);
    // 当前行已展开时保持展开，交给 tap 收回（若在这里先收起，tap 收到的必是 -1，守卫永远不触发）
    if (this.data._swipeIdx >= 0 && this.data._swipeIdx !== idx) {
      this.setData({ _swipeIdx: -1, _swipeX: 0 });
    }
    const touch = e.touches[0];
    this._swipeStartX = touch.clientX;
    this._swipeStartY = touch.clientY;
    this._lastSwipeTs = 0;
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
    // 高频 touchmove 节流：30ms 内跳过 setData，松手时由 touchend 强制落点
    const now = Date.now();
    if (this.data._swipeIdx === idx && now - (this._lastSwipeTs || 0) < 30) return;
    this._lastSwipeTs = now;
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

  // 持仓代码缓存：storage 日内有效，首帧直接用；超 10 分钟后台静默刷新（stale-while-revalidate）
  _loadHoldingCodes(force) {
    const today = marketTime.bjDateStr();
    const cached = wx.getStorageSync("watchlist_holding_codes");
    const fresh = cached && cached.date === today && Date.now() - cached.ts < 600000;
    if (!force && fresh && Array.isArray(cached.codes)) {
      this.setData({ holdingCodes: cached.codes }, () => this.updateGroupCounts());
      return;
    }
    if (cached && Array.isArray(cached.codes)) {
      // 有旧值先渲染（角标不至于空等网络），再刷新
      this.setData({ holdingCodes: cached.codes }, () => this.updateGroupCounts());
    }
    this._fetchHoldingCodesRemote(today);
  },

  async _fetchHoldingCodesRemote(today) {
    try {
      const res = await api.holdingList();
      const codes = ((res.result && res.result.data) || []).map(h => h.fundCode).filter(Boolean);
      wx.setStorageSync("watchlist_holding_codes", { date: today, ts: Date.now(), codes });
      this.setData({ holdingCodes: codes }, () => this.updateGroupCounts());
    } catch (e) {
      // 静默失败，不影响主流程
    }
  },
});
