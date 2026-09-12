const api = require("../../../../utils/api");
const marketTime = require("../../../../utils/market-time");

Page({
  data: {
    theme: "blue",
    healthScore: null,
    assetAllocation: null,
    fundCodes: [],
    fundNames: [],
    pairs: [],
    sharedStocks: [],
    loading: true,
    loadError: false,
    showAllIndustries: false,
  },

  onShow() {
    // 每次显示同步主题色（返回/切换时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
  },

  onLoad() {
        this.fetchAll();
  },

  onRetry() {
    this.fetchAll();
  },

  // 空态引导：去首页添加持仓
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },

  toggleIndustries() {
    this.setData({ showAllIndustries: !this.data.showAllIndustries });
  },

  async fetchAll() {
    this.setData({ loading: true, loadError: false });
    try {
      // 1. 获取持仓 + 健康分 + 资产配置（优先读首页缓存；交易日时钟判新鲜度，冻结态不重复拉）
      let d;
      const portfolioCache = wx.getStorageSync("portfolio_cache");
      if (portfolioCache && portfolioCache.holdings && portfolioCache.updateTime &&
          marketTime.isCacheFresh(portfolioCache, { estimateTtl: 300000 })) {
        d = portfolioCache;
      }
      if (!d) {
        // withNav60:false 跳过历史净值拉取（本页只需持仓列表 + 健康分），减小响应与耗时
        const res = await api.getPortfolio(0, { withNav60: false, withAnalysis: true });
        d = res.result && res.result.data;
      }
      if (!d || !d.holdings || d.holdings.length === 0) {
        this.setData({ loading: false });
        return;
      }

      // 先收起 loading 再渲染数据：健康分圆环是 canvas，处于 loading 的 wx:else 分支之外，
      // 若先 setData 数据后收 loading，绘制时 canvas 节点尚未挂载 → 圆环空白
      this.setData({
        loading: false,
        healthScore: d.healthScore || null,
        assetAllocation: d.assetAllocation || null,
      }, () => {
        if (d.healthScore) this._drawHealthRing(d.healthScore.score);
      });

      const fundCodes = d.holdings.map(h => h.fundCode);
      const fundNames = d.holdings.map(h => h.fundName);
      this.setData({ fundCodes, fundNames });

      // 2. 持仓重合度分析（持仓季度更新，缓存 30 天；加减仓自动失效）
      if (fundCodes.length >= 2) {
        const codeKey = [...fundCodes].sort().join(',');
        const cache = wx.getStorageSync('asset_analysis_cache') || {};
        // v4：重合度口径修正为「每基金前十大持仓」（QDII 全量明细截取前十大）+ 剔除打新零星持仓，旧缓存失效
        if (cache.codeKey === codeKey && cache.v === 4 && cache.ts && (Date.now() - cache.ts < 2592000000)) {
          // 缓存命中：直接恢复
          this.setData({ sharedStocks: cache.sharedStocks || [], pairs: cache.pairs || [] });
        } else {
          const corrRes = await api.computeCorrelation(fundCodes);
          if (!corrRes || !corrRes.result || corrRes.result.code !== 0) {
            // 云函数失败：置错误态给 onRetry 重试，不再静默留空
            this.setData({ loading: false, loadError: true });
            return;
          }
          const { pairs, sharedStocks, truncated } = corrRes.result.data;
          const enrichStock = (s) => ({
            ...s,
            _open: false,
            funds: (s.funds || []).map(f => ({
              ...f,
              fundName: fundNames[fundCodes.indexOf(f.fundCode)] || f.fundCode,
            })),
          });
          const enrichedPairs = (pairs || []).map(p => ({
            ...p,
            key: `${p.fundA}_${p.fundB}`,
            nameA: fundNames[fundCodes.indexOf(p.fundA)],
            nameB: fundNames[fundCodes.indexOf(p.fundB)],
          }));
          this.setData({ pairs: enrichedPairs, sharedStocks: (sharedStocks || []).map(enrichStock) });
          if (truncated) {
            wx.showToast({ title: "持仓较多，仅分析前 20 只基金", icon: "none" });
          }
          // 写缓存
          wx.setStorageSync('asset_analysis_cache', {
            v: 4, codeKey, ts: Date.now(),
            sharedStocks: (sharedStocks || []).map(enrichStock),
            pairs: enrichedPairs,
          });
        }
      }

      this.setData({ loading: false });
    } catch (e) {
      console.error("资产分析失败:", e);
      this.setData({ loading: false, loadError: true });
    }
  },

  _drawHealthRing(score, attempt = 0) {
    const query = wx.createSelectorQuery();
    query.select('#healthCanvas').fields({ node: true, size: true }).exec((res) => {
      const node = res && res[0] && res[0].node;
      const w = res && res[0] && res[0].width;
      const h = res && res[0] && res[0].height;
      // canvas 刚插入页面时节点/布局可能未就绪（node 缺失或尺寸为 0）：120ms 后重试，最多 5 次
      if (!node || !w || !h) {
        if (attempt < 5) setTimeout(() => this._drawHealthRing(score, attempt + 1), 120);
        return;
      }
      const canvas = node;
      const dpr = wx.getWindowInfo().pixelRatio;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;

      // 底色环
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#EEE';
      ctx.stroke();

      // 进度弧
      const pct = Math.min(1, Math.max(0, score / 100));
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + pct * 2 * Math.PI;
      const color = score >= 80 ? '#4CAF50' : score >= 60 ? '#1976D2' : score >= 40 ? '#FF9800' : '#E4393C';

      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.lineWidth = 8;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.stroke();
    });
  },

  onToggleSharedStock(e) {
    const idx = e.currentTarget.dataset.index;
    // 不直接 mutate data（保持不可变，用 setData 路径更新单字段）
    this.setData({ [`sharedStocks[${idx}]._open`]: !this.data.sharedStocks[idx]._open });
  },
});
