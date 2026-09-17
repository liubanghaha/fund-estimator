const api = require("../../utils/api");
const marketTime = require("../../utils/market-time");
const track = require("../../utils/track");
const chart = require("../../utils/chart");

// 行情中心 V1·合规整改版（2026-09）：仅港股/美股/亚太指数 + 持仓港美股敞口。
// A 股内容（市场概览/行业板块/主力资金流/A 股指数）已按审核整改方案清除，AppID 持「股票信息服务平台(港股/美股)」资质。
// 缓存说明：港美亚交易时段与 A 股不同，不适用 A 股 15:00 冻结（finalAtClose）——
// 用 60s TTL + 全局空窗跳过（北京时间 6:00~7:59：美股收盘后、日经 8:00 开盘前，数据不会变）。

const CACHE_KEY = "market_center_cache";
const CACHE_VERSION = 4; // v4：加欧洲指数 + 海外市场速览（期货/商品/汇率）+ 美股盘前盘后
const INDICES = [
  { code: "HSTECH", name: "恒生科技", group: "hk" },
  { code: "HSI", name: "恒生指数", group: "hk" },
  { code: "SPX", name: "标普500", group: "us" },
  { code: "IXIC", name: "纳斯达克", group: "us" },
  { code: "DJIA", name: "道琼斯", group: "us" },
  { code: "N225", name: "日经225", group: "ap" },
  { code: "KS11", name: "韩国KOSPI", group: "ap" },
  { code: "SENSEX", name: "印度SENSEX", group: "ap" },
  { code: "TWII", name: "台湾加权", group: "ap" },
  { code: "DAX", name: "德国DAX30", group: "eu" },
  { code: "FTSE", name: "英国富时100", group: "eu" },
  { code: "CAC", name: "法国CAC40", group: "eu" },
];
const IDX_TABS = [
  { key: "hk", label: "港股" },
  { key: "us", label: "美股" },
  { key: "ap", label: "亚太" },
  { key: "eu", label: "欧洲" },
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
    // 持仓港美股敞口（数据陈述）+ 重仓股实时行情榜
    exposure: null,
    // 指数走势弹层（分时仅腾讯已映射指数：HSTECH/HSI）
    showIdxModal: false, idxModalName: "", idxModalCode: "", idxModalLoading: false, idxModalError: false, idxModalErrText: "走势加载失败，请重试",
    idxPeriod: 5, idxModalIntradayOk: false,
    // 个股弹层
    showStockModal: false, stockModal: null, stockKlineLoading: false, stockKlineOk: false,
    // 海外市场速览（指数期货/商品/汇率，云函数 fetchMarketSnapshot）
    snapshot: null,
    // 各市场开闭市状态（本地推算）
    hkStatus: "", usStatus: "", apStatus: "", euStatus: "", usSessionText: "", usSessionState: "",
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
    if (hour >= 6 && hour < 8) return false; // 全球闭市空窗（日经/KOSPI 北京时间 8:00 开盘）
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
    // 非强制的静默刷新：全球闭市空窗（6:00~7:59）数据不可能变化，直接用缓存跳过外呼。
    // 仅在已有可用缓存时跳过——首次打开无缓存必须真拉，否则指数区空白
    if (!force && cacheUpToDate && cachedOk && this._inNightWindow()) {
      this._render(cached, true);
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
    // 敞口先到（快照需要知道持仓里有哪些美股代码）
    return this._fetchExposure().then((exposure0) => {
      const usCodes = ((exposure0 && exposure0.usStocks) || []).map((x) => x.code).filter(Boolean);
      return Promise.all([Promise.resolve(exposure0), this._fetchIndices(), this._fetchSnapshot(usCodes)]);
    }).then(([exposure0, indexCards, snapshot]) => {
      const exposure = this._mergeUsSession(exposure0, snapshot);
      const now = Date.now();
      // 部分失败兜底：指数卡全"--"或敞口为空时保留上次好缓存（外源限流是分钟级的，恢复后自然更新）
      // 兜底回退必须校验缓存版本：用户残留的 v1/v2 缓存含 A 股指数卡，混入会破坏合规整改口径
      const effIndexCards = indexCards.some((c) => c.price !== "--") ? indexCards : ((cacheUpToDate && cached && cached.indexCards) || indexCards);
      const effExposure = exposure || (cacheUpToDate && cached && cached.exposure) || null;
      const cache = {
        ts: now,
        v: CACHE_VERSION,
        indexCards: effIndexCards,
        exposure: effExposure,
        snapshot: snapshot || (cacheUpToDate && cached && cached.snapshot) || null,
        empty: !indexCards.some((c) => c.price !== "--"),
      };
      try { wx.setStorageSync(CACHE_KEY, cache); } catch (e) { /* ignore */ }
      // 指数卡整体回退旧缓存时按 fromCache 渲染：updatedAt 沿用缓存时间，不谎称"刚刚更新"
      const usedStale = !indexCards.some((c) => c.price !== "--") && !!(cacheUpToDate && cached);
      this._render(cache, usedStale);
      this._refreshing = false;
    }).catch(() => {
      this._refreshing = false;
      if (cached) { this._render(cached, true); return; }
      this.setData({ loading: false, loadError: true });
    });
  },

  _inNightWindow() {
    const h = new Date(Date.now() + 8 * 3600000).getUTCHours();
    return h >= 6 && h < 8;
  },

  _render(cache, fromCache) {
    const data = {
      loading: false,
      loadError: false,
      emptyData: !!cache.empty,
      exposure: cache.exposure || null,
      snapshot: cache.snapshot || null,
      snap: this._buildSnap(cache.snapshot),
      indexCards: [],
      indexLoading: false,
      ...this._marketStatus(),
      // 秒开（旧缓存）时显示缓存保存时刻，标注诚实；拉新成功后显示当前时刻
      updatedAt: new Date((fromCache ? (cache.ts || 0) : Date.now()) + 8 * 3600000)
        .toISOString().slice(11, 16),
    };
    // 指数按 港/美/亚太 分组，展示当前选中组
    const grouped = { hk: [], us: [], ap: [], eu: [] };
    (cache.indexCards || []).forEach((c) => {
      const def = INDICES.find((i) => i.code === c.code);
      (grouped[def ? def.group : "hk"] || grouped.hk).push(c);
    });
    data.indexCardsGrouped = grouped;
    data.indexCards = grouped[this.data.idxTab] || [];
    this.setData(data);
  },

  // 各市场开闭市状态（北京时间本地推算，纯状态展示）：港股 9:30-12:00/13:00-16:00；美股宽口径
  // 21:15~次日 5:00（夏冬令差异 1h）；日经（亚太）8:00-14:00；周末休市（美股周日晚盘不计，误差 ≤1.5h）
  _marketStatus() {
    const d = new Date(Date.now() + 8 * 3600000);
    const day = d.getUTCDay();
    const weekend = day === 0 || day === 6;
    const min = d.getUTCHours() * 60 + d.getUTCMinutes();
    const hkOpen = !weekend && ((min >= 570 && min < 720) || (min >= 780 && min < 960));
    const apOpen = !weekend && min >= 480 && min < 840;
    // 欧洲（夏令时 15:00-23:30、冬令时 16:00-次日 0:30，按宽口径 15:00-23:30）
    const euOpen = !weekend && min >= 900 && min < 1410;
    // 美股分时段（北京）：盘前 16:00-21:30、盘中 21:30-04:00、盘后 04:00-08:00
    let usState = "closed";
    if (!weekend) {
      if (min >= 960 && min < 1290) usState = "pre";
      else if (min >= 1290 || min < 240) usState = "regular";
      else if (min >= 240 && min < 480) usState = "post";
    }
    const st = (open) => (open ? "交易中" : "已收盘");
    return {
      hkStatus: st(hkOpen), apStatus: st(apOpen), euStatus: st(euOpen),
      usSessionState: usState,
      usStatus: usState === "pre" ? "盘前" : usState === "post" ? "盘后" : usState === "regular" ? "交易中" : "已收盘",
    };
  },

  // 指数卡点击 → 走势弹层（港股指数支持分时；近5日/近1月/近3月全指数可用）
  onIdxCardTap(e) {
    const { code, name } = e.currentTarget.dataset;
    if (!code) return;
    const INTRADAY_OK = { HSTECH: 1, HSI: 1 }; // ifzq 分时仅覆盖腾讯已映射指数
    const intradayOk = !!INTRADAY_OK[code];
    this.setData({
      showIdxModal: true, idxModalName: name || "", idxModalCode: code,
      idxModalIntradayOk: intradayOk,
      idxPeriod: intradayOk ? "intraday" : 5,
    });
    this._loadIdxModalChart(intradayOk ? "intraday" : 5);
  },
  onIdxPeriod(e) {
    const mode = e.currentTarget.dataset.days;
    const norm = mode === "intraday" ? "intraday" : +mode;
    if (!norm || norm === this.data.idxPeriod) return;
    this.setData({ idxPeriod: norm });
    this._loadIdxModalChart(norm);
  },
  _loadIdxModalChart(mode) {
    const code = this.data.idxModalCode;
    // 请求序号：快速切换周期时，慢响应不得覆盖新周期的图
    this._idxSeq = (this._idxSeq || 0) + 1;
    const seq = this._idxSeq;
    const stale = () => seq !== this._idxSeq;
    this.setData({ idxModalLoading: true, idxModalError: false });
    const fail = () => { if (stale()) return; this.setData({ idxModalLoading: false, idxModalError: true, idxModalErrText: "走势加载失败，请重试" }); };
    // 欧洲/印度/台湾等指数东财不提供历史 K 线，只有实时快照两点——画出来是一条假趋势线，宁可说明没有
    const noHistory = () => { if (stale()) return; this.setData({ idxModalLoading: false, idxModalError: true, idxModalErrText: "该指数暂无历史走势数据，仅提供实时行情" }); };
    const done = (items, isRate) => {
      if (stale()) return;
      if (!items || items.length < 2) { fail(); return; }
      if (!isRate && items.length < 3) { noHistory(); return; }
      this.setData({ idxModalLoading: false });
      // 等弹层 canvas 完成布局后再绘制（drawChart 异步查询节点）
      setTimeout(() => this._drawModalChart("#idxModalCanvas", items, isRate), 150);
    };
    if (mode === "intraday") {
      // 分时：ifzq 分钟线（changeRate 相对昨收），仅港股指数有映射
      api.fetchIndexIntradayTencent(code).then((res) => {
        if (!res || res.code !== 0 || !res.data || res.data.length < 2) { fail(); return; }
        done(res.data.map((d) => ({ date: d.time, value: d.changeRate })), true);
      }).catch(fail);
      return;
    }
    this._fetchIndexKline(code, mode).then((data) => {
      if (!data || data.length < 2) { fail(); return; }
      done(data.map((d) => ({ date: d.date, value: d.close })), false);
    }).catch(fail);
  },
  _drawModalChart(selector, items, isRate) {
    const query = wx.createSelectorQuery();
    query.select(selector).fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const w = res[0].width || 320, h = res[0].height || 160;
      const last = items[items.length - 1].value, first = isRate ? 0 : items[0].value;
      chart.drawLineChart(canvas, {
        w, h, data: items, isReturn: !!isRate,
        color: last >= first ? "#E4393C" : "#2E8B57",
        padding: { top: 16, right: 16, bottom: 24, left: 56 },
      });
    });
  },
  onIdxModalClose() {
    this.setData({ showIdxModal: false });
  },
  // 重仓股行点击 → 个股弹层：报价/占仓/PE/PB/行业 + 港股附 5 日走势（ifzq 个股 K 线不支持美股个股）
  onStockTap(e) {
    const { code, market } = e.currentTarget.dataset;
    const list = market === "hk" ? (this.data.exposure && this.data.exposure.hkStocks) : (this.data.exposure && this.data.exposure.usStocks);
    const item = (list || []).find((s) => s.code === code);
    if (!item) return;
    // WXML 不支持 .join() 方法调用，富文本拼好在 JS 侧完成
    const stockModal = { ...item, fundsText: (item.funds || []).join("、") };
    this.setData({ showStockModal: true, stockModal, stockKlineLoading: market === "hk", stockKlineOk: false });
    if (market !== "hk") return;
    api.fetchStockKlineTencent("hk" + code, 5).then((rows) => {
      if (!this.data.showStockModal || rows.length < 2) {
        this.setData({ stockKlineLoading: false, stockKlineOk: false });
        return;
      }
      const items = rows.map((d) => ({ date: d.date, value: d.close }));
      this.setData({ stockKlineLoading: false, stockKlineOk: true });
      setTimeout(() => this._drawModalChart("#stockModalCanvas", items), 150);
    }).catch(() => this.setData({ stockKlineLoading: false, stockKlineOk: false }));
  },
  onStockModalClose() {
    this.setData({ showStockModal: false });
  },
  noop() {},

  // 指数分类切换（港/美/亚太）
  onIdxTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.idxTab) return;
    this.setData({ idxTab: key, indexCards: this.data.indexCardsGrouped[key] || [] });
  },

  // 速览卡展示用：期货/商品 2 位小数、汇率 4 位；商品与汇率并成小格
  _buildSnap(snapshot) {
    if (!snapshot) return null;
    const fmt = (list, digits) => (list || []).filter((x) => x && x.price != null).map((x) => Object.assign({}, x, {
      priceText: (+x.price).toFixed(digits),
      rateText: x.changeRate == null ? "--" : (x.changeRate > 0 ? "+" : "") + x.changeRate + "%",
    }));
    return {
      futures: fmt(snapshot.futures, 2),
      others: fmt(snapshot.commodities, 2).concat(fmt(snapshot.fx, 4)),
      updatedAt: snapshot.updatedAt || "",
    };
  },

  // 点敞口格子 → 跳到对应重仓股列表；该类没有数据时说明原因
  // （原来两个格子没绑任何事件，点了没反应像坏了；--% 其实是"基金披露的重仓股里没有这一侧"）
  onExposureTap(e) {
    const market = e.currentTarget.dataset.market === "us" ? "us" : "hk";
    const ex = this.data.exposure || {};
    const has = market === "hk" ? (ex.hkStocks || []).length : (ex.usStocks || []).length;
    if (!has) {
      wx.showToast({
        title: market === "hk"
          ? "你持仓基金披露的重仓股里没有港股"
          : "你持仓基金披露的重仓股里没有美股",
        icon: "none",
        duration: 2600,
      });
      return;
    }
    wx.pageScrollTo({ selector: market === "hk" ? "#stockSecHk" : "#stockSecUs", duration: 200 });
  },

  // 海外市场速览（期货/商品/汇率 + 美股盘前盘后）；失败返回 null 由缓存兜底
  _fetchSnapshot(usCodes) {
    return api.fetchMarketSnapshot({ usCodes: usCodes || [] }).then((res) => {
      if (res && res.result && res.result.code === 0 && res.result.data) return res.result.data;
      return null;
    }).catch(() => null);
  },

  // 重仓美股：盘前/盘后时段用新浪的实时价（含盘前盘后成交），并标出时段
  // 腾讯的报价在盘前盘后不更新，所以这两个时段以新浪为准；盘中/收盘仍用腾讯（与原口径一致）
  _mergeUsSession(exposure, snapshot) {
    if (!exposure || !snapshot || !snapshot.us || !snapshot.us.length) return exposure;
    const byCode = {};
    snapshot.us.forEach((q) => { byCode[q.code] = q; });
    const list = (exposure.usStocks || []).map((s) => {
      const q = byCode[s.code];
      if (!q || !q.session || !q.session.fresh) return s;
      const st = q.session.state;
      if (st !== "pre" && st !== "post") return s;
      return Object.assign({}, s, {
        price: q.price,
        changeRate: q.changeRate,
        sessionText: st === "pre" ? "盘前" : "盘后",
        sessionTime: q.tickTime || "",
      });
    });
    return Object.assign({}, exposure, { usStocks: list });
  },

  // 持仓港美股敞口（单云调用，数据陈述）；失败返回 null 由缓存兜底
  _fetchExposure() {
    return api.fetchMarketOverview({ action: "exposure" }).then((res) => {
      if (res && res.result && res.result.code === 0 && res.result.data) return res.result.data;
      return null;
    }).catch(() => null);
  },

  // 单指数 K 线：与首页 fetchIndices 同源同口径（腾讯日K → 东财客户端 → 云函数）
  _fetchIndexKline(code, days) {
    const TENCENT_OK = { HSTECH: 1, HSI: 1 };
    const idx = INDICES.find((i) => i.code === code) || { code };
    // 腾讯映射缺失的代码（SPX/IXIC/N225/KS11）跳过腾讯直试东财客户端 K 线，避免浪费一轮竞速
    const fetchOne = async () => {
      if (TENCENT_OK[code]) {
        const tRes = await Promise.race([
          api.fetchMarketIndexTencent(code, days).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
        ]);
        if (tRes && tRes.code === 0 && tRes.data && tRes.data.length > 0) return tRes.data;
      }
      const clientRes = await Promise.race([
        api.fetchMarketIndexClient(code, days).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), FETCH_TIMEOUT)),
      ]);
      if (clientRes && clientRes.code === 0 && clientRes.data && clientRes.data.length > 0) return clientRes.data;
      // 云函数多源兜底（美股/亚太走多源竞速，放宽到 12s）
      const res = await Promise.race([
        api.fetchMarketIndex(code, days).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), CLOUD_FETCH_TIMEOUT)),
      ]);
      return (res && res.result && res.result.code === 0 && res.result.data) || [];
    };
    return fetchOne().catch(() => []);
  },

  _fetchIndices() {
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
    return Promise.all(INDICES.map((idx) => this._fetchIndexKline(idx.code, 2).catch(() => []))).then((datas) =>
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
