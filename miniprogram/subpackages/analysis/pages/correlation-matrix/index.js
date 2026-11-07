const api = require("../../../../utils/api");
const marketTime = require("../../../../utils/market-time");
// 本页 SWR 缓存（健康分/行业穿透/温度位置）：打开先秒出上次结果、后台刷新；
// 持仓签名不一致（加减仓/换基金）即失效；6 小时内且签名一致时免拉网络
const PAGE_CACHE = "asset_analysis_page_v1";
const PAGE_CACHE_TTL = 6 * 3600000;

Page({
  data: {
    theme: "blue",
    healthScore: null,
    tempStatMine: '', tempStatMarket: '',
    assetAllocation: null,
    fundCodes: [],
    fundNames: [],
    pairs: [],
    sharedStocks: [],
    loading: true,
    loadError: false,
    showAllIndustries: false,
    activeTab: "holding", // holding=持仓分析（健康/穿透/重合） | cost=账单（费用/行为成本/影子）
    feeShowAll: false, feeTotalCount: 0,
    showBillCal: false, billCalRows: [], billCalSaving: false, billHasRows: false,
    amountVisible: true,
    feeCard: null,
    showShadowCard: false, shadowTotal: null, shadowTop: [],
    divCard: null, // 组合分红演算卡（近一年节奏 × 当前份额）
    // —— 目标 · 排名（2026-11-06 全球调研 Top2/Top3） ——
    goalLoaded: false, goal: null, goalInput: "", goalSaving: false, goalNowText: "",
    rankLoaded: false, rank: null,
  },

  onShow() {
    // 每次显示同步主题色（返回/切换时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    // 金额口径与首页「隐藏」开关同源（storage key amountVisible）：费用账单/回本卡都带金额
    const avStored = wx.getStorageSync("amountVisible");
    this.setData({ amountVisible: avStored === "" ? true : !!avStored });
  },

  onLoad() {
        this.fetchAll();
        this._loadFee();    // 费用账单（从收益页迁入：成本结构属深度洞察）
        this._loadBill();   // 行为成本（归因分布+赎回费演算，年度报告 hero 同源）
        this._loadShadow(); // 影子账户（从收益页迁入：行为复盘属深度洞察）
        this._loadDividends(); // 组合分红演算（2026-11-06 调研 Top1）
  },

  // 组合分红演算：近 12 个月每份分红 × 当前份额（云函数一次聚合，内部 7 天缓存）。
  // 国内公募分红不定期，"未来日历"没有预测意义 → 只做"近一年节奏演算"，措辞固定非承诺
  async _loadDividends() {
    try {
      const cached = wx.getStorageSync("dividend_portfolio_cache");
      if (cached && cached.ts && Date.now() - cached.ts < 86400000 && cached.data) {
        this.setData({ divCard: cached.data });
        return;
      }
      const res = await api.fetchFundDividendsPortfolio();
      const d = res && res.result && res.result.code === 0 && res.result.data;
      if (!d || !d.hasData) return;
      const card = {
        totalText: d.total.toFixed(2),
        top: (d.items || []).filter((i) => i.annualAmount > 0).slice(0, 3).map((i) => ({
          fundName: i.fundName, amountText: i.annualAmount.toFixed(2),
        })),
      };
      this.setData({ divCard: card });
      try { wx.setStorageSync("dividend_portfolio_cache", { ts: Date.now(), data: card }); } catch (e) { /* ignore */ }
    } catch (e) { /* 分红卡失败不影响本页 */ }
  },

  // 费用账单：持仓加权综合费率 + 预计年费用（云侧费率缓存 30 天 + 本地 7 天）。
  // v2：明细从"服务端 top3 截断"改为全量返回，旧本地缓存（只含 3 条）必须作废重拉
  _loadFee() {
    try {
      const c = wx.getStorageSync("fee_cache_v2");
      if (c && c.ts && Date.now() - c.ts < 7 * 86400000 && c.data && c.data.hasData) {
        this._applyFeeCard(c.data);
        return;
      }
    } catch (e) { /* ignore */ }
    api.feeSummary().then((res) => {
      const d = res.result && res.result.code === 0 && res.result.data;
      if (!d || !d.hasData) return;
      const maxRate = (d.items || []).reduce((m, i) => Math.max(m, i.rate || 0), 0) || 1;
      d.items = (d.items || []).map((i) => ({ ...i, barPct: Math.round((i.rate || 0) / maxRate * 100) }));
      // 先落盘再应用：_applyFeeCard 不重复算 barPct（缓存里的 items 已带）
      try { wx.setStorageSync("fee_cache_v2", { ts: Date.now(), data: d }); } catch (e) { /* ignore */ }
      this._applyFeeCard(d);
    }).catch(() => { /* ignore */ });
  },

  // 费用明细默认显示费率最高的 3 只 + "展开全部"（与赎回明细同款交互）；
  // 全量数据由服务端返回（不再 top3 截断），这里只做展示层分段
  _applyFeeCard(d) {
    const maxRate = (d.items || []).reduce((m, i) => Math.max(m, i.rate || 0), 0) || 1;
    const items = (d.items || []).map((i) => ({ ...i, barPct: Math.round((i.rate || 0) / maxRate * 100) }));
    this._feeAllItems = items;
    this.setData({ feeCard: { ...d, items: items.slice(0, 3) }, feeTotalCount: items.length });
  },

  onToggleFeeAll() {
    const showAll = !this.data.feeShowAll;
    const all = this._feeAllItems || [];
    this.setData({ feeShowAll: showAll, "feeCard.items": showAll ? all : all.slice(0, 3) });
  },

  // 校准弹层：列出全部年份的卖出记录，预填当前值、占位提示估算值
  onCalibrateBill() {
    const years = (this.data.billCard && this.data.billCard.years) || [];
    const rows = [];
    years.forEach((y) => {
      (y.redemption.rows || []).forEach((r) => {
        if (!r.txId) return;
        rows.push({
          txId: r.txId,
          fundName: r.fundName,
          meta: `${y.year}-${r.date.slice(5)} · 持有 ${r.holdDays != null ? r.holdDays + ' 天' : '--'} · 估算 ${r.fee == null ? '未知' : r.fee + ' 元'}`,
          value: r.calibrated ? String(r.actualFee) : "",
          placeholder: "填实际费用", // 不重复 meta 行的估算值：占位提示"填什么"，估算在左侧文案里
        });
      });
    });
    if (!rows.length) { wx.showToast({ title: '暂无可校准的卖出记录', icon: 'none' }); return; }
    this.setData({ showBillCal: true, billCalRows: rows });
  },

  onBillCalInput(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ ['billCalRows[' + idx + '].value']: e.detail.value });
  },

  onBillCalCancel() { this.setData({ showBillCal: false }); },

  async onBillCalSave() {
    if (this.data.billCalSaving) return;
    const items = (this.data.billCalRows || []).map((r) => ({
      txId: r.txId,
      actualFee: r.value === "" ? null : parseFloat(r.value),
    }));
    this.setData({ billCalSaving: true });
    try {
      const res = await api.behaviorBillCalibrate(items);
      const ok = res.result && res.result.code === 0;
      if (!ok) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); return; }
      this.setData({ showBillCal: false });
      wx.showToast({ title: '已按实际账单校准', icon: 'success' });
      this._loadBill(); // 重新拉取：总额与行状态随之更新
    } catch (e) {
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    } finally {
      this.setData({ billCalSaving: false });
    }
  },

  onExpandYear(e) {
    const idx = e.currentTarget.dataset.index;
    const y = this.data.billCard && this.data.billCard.years[idx];
    if (!y) return;
    const expanded = !y.expanded;
    this.setData({
      ['billCard.years[' + idx + '].expanded']: expanded,
      ['billCard.years[' + idx + '].displayRows']: expanded ? y.redemption.rows : y.redemption.rows.slice(0, 3),
    });
  },

  // 影子账户：卖出记录的"如果没卖"事实演算
  _loadShadow() {
    api.transactionShadow().then((res) => {
      const d = res.result && res.result.code === 0 && res.result.data;
      if (!d || !d.hasData || !d.items) return;
      const top = d.items.filter((i) => i.shadow != null)
        .sort((a, b) => Math.abs(b.shadow) - Math.abs(a.shadow)).slice(0, 3)
        .map((i) => ({ ...i, dateShort: i.date ? i.date.slice(5).replace("-", "/") : "" }));
      this.setData({ showShadowCard: true, shadowTotal: d.total, shadowTop: top });
    }).catch(() => { /* ignore */ });
  },

  // 行为成本：按年聚合操作次数/归因分布 + 赎回费 FIFO 演算（云函数 behaviorBill，全部历史陈述）
  _loadBill() {
    api.behaviorBill().then((res) => {
      const r = res.result && res.result.code === 0 ? res.result : null;
      const d = r && r.data;
      if (!d) return;
      const maxCount = (d.reasons || []).reduce((m, i) => Math.max(m, i.count), 0) || 1;
      const reasons = (d.reasons || []).map((i) => ({ ...i, pct: Math.round((i.count / maxCount) * 100) }));
      // 按年分组：每年明细默认 3 条，超出走"展开"（按年独立开关）。
      // 行展示态：已校准(✓ 实际值) / 免赎回费 / 待校准（无买入批次算不出）/ 估算值
      const decorate = (r) => ({
        ...r,
        feeText: r.calibrated ? `${r.actualFee} 元` : (r.fee == null ? '待校准' : (r.fee > 0 ? `${r.fee} 元` : '免赎回费')),
        feeCls: r.calibrated ? 'fee-cal' : (r.short ? 'fee-short' : (r.fee == null ? 'fee-todo' : (r.fee === 0 ? 'fee-free' : ''))),
      });
      const years = (d.years || []).map((y) => {
        const all = (y.redemption.rows || []).map(decorate);
        return { ...y, redemption: { ...y.redemption, rows: all },
          displayRows: all.slice(0, 3), rowsTotal: all.length, expanded: false };
      });
      const billHasRows = years.some((y) => y.redemption.rows.length > 0);
      this.setData({ billCard: { years }, billHasRows });
    }).catch(() => { /* ignore */ });
  },
  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab }, () => {
      // 切回持仓分析时补画健康分圆环：canvas 用 hidden 保持挂载，
      // 但若首屏默认落费用 tab（无持仓分析数据时）圆环未曾绘制
      if (tab === "holding" && this.data.healthScore && !this._ringDrawn) this._drawHealthRing(this.data.healthScore.score);
    });
    // 目标·排名懒加载（目标卡/排名卡各带防重入，切回不重拉）
    if (tab === "goal") this.loadGoalTab();
  },

  // ==================== 目标 · 排名（2026-11-06 全球调研 Top2/Top3，自复盘中心迁入） ====================

  // 目标进度：市值口径与首页资产卡同源（portfolio_cache.totalAmount，缺了再拉 getPortfolio）；
  // 排名：每日匿名分布任务产出的百分位（样本 <20 不出）
  loadGoalTab() {
    const av = wx.getStorageSync("amountVisible");
    this.setData({ amountVisible: av === "" ? true : !!av });
    this.loadRank();
    try {
      const pc = wx.getStorageSync("portfolio_cache") || {};
      const total = parseFloat(pc.totalAmount) || 0;
      if (total > 0) this._portfolioTotal = total;
    } catch (e) { /* ignore */ }
    Promise.all([
      api.manageGoal("get").catch(() => null),
      this._portfolioTotal ? Promise.resolve(null) : api.getPortfolio(0, { withAnalysis: false, withEstimates: false, withNav60: false }).catch(() => null),
    ]).then(([goalRes, pfRes]) => {
      if (pfRes) {
        const d = pfRes.result && pfRes.result.data;
        const t = parseFloat(d && d.totalAmount) || 0;
        if (t > 0) this._portfolioTotal = t;
      }
      const g = goalRes && goalRes.result && goalRes.result.code === 0 ? goalRes.result.data : null;
      this._applyGoal(g);
      this._checkGoalAchieved(g);
    }).finally(() => this.setData({ goalLoaded: true }));
  },

  // 目标达成闭环（2026-11-07，用户拍板方案 C）：市值≥目标且未标记时，一次性站内提示
  // （wx.showModal，不占订阅消息额度）+ 服务端写 achievedAt（年报叙事素材）。
  // 首次加载即已达标（如目标设得远小于市值）也触发一次，之后靠 achievedAt 幂等
  _checkGoalAchieved(g) {
    if (!g || !(g.targetAmount > 0) || g.achievedAt) return;
    const now = this._portfolioTotal || 0;
    if (now < g.targetAmount) return;
    api.manageGoal("markAchieved").then((res) => {
      const d = res && res.result && res.result.code === 0 && res.result.data;
      if (d && d.achievedAt) this._applyGoal(d);
      const key = "goal_achieved_shown_" + (g.updateTime || g.targetAmount);
      if (wx.getStorageSync(key)) return;
      wx.setStorageSync(key, 1);
      wx.showModal({
        title: "🎉 组合已达目标",
        content: `当前市值 ¥${now.toFixed(2)}，已达到你设定的 ¥${g.targetAmount.toFixed(2)} 目标`,
        showCancel: false,
        confirmText: "知道了",
      });
    }).catch(() => {});
  },

  _applyGoal(g) {
    if (!g || !(g.targetAmount > 0)) {
      this.setData({ goal: null, goalNowText: this._portfolioTotal ? this._portfolioTotal.toFixed(2) : "" });
      return;
    }
    const now = this._portfolioTotal || 0;
    const target = g.targetAmount;
    const pct = target > 0 ? (now / target) * 100 : 0;
    const done = now >= target;
    // 达成态显示增强（2026-11-07）：目标远小于市值时满格条+一行小字像"没有进度条"，
    // 改为大字"🎉 已达成" + 倍数与达成日期
    const achievedAtText = g.achievedAt
      ? (() => { const t = new Date(g.achievedAt + 8 * 3600 * 1000); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`; })()
      : (done ? "" : "");
    this.setData({
      goal: {
        targetAmount: target, // wxml 条件 {{goal && goal.targetAmount}} 消费——漏掉会永远走空态分支（2026-11-07 实测踩到）
        targetText: target.toFixed(2),
        nowText: now.toFixed(2),
        pctW: Math.min(100, +pct.toFixed(1)),
        done,
        gapText: done ? "0.00" : (target - now).toFixed(2),
        needRiseText: done ? "0.00" : ((target / Math.max(now, 0.01) - 1) * 100).toFixed(2),
        multipleText: done ? +((now / target)).toFixed(1) : "",
        achievedAtText,
      },
    });
  },

  onGoalInput(e) { this.setData({ goalInput: e.detail.value }); },

  onSaveGoal() {
    const amt = parseFloat(this.data.goalInput);
    if (!isFinite(amt) || amt <= 0) { wx.showToast({ title: "请输入有效金额", icon: "none" }); return; }
    this.setData({ goalSaving: true });
    api.manageGoal("set", amt).then((res) => {
      if (res.result && res.result.code === 0) {
        this._applyGoal(res.result.data);
        this.setData({ goalInput: "" });
        wx.showToast({ title: "目标已保存", icon: "none" });
      } else {
        wx.showToast({ title: "保存失败", icon: "none" });
      }
    }).finally(() => this.setData({ goalSaving: false }));
  },

  onEditGoal() { this.setData({ goal: null, goalInput: "" }); },

  onRemoveGoal() {
    api.manageGoal("remove").then(() => {
      this._applyGoal(null);
      wx.showToast({ title: "目标已删除", icon: "none" });
    });
  },

  async loadRank() {
    try {
      const res = await api.rankPercentile();
      const d = res && res.result && res.result.code === 0 && res.result.data;
      if (!d || !(d.samples >= 20) || !isFinite(+d.pct) || !isFinite(+d.rate)) {
        this.setData({ rankLoaded: true, rank: null });
        return;
      }
      this.setData({
        rankLoaded: true,
        rank: {
          rateText: (d.rate > 0 ? "+" : "") + (+d.rate).toFixed(2) + "%",
          pct: d.pct,
          pctText: "超过 " + d.pct + "% 的持有人",
          samples: d.samples,
          coveredFunds: d.coveredFunds || 0,
          totalFunds: d.totalFunds || 0,
        },
      });
    } catch (e) {
      this.setData({ rankLoaded: true, rank: null });
    }
  },
  onShadowFundTap(e) {
    const { code, name } = e.currentTarget.dataset;
    if (!code) return;
    const url = "/subpackages/analysis/pages/fund-detail/index?fundCode=" + code + (name ? "&fundName=" + encodeURIComponent(name) : "");
    wx.navigateTo({ url });
  },

  // 行业集中度提示（再平衡视角的数据现实版：基金组合无股债大类数据，以行业集中度替代）。
  // 阈值：单一行业 ≥45% 或前三行业 ≥70%。纯事实陈述，无调整建议（合规红线 #2）
  // 温度位置文案：持仓按 signal 计数；市场按当日分布算占比。数据不全返回空串（不显示）
  _tempStat(holdings, dist) {
    const cnt = { low: 0, mid: 0, high: 0 };
    (holdings || []).forEach((h) => {
      const sig = h.peTemp && h.peTemp.signal;
      if (cnt[sig] !== undefined) cnt[sig]++;
    });
    const mine = cnt.low + cnt.mid + cnt.high;
    if (!mine) return { mine: "", market: "" };
    const total = dist ? (dist.low || 0) + (dist.mid || 0) + (dist.high || 0) : 0;
    const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
    return {
      mine: `你的持仓 ${mine} 只有温度：偏高 ${cnt.high} · 适中 ${cnt.mid} · 偏低 ${cnt.low}`,
      market: total > 0 ? `全市场 ${total} 只：偏高 ${pct(dist.high)}% · 适中 ${pct(dist.mid)}% · 偏低 ${pct(dist.low)}%` : "",
    };
  },
  
  _concentrationTip(assetAllocation) {
    const raw = assetAllocation && assetAllocation.items;
    if (!raw || !raw.length) return "";
    // "其他"（无法归类的残差）不参与集中度判断：全是"其他"时提示"其他占仓 100%"会误导
    const items = raw.filter((i) => i.industry !== "其他");
    if (!items.length) return "";
    const top1 = items[0];
    if (top1.percent >= 45) return `单一行业集中度：${top1.industry} 占仓 ${top1.percent}%`;
    const top3 = items.slice(0, 3).reduce((s, i) => s + i.percent, 0);
    if (top3 >= 70) {
      const names = items.slice(0, 3).map((i) => i.industry).join("/");
      return `前三行业（${names}）合计占仓 ${+top3.toFixed(1)}%`;
    }
    return "";
  },

  onRetry() {
    this.fetchAll();
  },

  // 空态引导：去首页添加持仓
  onGoHome() { wx.switchTab({ url: "/pages/index/index" }); },

  toggleIndustries() {
    this.setData({ showAllIndustries: !this.data.showAllIndustries });
  },

  // 持仓签名（代码 + 市值）：加减仓/换基金后必须重算，防止展示旧持仓的分析结果
  _sigOf(holdings) {
    return (holdings || []).map((h) => `${h.fundCode}:${h.marketValue || 0}`).sort().join("|");
  },
  _readPageCache() {
    try { return wx.getStorageSync(PAGE_CACHE) || null; } catch (e) { return null; }
  },
  // 渲染分析结果（健康分/穿透/温度位置）：缓存路径与网络路径共用，
  // 顺带处理健康分圆环绘制与"无分析内容时默认落账单 tab"
_applyPayload(p) {
    this.setData({ loading: false, ...p }, () => {
      if (p.healthScore) this._drawHealthRing(p.healthScore.score);
      if (!p.healthScore && (!p.assetAllocation || !p.assetAllocation.items || !p.assetAllocation.items.length)) {
        this.setData({ activeTab: "cost" });
      }
    });
  },

  async fetchAll() {
    this.setData({ loading: true, loadError: false });
    try {
      const portfolioCache = wx.getStorageSync("portfolio_cache") || {};
      const homeHoldings = portfolioCache.holdings || [];
      // 重合度预取与组合数据并行：基金代码在首页缓存里同步可取，不必等 getPortfolio
      // 返回——手机上省一次串行云函数往返（≈0.5-1s）。代码集若与最终持仓不一致，
      // 下方主流程会用正确的 codes 再跑一次（幂等，多的那次只当预热）
      const pcCodes = [...new Set(homeHoldings.map((h) => h.fundCode).filter(Boolean))];
      if (pcCodes.length >= 2) this._ensureCorrelation(pcCodes, null, false);

      const sig = this._sigOf(homeHoldings);
      // 首页缓存新鲜（盘中 5 分钟 / 盘后冻结 / 周末全天）→ 直接用它，零网络
      const homeFresh = homeHoldings.length > 0 && !!portfolioCache.updateTime &&
        marketTime.isCacheFresh(portfolioCache, { estimateTtl: 300000 });
      const cached = this._readPageCache();
      const cacheUsable = !!(cached && cached.data && (!sig || !cached.sig || cached.sig === sig));
      const cacheFresh = cacheUsable && Date.now() - (cached.ts || 0) < PAGE_CACHE_TTL;

      // SWR：首页缓存不新鲜时，先用本页缓存秒出上次结果（此前是空白转圈等云函数）
      if (!homeFresh && cacheUsable) this._applyPayload(cached.data);

      // 1. 取组合数据
      let d = homeFresh ? portfolioCache : null;
      // 本页缓存还新且签名一致 → 免拉网络：只补 fundCodes（重合度用），不重复渲染（已用缓存渲染过）
      if (!d && cacheFresh && homeHoldings.length > 0) {
        const codes = [...new Set(homeHoldings.map((h) => h.fundCode))];
        const names = homeHoldings.map((h) => h.fundName);
        this.setData({ fundCodes: codes, fundNames: names, loading: false });
        if (codes.length >= 2) await this._ensureCorrelation(codes, names, true);
        return;
      }
      if (!d) {
        // withNav60:false 跳过历史净值拉取（本页只需持仓列表 + 健康分），减小响应与耗时
        // withEstimates:false：本页不做实时估值展示，跳过估值管线（省 ~50 次上游请求）
        const res = await api.getPortfolio(0, { withNav60: false, withAnalysis: true, withEstimates: false });
        d = res.result && res.result.data;
      }
      if (!d || !d.holdings || d.holdings.length === 0) {
        // 首页缓存与网络都不可用：若刚才已用本页缓存渲染则保留，否则收尾空态
        this.setData({ loading: false });
        return;
      }

      // 温度位置：把持仓温度放回全市场分布里看（横向那半；纵向的历史分位在基金详情页）。
      // 市场分布优先取本次响应（仅 withAnalysis 返回），没有则回落首页写的 temp_dist_cache ——
      // 两者同源口径（fetchMarketOverview 的三次计数）；都没有就不显示，不拿半截数据充数
      let tempDist = d.tempDistribution || null;
      if (!tempDist) {
        try {
          const c = wx.getStorageSync("temp_dist_cache");
          const dd = c && c.dist;
          if (dd && (dd.low + dd.mid + dd.high) > 0) tempDist = dd;
        } catch (e) { /* ignore */ }
      }
      const tempStat = this._tempStat(d.holdings, tempDist);
      // 先收起 loading 再渲染数据：健康分圆环是 canvas，处于 loading 的 wx:else 分支之外，
      // 若先 setData 数据后收 loading，绘制时 canvas 节点尚未挂载 → 圆环空白
      const concTip = this._concentrationTip(d.assetAllocation);
      const payload = {
        healthScore: d.healthScore || null,
        assetAllocation: d.assetAllocation || null,
        concentrationTip: concTip,
        tempStatMine: tempStat.mine,
        tempStatMarket: tempStat.market,
      };
      this._applyPayload(payload);
      // 写本页缓存（下次进入先秒出；持仓签名变化即失效）
      try { wx.setStorageSync(PAGE_CACHE, { ts: Date.now(), sig, data: payload }); } catch (e) { /* ignore */ }

      // 同一基金多账户会重复出现 → 去重，否则重合度会把同一只基金算两次
      const fundCodes = [...new Set(d.holdings.map(h => h.fundCode))];
      const fundNames = d.holdings.map(h => h.fundName);
      this.setData({ fundCodes, fundNames });

      // 2. 持仓重合度分析（持仓季度更新，缓存 30 天；加减仓自动失效）。
      //    预取可能已并行跑过一次：_ensureCorrelation 内部按 codeKey 幂等，命中直接渲染
      if (fundCodes.length >= 2) {
        await this._ensureCorrelation(fundCodes, fundNames, true);
      }

      this.setData({ loading: false });
    } catch (e) {
      console.error("资产分析失败:", e);
      this.setData({ loading: false, loadError: true });
    }
  },

  // 持仓重合度分析（持仓季度更新，客户端缓存 30 天；加减仓换代码自动失效）。
  // 幂等：同 codeKey 且已有数据 → 直接返回；预取与主流程并发调用安全
  async _ensureCorrelation(fundCodes, fundNames, isMain) {
    const codeKey = [...fundCodes].sort().join(',');
    const cache = wx.getStorageSync('asset_analysis_cache') || {};
    // v4：重合度口径修正为「每基金前十大持仓」（QDII 全量明细截取前十大）+ 剔除打新零星持仓，旧缓存失效
    if (cache.codeKey === codeKey && cache.v === 4 && cache.ts && (Date.now() - cache.ts < 2592000000)) {
      // 缓存命中：直接恢复
      this.setData({ sharedStocks: cache.sharedStocks || [], pairs: cache.pairs || [], loadError: false });
      return;
    }
    // 在途去重：onLoad 预取与主流程并发时复用同一请求（重接口：服务端拉全部基金持仓）
    if (this._corrInflight) return this._corrInflight;
    this._corrInflight = (async () => {
      const corrRes = await api.computeCorrelation(fundCodes);
      if (!corrRes || !corrRes.result || corrRes.result.code !== 0) {
        // 失败：仅主流程置错误态给 onRetry 重试；预取（onLoad 后台）静默——
        // 旧写法预取失败也会置 loadError，且成功路径从不清理，一次瞬时失败钉死整页
        if (isMain) this.setData({ loading: false, loadError: true });
        return;
      }
      const names = fundNames || this.data.fundNames || [];
      const codes = this.data.fundCodes && this.data.fundCodes.length ? this.data.fundCodes : fundCodes;
      const { pairs, sharedStocks, truncated } = corrRes.result.data;
      const enrichStock = (s) => ({
        ...s,
        _open: false,
        funds: (s.funds || []).map(f => ({
          ...f,
          fundName: names[codes.indexOf(f.fundCode)] || f.fundCode,
        })),
      });
      const enrichedPairs = (pairs || []).map(p => ({
        ...p,
        key: `${p.fundA}_${p.fundB}`,
        nameA: names[codes.indexOf(p.fundA)],
        nameB: names[codes.indexOf(p.fundB)],
      }));
      const enrichedShared = (sharedStocks || []).map(enrichStock);
      this.setData({ pairs: enrichedPairs, sharedStocks: enrichedShared, loadError: false });
      if (truncated && isMain) {
        wx.showToast({ title: "持仓较多，仅分析前 20 只基金", icon: "none" });
      }
      // 写缓存：预取路径（未带基金名）不入 30 天缓存，避免无名数据被长期钉住
      if (fundNames) {
        wx.setStorageSync('asset_analysis_cache', {
          v: 4, codeKey, ts: Date.now(),
          sharedStocks: enrichedShared,
          pairs: enrichedPairs,
        });
      }
    })();
    try {
      await this._corrInflight;
    } finally {
      this._corrInflight = null;
    }
  },

  _drawHealthRing(score, attempt = 0) {
    this._ringDrawn = true;
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
