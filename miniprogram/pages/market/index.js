const api = require("../../utils/api");
const marketTime = require("../../utils/market-time");
const track = require("../../utils/track");

// 行情中心 V1（产品规划 P1-5）：市场概览 + 持仓行业高亮 + 核心指数。
// 缓存接交易日时钟：盘中 60s / 盘后冻结（finalAtClose） / 周末零请求
// 指数口径与首页统一：腾讯日K优先（涨跌幅 close 差分）→ 东财客户端 → 云函数多源兜底

const CACHE_KEY = "market_center_cache";
// 缓存版本：行业占比重算口径变更时 +1，旧缓存作废强制重拉（冻结缓存不会自然过期）
const CACHE_VERSION = 2;
const INDICES = [
  { code: "000001", name: "上证指数", group: "a" },
  { code: "399001", name: "深证成指", group: "a" },
  { code: "000300", name: "沪深300", group: "a" },
  { code: "399006", name: "创业板指", group: "a" },
  { code: "HSTECH", name: "恒生科技", group: "hk" },
  { code: "HSI", name: "恒生指数", group: "hk" },
  { code: "SPX", name: "标普500", group: "us" },
  { code: "IXIC", name: "纳斯达克", group: "us" },
  { code: "N225", name: "日经225", group: "ap" },
  { code: "KS11", name: "韩国KOSPI", group: "ap" },
];
const IDX_TABS = [
  { key: "a", label: "A股" },
  { key: "hk", label: "港股" },
  { key: "us", label: "美股" },
  { key: "ap", label: "亚太" },
];
const FETCH_TIMEOUT = 3000;
const CLOUD_FETCH_TIMEOUT = 12000; // 云函数多源竞速兜底的客户端等待上限（美股/亚太无腾讯映射，依赖此路径）

