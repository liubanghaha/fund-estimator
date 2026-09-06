const api = require("../../utils/api");

const CAT_TEXT = { fund: "基金", stock: "股市", macro: "宏观", mix: "综合" };
const CACHE_KEY = "news_cache";
const SOURCE_TEXT = { em: "东财快讯", jin10: "金十快讯" };

Page({
  data: {
    theme: "red",
    dateLabel: "",
    importantOnly: false,
    flashItems: [],
    displayItems: [],
    sortEnd: "",
    hasMore: false,
    loading: true,
    loadingMore: false,
    loadError: false,
  },

  onLoad() {
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
    // 当天日期（北京时间）
    const d = new Date(Date.now() + 8 * 3600000);
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getUTCDay()];
    this.setData({ dateLabel: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${week}` });
    // 缓存秒开：先渲染上次数据（日期分组标签按今天重算），后台拉最新
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.flashItems && cached.flashItems.length) {
        this.setData({
          flashItems: cached.flashItems,
          sortEnd: cached.sortEnd || "",
          hasMore: !!cached.hasMore,
          loading: false,
        });
        this._applyFilter();
      }
    } catch (e) { /* ignore */ }
    this.fetchFirst();
  },
  onShow() {
    const theme = wx.getStorageSync("theme") || "red";
    if (theme !== this.data.theme) this.setData({ theme });
  },
  onPullDownRefresh() {
    this.fetchFirst().finally(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    this.loadMore();
  },

  fetchFirst() {
    this._autoPages = 0;
    this.setData({ loading: !this.data.flashItems.length, loadError: false });
    return api.fetchNews({}).then((res) => {
      if (res && res.result && res.result.code === 0 && res.result.data) {
        const d = res.result.data;
        const flash = this._normalizeFlash((d.flash && d.flash.items) || []);
        this.setData({
          flashItems: flash,
          sortEnd: (d.flash && d.flash.sortEnd) || "",
          hasMore: !!(d.flash && d.flash.sortEnd),
        });
        this._applyFilter();
        // 写缓存：下次打开秒开（日期分组标签渲染时按当天重算，不受缓存日期影响）
        try { wx.setStorageSync(CACHE_KEY, { ts: Date.now(), flashItems: this.data.flashItems, sortEnd: this.data.sortEnd, hasMore: this.data.hasMore }); } catch (e) { /* ignore */ }
      } else {
        this.setData({ loadError: true });
      }
      this.setData({ loading: false });
    }).catch(() => {
      this.setData({ loading: false, loadError: true });
    });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    api.fetchNews({ sortEnd: this.data.sortEnd }).then((res) => {
      if (res && res.result && res.result.code === 0 && res.result.data) {
        const d = res.result.data;
        const more = this._normalizeFlash((d.flash && d.flash.items) || []);
        this.setData({
          flashItems: this.data.flashItems.concat(more),
          sortEnd: (d.flash && d.flash.sortEnd) || "",
          hasMore: !!(d.flash && d.flash.sortEnd),
        });
        this._applyFilter();
      }
      this.setData({ loadingMore: false });
    }).catch(() => this.setData({ loadingMore: false }));
  },

  _normalizeFlash(items) {
    return items.map((it) => ({
      ...it,
      timeShort: (it.time || "").slice(11, 16),
      sourceText: SOURCE_TEXT[it.source] || "快讯",
      categoryText: CAT_TEXT[it.category] || "综合",
      // 超过约 4 行长度（正文字号 27rpx、每行约 20 字）的条目提供展开/收起
      long: (it.content || "").length > 75,
      _open: false,
    }));
  },
  onToggleText(e) {
    const idx = e.currentTarget.dataset.index;
    if (!this.data.displayItems[idx] || !this.data.displayItems[idx].long) return; // 短文本无展开态
    this.setData({ [`displayItems[${idx}]._open`]: !this.data.displayItems[idx]._open });
  },
  // 只看重要 + 日期分组标签（今天/昨天/M月D日）
  _applyFilter() {
    let items = this.data.flashItems;
    if (this.data.importantOnly) items = items.filter((i) => i.important);
    // 筛选后可见条目过少时页面不滚动，onReachBottom 永不触发 → 自动补拉下一页（有上限防打爆）
    if (items.length < 5 && this.data.hasMore && !this.data.loadingMore && this._autoPages < 4) {
      this._autoPages = (this._autoPages || 0) + 1;
      this.loadMore();
    }
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const yest = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    let prev = "";
    items = items.map((i) => {
      const day = (i.time || "").slice(0, 10);
      const showDay = day !== prev;
      prev = day;
      const dayLabel = day === today ? "今天" : day === yest ? "昨天" : day.slice(5).replace("-", "月") + "日";
      return { ...i, showDay, dayLabel };
    });
    this.setData({ displayItems: items });
  },
  onImportantToggle() {
    this.setData({ importantOnly: !this.data.importantOnly });
    this._applyFilter();
  },
  onRetry() {
    this.fetchFirst();
  },
});
