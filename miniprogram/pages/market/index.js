const api = require("../../utils/api");
const marketTime = require("../../utils/market-time");
const track = require("../../utils/track");

// 行情中心 V1（产品规划 P1-5）：市场概览 + 持仓行业高亮 + 核心指数。
// 缓存接交易日时钟：盘中 60s / 盘后冻结（finalAtClose） / 周末零请求
// 指数口径与首页统一：腾讯日K优先（涨跌幅 close 差分）→ 东财客户端 → 云函数多源兜底

const CACHE_KEY = "market_center_cache";
const INDICES = [
  { code: "000001", name: "上证指数" },
  { code: "399001", name: "深证成指" },
  { code: "000300", name: "沪深300" },
  { code: "399006", name: "创业板指" },
  { code: "HSTECH", name: "恒生科技" },
  { code: "HSI", name: "恒生指数" },
  { code: "SPX", name: "标普500" },
  { code: "IXIC", name: "纳斯达克" },
];
const A_CODES = ["000001", "399001", "000300", "399006"];
const FETCH_TIMEOUT = 3000;
const HK_FETCH_TIMEOUT = 8000; // 港股走云函数多源并行竞速，放宽到 8s

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
    // 行业板块（持仓行业置顶）
    sectors: [],
    mineCount: 0,
    // 核心指数
    indexCards: [],
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
  },
  onPullDownRefresh() {
    this.refresh(true).finally(() => wx.stopPullDownRefresh());
  },

  refresh(force) {
    const cached = wx.getStorageSync(CACHE_KEY);
    if (!force && cached && marketTime.isCacheFresh(cached, { estimateTtl: 60 * 1000, finalAtClose: true })) {
      this._render(cached);
      return Promise.resolve();
    }
    this.setData({ loading: !cached, emptyData: false, loadError: false });
    return Promise.all([this._fetchOverview(), this._fetchIndices()]).then(([overviewRes, indexCards]) => {
      const now = Date.now();
      const cache = {
        ts: now,
        overview: overviewRes ? overviewRes.overview : (cached && cached.overview) || null,
        sectors: overviewRes ? overviewRes.sectors : (cached && cached.sectors) || [],
        mineCount: overviewRes ? overviewRes.mineCount : (cached && cached.mineCount) || 0,
        indexCards,
        empty: !!(overviewRes && overviewRes.empty) && !indexCards.some((c) => c.price !== "--"),
      };
      try { wx.setStorageSync(CACHE_KEY, cache); } catch (e) { /* ignore */ }
      this._render(cache);
    }).catch(() => {
      if (cached) { this._render(cached); return; }
      this.setData({ loading: false, loadError: true });
    });
  },

  _render(cache) {
    const ov = cache.overview;
    const data = {
      loading: false,
      loadError: false,
      emptyData: !!cache.empty,
      overview: ov,
      sectors: cache.sectors || [],
      mineCount: cache.mineCount || 0,
      indexCards: cache.indexCards || [],
      indexLoading: false,
      updatedAt: marketTime.bjTimeStr ? marketTime.bjTimeStr() : new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16),
    };
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
        return { overview: d.overview, sectors, mineCount: d.mineCount || 0, empty: !!d.empty };
      }
      return null;
    }).catch(() => null);
  },

  // 核心指数：与首页 fetchIndices 同源同口径（腾讯日K → 东财客户端 → 云函数）
  _fetchIndices() {
    const fetchOne = async (idx) => {
      const isHK = !A_CODES.includes(idx.code);
      const tRes = await Promise.race([
        api.fetchMarketIndexTencent(idx.code, 2).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
      ]);
      if (tRes && tRes.code === 0 && tRes.data && tRes.data.length > 0) return tRes.data;
      if (!isHK) {
        const clientRes = await Promise.race([
          api.fetchMarketIndexClient(idx.code, 2).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
        ]);
        if (clientRes && clientRes.code === 0 && clientRes.data && clientRes.data.length > 0) return clientRes.data;
      }
      const res = await Promise.race([
        api.fetchMarketIndex(idx.code, 2).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), isHK ? HK_FETCH_TIMEOUT : FETCH_TIMEOUT)),
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
