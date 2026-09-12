const api = require("../../utils/api");
const marketTime = require("../../utils/market-time");
const track = require("../../utils/track");

// 行情中心 V1·合规整改版（2026-09）：仅港股/美股/亚太指数 + 持仓港美股敞口。
// A 股内容（市场概览/行业板块/主力资金流/A 股指数）已按审核整改方案清除，AppID 持「股票信息服务平台(港股/美股)」资质。
// 缓存说明：港美亚交易时段与 A 股不同，不适用 A 股 15:00 冻结（finalAtClose）——
// 用 60s TTL + 全局空窗跳过（北京时间 6:00~8:59 无主要市场交易，数据不会变），周末由轮询/刷新条件兜底。

const CACHE_KEY = "market_center_cache";
const CACHE_VERSION = 3; // v3：口径改为港美亚 + 敞口，旧缓存作废
const INDICES = [
  { code: "HSTECH", name: "恒生科技", group: "hk" },
  { code: "HSI", name: "恒生指数", group: "hk" },
  { code: "SPX", name: "标普500", group: "us" },
  { code: "IXIC", name: "纳斯达克", group: "us" },
  { code: "N225", name: "日经225", group: "ap" },
  { code: "KS11", name: "韩国KOSPI", group: "ap" },
];
const IDX_TABS = [
  { key: "hk", label: "港股" },
  { key: "us", label: "美股" },
  { key: "ap", label: "亚太" },
];
const FETCH_TIMEOUT = 3000;
const CLOUD_FETCH_TIMEOUT = 12000; // 云函数多源竞速兜底的客户端等待上限（美股/亚太依赖此路径）
const TTL = 60 * 1000;

Page({
  data: {
    theme: "red",
    loading: true,
    loadError: false,
    emptyData: false,
    // 持仓港美股敞口（数据陈述）
    exposure: null,
    // 核心指数（港/美/亚太 三类切换）
    idxTabs: IDX_TABS,
    idxTab: "hk",
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
    // 盘中自动刷新：30s 轮询。活跃判定=北京时间 9:00~次日 5:59 且今天或上一自然日为交易日
    // （覆盖：A/港/亚白天盘、美股晚间盘、美股凌晨收盘前的周六凌晨尾巴）
    this._startPoll();
  },
  onHide() {
    this._stopPoll();
  },
  onUnload() {
    this._stopPoll();
  },
  _pollActive() {
    const d = new Date(Date.now() + 8 * 3600000);
    const hour = d.getUTCHours();
    if (hour >= 6 && hour < 9) return false; // 全球闭市空窗
    const today = marketTime.bjDateStr();
    return marketTime.isTradingDay(today) || (hour < 6 && marketTime.isTradingDay(marketTime.lastTradingDay(today)));
  },
  _startPoll() {
    this._stopPoll();
    this._pollTimer = setInterval(() => {
      if (this._pollActive() && !this._refreshing) this.refresh(true);
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
    // 坏缓存检测：指数卡大半为 "--"（如一次性超时）时视为无效，强制重拉
    const cachedCards = (cached && cached.indexCards) || [];
    const cachedOk = cachedCards.filter((c) => c.price !== "--").length >= 4;
    const cacheUpToDate = cached && cached.v === CACHE_VERSION;
    const fresh = cached && cacheUpToDate && cachedOk && Date.now() - (cached.ts || 0) < TTL;
    // 非强制的静默刷新：全球闭市空窗（6:00~8:59）数据不可能变化，直接用缓存跳过外呼
    if (!force && this._pollActive() === false && !fresh && this._inNightWindow()) {
      if (cached && cacheUpToDate) this._render(cached, true);
      this._refreshing = false;
      this.setData({ loading: false });
      return Promise.resolve();
    }
    if (!force && fresh) {
      this._render(cached, true);
      this._refreshing = false;
      return Promise.resolve();
    }
    // 缓存秒开：缓存存在但不新鲜时先渲染旧数据（避免 fetch 期间出现"全 --"中间态）
    if (cached && cacheUpToDate) this._render(cached, true);
    this.setData({ loading: !cached, emptyData: false, loadError: false });
    return Promise.all([this._fetchExposure(), this._fetchIndices()]).then(([exposure, indexCards]) => {
      const now = Date.now();
      // 部分失败兜底：指数卡全"--"或敞口为空时保留上次好缓存（外源限流是分钟级的，恢复后自然更新）
      const effIndexCards = indexCards.some((c) => c.price !== "--") ? indexCards : ((cached && cached.indexCards) || indexCards);
      const effExposure = exposure || (cached && cached.exposure) || null;
      const cache = {
        ts: now,
        v: CACHE_VERSION,
        indexCards: effIndexCards,
        exposure: effExposure,
        empty: !indexCards.some((c) => c.price !== "--"),
      };
      try { wx.setStorageSync(CACHE_KEY, cache); } catch (e) { /* ignore */ }
      this._render(cache);
      this._refreshing = false;
    }).catch(() => {
      this._refreshing = false;
      if (cached) { this._render(cached, true); return; }
      this.setData({ loading: false, loadError: true });
    });
  },

  _inNightWindow() {
    const h = new Date(Date.now() + 8 * 3600000).getUTCHours();
    return h >= 6 && h < 9;
  },

  _render(cache, fromCache) {
    const data = {
      loading: false,
      loadError: false,
      emptyData: !!cache.empty,
      exposure: cache.exposure || null,
      indexCards: [],
      indexLoading: false,
      // 秒开（旧缓存）时显示缓存保存时刻，标注诚实；拉新成功后显示当前时刻
      updatedAt: new Date((fromCache ? (cache.ts || 0) : Date.now()) + 8 * 3600000)
        .toISOString().slice(11, 16),
    };
    // 指数按 港/美/亚太 分组，展示当前选中组
    const grouped = { hk: [], us: [], ap: [] };
    (cache.indexCards || []).forEach((c) => {
      const def = INDICES.find((i) => i.code === c.code);
      (grouped[def ? def.group : "hk"] || grouped.hk).push(c);
    });
    data.indexCardsGrouped = grouped;
    data.indexCards = grouped[this.data.idxTab] || [];
    this.setData(data);
  },

  // 指数分类切换（港/美/亚太）
  onIdxTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.idxTab) return;
    this.setData({ idxTab: key, indexCards: this.data.indexCardsGrouped[key] || [] });
  },

  // 持仓港美股敞口（单云调用，数据陈述）；失败返回 null 由缓存兜底
  _fetchExposure() {
    return api.fetchMarketOverview({ action: "exposure" }).then((res) => {
      if (res && res.result && res.result.code === 0 && res.result.data) return res.result.data;
      return null;
    }).catch(() => null);
  },

  // 核心指数：与首页 fetchIndices 同源同口径（腾讯日K → 东财客户端 → 云函数）
  _fetchIndices() {
    // 腾讯映射缺失的代码（SPX/IXIC/N225/KS11）跳过腾讯直试东财客户端 K 线，避免浪费一轮竞速
    const TENCENT_OK = { HSTECH: 1, HSI: 1 };
    const fetchOne = async (idx) => {
      if (TENCENT_OK[idx.code]) {
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
      // 云函数多源兜底（美股/亚太走多源竞速，放宽到 12s）
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
      title: "全球主要市场指数速览",
      path: "/pages/market/index",
      imageUrl: "",
    };
  },
});
