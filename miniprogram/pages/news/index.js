const api = require("../../utils/api");

const CAT_TEXT = { fund: "基金", stock: "股市", macro: "宏观", mix: "综合" };
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
    this.setData({ [`displayItems[${idx}]._open`]: !this.data.displayItems[idx]._open });
  },
  // 只看重要
  _applyFilter() {
    let items = this.data.flashItems;
    if (this.data.importantOnly) items = items.filter((i) => i.important);
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