Page({
  data: {
    theme: "red",
    loading: true,
    loadError: false,
    emptyData: false,
    // 市场概览
    overview: null,
    amountText: "--",
    shAmountText: "",
    szAmountText: "",
    upPct: 50, downPct: 50,
    // 行业板块（持仓行业置顶，横滑）
    sectors: [],
    sectorPages: [],
    sectorCurrent: 0,
    sectorSort: "weight", // weight=持仓匹配 | gain=涨幅最多 | loss=涨幅最小
    mineCount: 0,
    // 核心指数（A/港/美/亚太 四类切换）
    idxTabs: IDX_TABS,
    idxTab: "a",
    indexCards: [],
    indexCardsGrouped: {},
    indexLoading: true,
    updatedAt: "",
  },

  onLoad() {
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
    this.refresh(false);
  },
  onShow() {
    const theme = wx.getStorageSync("theme") || "red";
    if (theme !== this.data.theme) this.setData({ theme });
    // 盘中自动刷新：30s 轮询（仅交易时段 + 页面可见期），盘后/周末自动停，切走页面自动停止
    this._startPoll();
  },
  onHide() {
    this._stopPoll();
  },
  onUnload() {
    this._stopPoll();
  },
  _startPoll() {
    this._stopPoll();
    this._pollTimer = setInterval(() => {
      if (marketTime.marketPhase() === "trading" && !this._refreshing) this.refresh(true);
    }, 30000);
  },
  _stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },
  onPullDownRefresh() {
    this.refresh(true).finally(() => wx.stopPullDownRefresh());
  },

  refresh(force) {
    if (this._refreshing) return Promise.resolve(); // 防重入：轮询/下拉/打开并发时只跑一路
    this._refreshing = true;
    const cached = wx.getStorageSync(CACHE_KEY);
    // 坏缓存检测：指数卡大半为 "--"（如一次性超时）时视为无效，冻结逻辑不适用，强制重拉
    const cachedCards = (cached && cached.indexCards) || [];
    const cachedOk = cachedCards.filter((c) => c.price !== "--").length >= 6;
    const cacheUpToDate = cached && cached.v === CACHE_VERSION;
    if (!force && cacheUpToDate && cachedOk && marketTime.isCacheFresh(cached, { estimateTtl: 60 * 1000, finalAtClose: true })) {
      this._render(cached);
      this._refreshing = false;
      return Promise.resolve();
    }
    this.setData({ loading: !cached, emptyData: false, loadError: false });
    return Promise.all([this._fetchOverview(), this._fetchIndices()]).then(([overviewRes, indexCards]) => {
      const now = Date.now();
      const flows = overviewRes ? (overviewRes.flows || {}) : (cached && cached.flows) || {};
      // 核心指数卡并入主力资金流（仅 A 股指数有此数据，港美指无）
      const cardsWithFlow = indexCards.map((c) => {
        const f = flows[c.code];
        if (!f || f.main == null) return c;
        return { ...c, flowText: this._fmtFlow(f.main), isFlowUp: f.main >= 0 };
      });
      // 部分失败兜底：概览为空/行业为空/指数卡全"--"时保留上次好缓存，
      // 避免东财对云函数限流的窗口内把好缓存洗成空白态（限流是分钟级的，恢复后自然更新）
      const effOverview = overviewRes && overviewRes.overview ? overviewRes.overview : ((cached && cached.overview) || null);
      const effSectors = overviewRes && overviewRes.sectors && overviewRes.sectors.length ? overviewRes.sectors : ((cached && cached.sectors) || []);
      const effIndexCards = indexCards.some((c) => c.price !== "--") ? cardsWithFlow : ((cached && cached.indexCards) || cardsWithFlow);
      const effMineCount = overviewRes && overviewRes.mineCount != null ? overviewRes.mineCount : ((cached && cached.mineCount) || 0);
      const cache = {
        ts: now,
        v: CACHE_VERSION,
        overview: effOverview,
        sectors: effSectors,
        mineCount: effMineCount,
        flows,
        indexCards: effIndexCards,
        empty: !effOverview && effSectors.length === 0 && !indexCards.some((c) => c.price !== "--"),
      };
      try { wx.setStorageSync(CACHE_KEY, cache); } catch (e) { /* ignore */ }
      this._render(cache);
      this._refreshing = false;
    }).catch(() => {
      this._refreshing = false;
      if (cached) { this._render(cached); return; }
      this.setData({ loading: false, loadError: true });
    });
  },

  _render(cache) {
    const ov = cache.overview;
    this._sectorsRaw = cache.sectors || [];
    this._mineCount = cache.mineCount || 0;
    const data = {
      loading: false,
      loadError: false,
      emptyData: !!cache.empty,
      overview: ov,
      mineCount: this._mineCount,
      indexCards: [],
      indexLoading: false,
      updatedAt: marketTime.bjTimeStr ? marketTime.bjTimeStr() : new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16),
    };
    this._applySectorSort(data, this.data.sectorSort);
    // 指数按 A/港/美/亚太 分组，展示当前选中组
    const grouped = { a: [], hk: [], us: [], ap: [] };
    (cache.indexCards || []).forEach((c) => {
      const def = INDICES.find((i) => i.code === c.code);
      (grouped[def ? def.group : "a"] || grouped.a).push(c);
    });
    data.indexCardsGrouped = grouped;
    data.indexCards = grouped[this.data.idxTab] || [];
    if (ov && (ov.up || ov.down)) {
      const total = ov.up + ov.down + ov.flat;
      data.upPct = total ? Math.round((ov.up / total) * 100) : 50;
      data.downPct = total ? Math.max(100 - data.upPct, 0) : 50;
    }
    if (ov) {
      data.amountText = this._fmtAmount((ov.shAmount || 0) + (ov.szAmount || 0));
      data.shAmountText = this._fmtAmount(ov.shAmount || 0);
      data.szAmountText = this._fmtAmount(ov.szAmount || 0);
    }
    this.setData(data);
  },

  // 元 → 万亿/亿 展示
  _fmtAmount(yuan) {
    if (!yuan) return "--";
    const yi = yuan / 1e8;
    if (yi >= 10000) return (yi / 10000).toFixed(2) + "万亿";
    return yi.toFixed(0) + "亿";
  },

  // 指数分类切换（A/港/美/亚太）
  onIdxTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.idxTab) return;
    this.setData({ idxTab: key, indexCards: this.data.indexCardsGrouped[key] || [] });
  },

  // 主力净额 → 数据陈述文案（合规红线 #5：只陈述不带引导词）
  _fmtFlow(main) {
    const yi = Math.abs(main) / 1e8;
    const amt = yi >= 10000 ? (yi / 10000).toFixed(2) + "万亿" : yi.toFixed(1) + "亿";
    return "主力净" + (main >= 0 ? "流入" : "流出") + " " + amt;
  },

  // 行业排序：weight=持仓匹配（命中行业按占仓权重在前，服务端默认序）｜gain=当日涨幅最多｜loss=涨幅最小
  _applySectorSort(data, mode) {
    const all = this._sectorsRaw || [];
    let ordered;
    if (mode === "gain") {
      ordered = all.slice().sort((a, b) => (b.changeRate != null ? b.changeRate : -999) - (a.changeRate != null ? a.changeRate : -999));
    } else if (mode === "loss") {
      ordered = all.slice().sort((a, b) => (a.changeRate != null ? a.changeRate : 999) - (b.changeRate != null ? b.changeRate : 999));
    } else {
      ordered = all;
    }
    data.sectors = ordered;
    // 两列网格分页：每页 6 个（2×3），swiper 左右翻页
    const sectorPages = [];
    for (let i = 0; i < ordered.length; i += 6) sectorPages.push(ordered.slice(i, i + 6));
    data.sectorPages = sectorPages;
    data.sectorCurrent = Math.min(this.data.sectorCurrent || 0, sectorPages.length - 1);
  },

  onSectorPageChange(e) {
    this.setData({ sectorCurrent: e.detail.current });
  },

  // 点指示点直达对应页（快速滑动）
  onSectorDotTap(e) {
    const i = +e.currentTarget.dataset.i;
    if (i !== this.data.sectorCurrent) this.setData({ sectorCurrent: i });
  },

  onSectorSort(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.sectorSort) return;
    const data = { sectorSort: key };
    this._applySectorSort(data, key);
    this.setData(data);
  },

  // 概览+行业板块（单云调用）；失败返回 null 由缓存兜底
  _fetchOverview() {
    return api.fetchMarketOverview().then((res) => {
      if (res && res.result && res.result.code === 0 && res.result.data) {
        const d = res.result.data;
        const sectors = (d.sectors || []).map((s) => ({
          ...s,
          rateText: s.changeRate != null ? (s.changeRate > 0 ? "+" : "") + s.changeRate + "%" : "--",
          isUp: (s.changeRate || 0) > 0,
          isDown: (s.changeRate || 0) < 0,
          weightText: s.weight != null ? "占仓 " + s.weight + "%" : "",
          leaderText: s.leader ? "领涨 " + s.leader + (s.leaderRate != null ? " " + (s.leaderRate > 0 ? "+" : "") + s.leaderRate + "%" : "") : "",
        }));
        return { overview: d.overview, sectors, mineCount: d.mineCount || 0, flows: d.flows || {}, empty: !!d.empty };
      }
      return null;
    }).catch(() => null);
  },

  // 核心指数：与首页 fetchIndices 同源同口径（腾讯日K → 东财客户端 → 云函数）
  _fetchIndices() {
    // 腾讯映射缺失的代码（SPX/IXIC/N225/KS11）跳过腾讯直试东财客户端 K 线，避免浪费一轮竞速
    const fetchOne = async (idx) => {
      const tencentOk = !!({ "000001": 1, "399001": 1, "000300": 1, "399006": 1, "HSTECH": 1, "HSI": 1 })[idx.code];
      if (tencentOk) {
        const tRes = await Promise.race([
          api.fetchMarketIndexTencent(idx.code, 2).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
        ]);
        if (tRes && tRes.code === 0 && tRes.data && tRes.data.length > 0) return tRes.data;
      }
      const clientRes = await Promise.race([
        api.fetchMarketIndexClient(idx.code, 2).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
      ]);
      if (clientRes && clientRes.code === 0 && clientRes.data && clientRes.data.length > 0) return clientRes.data;
      // 云函数多源兜底（美股/亚太走新浪/东财/腾讯竞速，放宽到 12s）
      const res = await Promise.race([
        api.fetchMarketIndex(idx.code, 2).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), CLOUD_FETCH_TIMEOUT)),
      ]);
      return (res && res.result && res.result.code === 0 && res.result.data) || [];
    };
    const buildCard = (idx, data) => {
      if (data && data.length >= 1) {
        const latest = data[data.length - 1];
        const prev = data.length >= 2 ? data[data.length - 2] : latest;
        const change = +(latest.close - prev.close).toFixed(2);
        const changeRate = prev.close && prev.close !== 0 ? +((change / prev.close) * 100).toFixed(2) : 0;
        return {
          name: idx.name, code: idx.code,
          price: latest.close.toFixed(2),
          rateText: (changeRate > 0 ? "+" : "") + changeRate + "%",
          isUp: change >= 0,
        };
      }
      return { name: idx.name, code: idx.code, price: "--", rateText: "--", isUp: true };
    };
    return Promise.all(INDICES.map((idx) => fetchOne(idx).catch(() => []))).then((datas) =>
      INDICES.map((idx, i) => buildCard(idx, datas[i])));
  },

  onShareAppMessage() {
    track.share({ sharePage: "market" });
    return {
      title: "今日市场数据 · 两市成交与行业动向",
      path: "/pages/market/index",
      imageUrl: "",
    };
  },
});
