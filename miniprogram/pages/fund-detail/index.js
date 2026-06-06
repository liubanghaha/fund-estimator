const api = require("../../utils/api");
const calc = require("../../utils/calculator");
const chart = require("../../utils/chart");

Page({
  data: {
    fundCode: "", fundName: "", loading: true, errorMsg: "",
    nav: null, estimatedNav: null, estimatedChangeRate: null, estimateTime: "",
    actualNav: "", actualDate: "", actualChangeRate: null,
    navHistory: [],
    todayReturn: null, weekReturn: null, monthReturn: null,
    threeMonthReturn: null, sixMonthReturn: null, yearReturn: null, threeYearReturn: null,
    profile: null, manager: null, holdings: [],
    hasHolding: false, holdingId: null, holdingData: null, followed: false, activeTab: "trend",
    showAllHistory: false,
    isTrading: false,
    chartPeriod: '1M',
    chartTxMap: {},
    transactionList: [],
    showTransactions: false,
    scrollToTx: "",
    quarterNet: 0,
  },

  onLoad(options) {
    if (!options.fundCode) return;
    const fundName = options.fundName ? decodeURIComponent(options.fundName) : "基金详情";
    this.setData({ fundCode: options.fundCode, fundName });
    wx.setNavigationBarTitle({ title: fundName });
    this._firstLoad = true;
    const { windowWidth } = wx.getSystemInfoSync();
    const canvasW = windowWidth - 24;
    const canvasH = Math.round(canvasW * 0.53);
    this._canvasW = canvasW;
    this._canvasH = canvasH;
    this.setData({ canvasW, canvasH });
    this.fetchAll();
  },

  onShow() {
    if (this._firstLoad) { this._firstLoad = false; return; }
    const { fundCode } = this.data;
    if (!fundCode) return;
    const forceRefresh = wx.getStorageSync("portfolio_force_refresh");
    if (forceRefresh) {
      wx.removeStorageSync("portfolio_force_refresh");
      this._lastRefresh = 0;
    }
    const now = Date.now();
    // 30s 内不重复拉取非估值数据，仅刷新估值
    if (this._lastRefresh && now - this._lastRefresh < 30000) {
      this.fetchEstimate().then(() => this.updateDisplay());
      return;
    }
    this._lastRefresh = now;
    this.refreshData();
  },

  async refreshData() {
    try {
      await Promise.all([
        this.fetchEstimate(),
        this.checkHolding(),
        this.checkFollow(),
        this.fetchTransactions(),
      ]);
      this.updateDisplay();
      this.enrichHoldingData();
    } catch (e) { /* ignore */ }
  },

  async fetchAll() {
    this.setData({ loading: true, errorMsg: "" });
    this._lastRefresh = Date.now();
    try {
      await Promise.all([this.fetchEstimate(), this.fetchHistory(), this.checkFollow(), this.checkHolding(), this.fetchTransactions()]);
      this.updateDisplay();
      this.enrichHoldingData();
      this.setData({ loading: false }, () => this.drawChart());
    } catch (e) {
      this.setData({ loading: false, errorMsg: "加载失败" });
    }
  },
  async checkFollow() {
    try {
      const res = await api.watchlistCheck(this.data.fundCode);
      if (res.result && res.result.code === 0 && res.result.data) {
        this.setData({ followed: !!res.result.data.followed });
      }
    } catch (e) { console.error("检查自选失败:", e); }
  },
  async onToggleFollow() {
    const { fundCode, fundName, followed } = this.data;
    try {
      if (followed) {
        const res = await api.watchlistRemove(fundCode);
        if (res.result && res.result.code === 0) {
          this.setData({ followed: false });
          wx.showToast({ title: "已取消自选", icon: "none" });
        } else {
          wx.showToast({ title: "操作失败", icon: "none" });
        }
      } else {
        const res = await api.watchlistAdd(fundCode, fundName);
        if (res.result && res.result.code === 0) {
          this.setData({ followed: true });
          wx.showToast({ title: "已加自选", icon: "success" });
        } else {
          wx.showToast({ title: res.result ? res.result.msg : "操作失败", icon: "none" });
        }
      }
    } catch (e) {
      wx.showToast({ title: "操作失败", icon: "none" });
    }
  },

  updateDisplay() {
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    const min = now.getMinutes();
    const isTrading = day >= 1 && day <= 5 &&
      (hour > 9 || (hour === 9 && min >= 0)) &&
      (hour < 15 || (hour === 15 && min <= 30));
    const displayChangeRate = calc.selectChangeRate(
      this.data.nav, this.data.actualNav,
      this.data.estimatedChangeRate, this.data.actualChangeRate,
    );
    const isNavUpdated = this.data.actualDate === calc.formatDate(now);
    this.setData({ isTrading, displayChangeRate, isNavUpdated });
  },

  async fetchEstimate() {
    try {
      const res = await api.fetchFundEstimate(this.data.fundCode);
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        const actualCR = d.actualChangeRate != null ? d.actualChangeRate : this.data.actualChangeRate;
        const yesterdayNav = d.nav != null ? d.nav : this.data.nav;
        const actNavRaw = d.actualNav != null ? d.actualNav : parseFloat(this.data.actualNav);
        const displayCR = calc.selectChangeRate(yesterdayNav, actNavRaw, d.estimatedChangeRate, actualCR);
        this.setData({
          nav: d.nav, estimatedNav: d.estimatedNav,
          estimatedChangeRate: d.estimatedChangeRate, estimateTime: d.estimateTime,
          fundName: this.data.fundName || d.fundName || "",
          actualNav: d.actualNav ? d.actualNav.toFixed(4) : this.data.actualNav,
          actualChangeRate: actualCR,
          displayChangeRate: displayCR,
        });
      }
    } catch (e) { console.error("获取估值失败:", e); }
  },

  async fetchHistory(days = 80) {
    try {
      const res = await api.fetchFundNAVHistory(this.data.fundCode, days);
      if (res.result && res.result.code === 0) {
        const history = res.result.data;
        if (history.length > 0) {
          this.setData({
            navHistory: history,
            actualNav: this.data.actualNav || (history[0].nav != null ? history[0].nav.toFixed(4) : ""),
            actualDate: history[0].date,
            actualChangeRate: this.data.actualChangeRate != null ? this.data.actualChangeRate : (history[0].changeRate || 0),
          });
          this.calcReturns(history);
        }
      }
    } catch (e) { console.error("获取历史净值失败:", e); }
  },

  async fetchProfile() {
    try {
      const res = await api.fetchFundProfile(this.data.fundCode);
      if (res.result && res.result.code === 0) {
        let p = res.result.data.profile || {};
        if (p.fundSize) { p.fundSizeText = (p.fundSize / 100000000).toFixed(2) + '亿'; }
        else { p.fundSizeText = '--'; }
        const riskMap = { '1': '低风险', '2': '中低风险', '3': '中风险', '4': '中高风险', '5': '高风险' };
        p.riskText = riskMap[p.riskLevel] || p.riskLevel || '--';
        const holdings = res.result.data.holdings || [];

        // 只保留前10
        const top10 = holdings.filter(h => !h.rank.includes('*')).slice(0, 10);

        // 拉股票行情，完成后一次性 setData
        const quotes = await this._fetchStockQuotes(top10);
        const enriched = top10.map(h => ({
          ...h,
          stockChangeRate: quotes[h.stockCode] != null ? quotes[h.stockCode] : null,
        }));
        this.setData({ profile: p, manager: res.result.data.manager, holdings: enriched });
      }
    } catch (e) { console.error("获取基金档案失败:", e); }
  },

  async _fetchStockQuotes(holdings) {
    const map = {};
    const tasks = [];
    holdings.forEach(h => {
      const code = h.stockCode;
      let secid;
      if (code.length === 6) {
        secid = (code.startsWith("6") ? "1." : "0.") + code;
      } else if (code.length === 5) {
        secid = "116." + code; // 港股
      } else {
        return;
      }
      tasks.push(new Promise((resolve) => {
        wx.request({
          url: `https://push2his.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f170`,
          header: { Referer: "https://quote.eastmoney.com/" },
          success(res) {
            try {
              const d = (res.data && res.data.data) || {};
              map[code] = d.f170 != null ? +(d.f170 / 100).toFixed(2) : null;
            } catch (e) {}
            resolve();
          },
          fail() { resolve(); },
        });
      }));
    });
    await Promise.all(tasks);
    return map;
  },

  calcReturns(history) {
    const r = calc.calcPeriodReturns(history);
    const { displayChangeRate } = this.data;
    this.setData({
      todayReturn: displayChangeRate != null ? displayChangeRate : (r.day || 0),
      weekReturn: r.week, monthReturn: r.month, threeMonthReturn: r.threeMonth,
      sixMonthReturn: r.sixMonth, yearReturn: r.year, threeYearReturn: r.threeYear,
    });
  },

  _buildChartData() {
    const history = this.data.navHistory;
    if (history.length < 2) return null;

    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260, '3Y': 750 };
    const days = PERIOD_DAYS[this.data.chartPeriod] || 260;
    const sliced = history.slice(0, days);
    if (sliced.length < 2) return null;

    const data = [...sliced].reverse();
    const hd = this.data.holdingData;

    if (hd && hd.shares && parseFloat(hd.shares) > 0) {
      // 有持仓 → 收益走势（基于首日净值变化百分比）
      const baseNav = data[0].nav;
      if (!baseNav) return null;
      return {
        items: data.map(d => ({
          date: d.date,
          value: +((d.nav / baseNav - 1) * 100).toFixed(2),
        })),
        isReturn: true,
      };
    }

    // 无持仓 → 净值走势
    return {
      items: data.map(d => ({ date: d.date, value: d.nav })),
      isReturn: false,
    };
  },

  _getChartOpts() {
    const hd = this.data.holdingData;
    const color = hd && parseFloat(hd.totalReturn) >= 0 ? '#E4393C' : '#2E8B57';
    return { w: this._canvasW || 340, h: this._canvasH || 180, color };
  },

  drawChart() {
    const result = this._buildChartData();
    if (!result) return;
    const { items: data } = result;
    const ctx = wx.createCanvasContext('navCanvas', this);
    const w = this._canvasW || 340, h = this._canvasH || 180;
    const opts = { w, h, ...this._getChartOpts(), data,
      padding: { top: 24, right: 12, bottom: 30, left: 52 } };
    chart.drawLineChart(ctx, opts);

    // 交易标记点
    const txMap = this.data.chartTxMap || {};
    if (Object.keys(txMap).length > 0) {
      const p = opts.padding;
      const pw = w - p.left - p.right, ph = h - p.top - p.bottom;
      const vals = data.map(d => d.value);
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = max - min || 0.01;
      const yMin = min - range * 0.15, yMax = max + range * 0.15;
      const xp = (i) => p.left + (pw / (data.length - 1)) * i;
      const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
      data.forEach((d, i) => {
        const tx = txMap[d.date];
        if (!tx) return;
        const x = xp(i), y = yp(d.value);
        if (tx.buys > 0 && tx.sells > 0) {
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI);
          ctx.setStrokeStyle('#2E8B57'); ctx.setLineWidth(2); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI);
          ctx.setFillStyle('#E4393C'); ctx.fill();
        } else if (tx.buys > 0) {
          ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
          ctx.setFillStyle('#E4393C'); ctx.fill();
        } else if (tx.sells > 0) {
          ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
          ctx.setFillStyle('#2E8B57'); ctx.fill();
        }
      });
    }
    ctx.draw();
    this._baseData = { data, opts };
  },

  onChartTouch(e) {
    if (!this._baseData) return;

    // 滚动方向判断：区分横向滑动（查数据）和纵向滚动（滚页面）
    if (e.type === 'touchstart') {
      this._touchSY = e.touches[0].y;
      this._touchSX = e.touches[0].x;
      this._touchActive = false;
      return;
    }

    if (e.type === 'touchend') {
      this._touchActive = false;
      this.drawChart();
      return;
    }

    if (!this._touchActive) {
      const dy = Math.abs(e.touches[0].y - this._touchSY);
      const dx = Math.abs(e.touches[0].x - this._touchSX);
      if (dy > dx && dy > 8) return;
      if (dx > dy && dx > 8) this._touchActive = true;
    }
    if (!this._touchActive) return;

    // 60fps 节流
    const now = Date.now();
    if (this._touchT && now - this._touchT < 60) return;
    this._touchT = now;

    const { data, opts } = this._baseData;
    const ctx = wx.createCanvasContext('navCanvas', this);
    const p = opts.padding;
    const pw = opts.w - p.left - p.right, ph = opts.h - p.top - p.bottom;
    const vals = data.map(d => d.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 0.01;
    const yMin = min - range * 0.15, yMax = max + range * 0.15;
    const xp = (i) => p.left + (pw / (data.length - 1)) * i;
    const yp = (v) => p.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    const px = e.touches[0].x;
    let nearest = 0, minDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(xp(i) - px);
      if (dist < minDist) { minDist = dist; nearest = i; }
    });

    const pt = data[nearest];
    const cx = xp(nearest), cy = yp(pt.value);

    chart._drawFastLine(ctx, chart._lastDraw, opts);
    ctx.setStrokeStyle('rgba(0,0,0,0.12)');
    ctx.setLineWidth(1);
    ctx.beginPath(); ctx.moveTo(cx, p.top); ctx.lineTo(cx, opts.h - p.bottom); ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.setFillStyle('#FFFFFF'); ctx.fill();
    ctx.setStrokeStyle(opts.color || '#E4393C'); ctx.setLineWidth(2); ctx.stroke();

    const v = pt.value;
    const label = `${pt.date}  ${v != null ? (v >= 0 ? '+' : '') + v : '--'}`;
    ctx.setFontSize(11);
    const tw = label.length * 7 + 8;
    const tx = Math.max(p.left + 4, Math.min(opts.w - p.right - tw - 8, cx - tw / 2));
    const ty = Math.max(p.top + 2, cy - 28);
    ctx.setFillStyle('rgba(0,0,0,0.75)');
    ctx.fillRect(tx, ty, tw, 20);
    ctx.setFillStyle('#FFF');
    ctx.setTextAlign('left');
    ctx.setTextBaseline('middle');
    ctx.fillText(label, tx + 4, ty + 10);
    ctx.draw();
  },

  async onChartPeriod(e) {
    const period = e.currentTarget.dataset.period;
    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260, '3Y': 750 };
    const neededDays = PERIOD_DAYS[period] || 260;
    this.setData({ chartPeriod: period });
    if (this.data.navHistory.length < neededDays) {
      await this.fetchHistory(neededDays + 50);
    }
    this.drawChart();
  },

  async checkHolding() {
    // 客户端直查（不按 _openid 过滤，确保查到数据）
    try {
      const db = wx.cloud.database();
      const cr = await db.collection("holdings").where({ fundCode: this.data.fundCode }).get();
      if (cr.data && cr.data.length > 0) {
        this._rawHolding = cr.data[0];
        this.setData({ hasHolding: true, holdingId: cr.data[0]._id });
        return;
      }
    } catch (e) { console.error("checkHolding 客户端失败:", e); }
  },

  async fetchTransactions() {
    try {
      const res = await api.transactionList(this.data.fundCode);
      const txns = (res.result && res.result.data) || [];
      const map = {};
      // 季度净买入（最近90天）
      const now = new Date();
      const qStart = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
      const qStartStr = calc.formatDate(qStart);
      let quarterNet = 0;
      txns.forEach((tx) => {
        if (!tx.date) return;
        if (tx.date >= qStartStr) {
          const amt = parseFloat(tx.amount) || 0;
          if (tx.type === "buy") quarterNet += amt;
          else if (tx.type === "sell") quarterNet -= amt;
        }
        if (!map[tx.date]) map[tx.date] = { buys: 0, sells: 0 };
        if (tx.type === "buy") map[tx.date].buys++;
        else if (tx.type === "sell") map[tx.date].sells++;
      });
      txns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      this.setData({ chartTxMap: map, transactionList: txns, quarterNet });
    } catch (e) { console.error("获取交易记录失败:", e); }
  },

  enrichHoldingData() {
    if (!this._rawHolding) return;
    const raw = this._rawHolding;
    const { nav, estimatedNav, actualNav } = this.data;
    const yesterdayNav = parseFloat(nav || 0);
    if (!yesterdayNav) return;

    let shares = parseFloat(raw.shares || raw.amount || 0);
    let buyPrice = parseFloat(raw.buyPrice || raw.nav || 0);
    const dbMarketValue = parseFloat(raw.marketValue) || 0;
    const dbHoldingReturn = parseFloat(raw.holdingReturn) || 0;

    const currentNav = calc.selectNav(yesterdayNav, actualNav, estimatedNav);

    // OCR 导入兜底：shares/buyPrice 为 0 时用 DB 中的市值和收益反推
    if ((!shares || !buyPrice) && dbMarketValue > 0 && currentNav > 0) {
      if (!shares) shares = dbMarketValue / currentNav;
      if (!buyPrice && shares > 0) {
        buyPrice = currentNav - (dbHoldingReturn / shares);
        if (buyPrice <= 0) buyPrice = currentNav;
      }
    }

    const displayMarketValue = dbMarketValue > 0 ? dbMarketValue : (currentNav * shares);
    const todayProfit = (currentNav - yesterdayNav) * shares;
    const costValue = buyPrice * shares;
    const totalReturn = dbHoldingReturn || (displayMarketValue - costValue);
    const totalReturnRate = costValue > 0 ? (totalReturn / costValue) * 100 : 0;

    this.setData({
      holdingData: {
        shares: shares.toFixed(2),
        buyPrice: buyPrice.toFixed(4),
        marketValue: displayMarketValue.toFixed(2),
        todayProfit: todayProfit.toFixed(2),
        totalReturn: totalReturn.toFixed(2),
        totalReturnRate: totalReturnRate.toFixed(2),
      },
    });
    this._rawHolding = null;
  },

  onRefresh() {
    const show = !this.data.showTransactions;
    this.setData({ showTransactions: show, scrollToTx: show ? "txSection" : "" });
  },
  onPullDownRefresh() {
    this.fetchAll().finally(() => wx.stopPullDownRefresh());
  },
  onShowMore() { this.setData({ showAllHistory: true }); },
  onShowLess() { this.setData({ showAllHistory: false }); },
  async onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab }, () => {
      if (tab === 'trend') this.drawChart();
    });
    if ((tab === 'holdings' || tab === 'profile') && !this.data.profile) {
      wx.showLoading({ title: '加载中...' });
      await this.fetchProfile();
      wx.hideLoading();
    }
  },
  onImportScreenshot() {
    const _this = this;
    wx.showActionSheet({
      itemList: ["从相册选择", "拍照"],
      success(res) {
        const sourceType = res.tapIndex === 0 ? ["album"] : ["camera"];
        wx.chooseMedia({
          count: 1, mediaType: ["image"], sourceType, sizeType: ["compressed"],
          success(mediaRes) { _this.doOCR(mediaRes.tempFiles[0].tempFilePath); },
        });
      },
    });
  },

  async doOCR(tempPath) {
    wx.showLoading({ title: "识别中..." });
    try {
      const up = await wx.cloud.uploadFile({ cloudPath: `holdings/${Date.now()}.jpg`, filePath: tempPath });
      const res = await api.ocrScreenshot(up.fileID);
      wx.hideLoading();
      if (res.result && res.result.code === 0 && res.result.data) {
        const d = res.result.data;
        const holdings = d.holdings || [];
        if (holdings.length === 0) {
          wx.showToast({ title: "未识别到基金信息", icon: "none" });
          return;
        }
        // 取第一只基金，检查是否匹配当前详情页
        const h = holdings[0];
        if (h.fundName && h.fundName.includes(this.data.fundName)) {
          // 直接添加持仓
          wx.showModal({
            title: "识别结果",
            content: `${h.fundName}\n市值: ${h.marketValue || "--"}\n收益: ${h.holdingReturn || "--"}`,
            confirmText: "添加持仓",
            success: async (mr) => {
              if (!mr.confirm) return;
              wx.showLoading({ title: "添加中..." });
              const db = wx.cloud.database();
              const ui = wx.getStorageSync("userInfo") || {};
              await db.collection("holdings").add({
                data: {
                  fundCode: this.data.fundCode,
                  fundName: this.data.fundName,
                  buyPrice: parseFloat(h.buyPrice || 0),
                  shares: parseFloat(h.shares || 0),
                  marketValue: parseFloat(h.marketValue || 0),
                  holdingReturn: parseFloat(h.holdingReturn || 0),
                  buyAmount: parseFloat(h.buyAmount || 0),
                  _openid: ui.openid || "",
                  createTime: new Date(),
                },
              });
              wx.hideLoading();
              wx.showToast({ title: "添加成功", icon: "success" });
              wx.removeStorageSync("portfolio_cache");
              this.fetchAll();
            },
          });
        } else {
          // 识别到但名称不匹配
          wx.showModal({
            title: "识别结果",
            content: `识别到 ${holdings.length} 个基金，但名称与当前基金不匹配`,
            showCancel: false,
          });
        }
      } else {
        wx.showToast({ title: "识别失败", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "识别失败", icon: "none" });
    }
  },

  onAddHolding() {
    const { fundCode, fundName, hasHolding, holdingId } = this.data;
    if (hasHolding && holdingId) {
      wx.navigateTo({ url: `/pages/add-holding/index?id=${holdingId}` });
    } else {
      wx.navigateTo({ url: `/pages/add-holding/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName)}` });
    }
  },
  onCompare() {
    const { fundCode, fundName } = this.data;
    if (!fundCode || fundCode === "undefined") {
      wx.showToast({ title: "基金信息异常", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/fund-compare/index?fundCode=${fundCode}&fundName=${encodeURIComponent(fundName || "")}`,
      fail: (err) => {
        console.error("跳转对比页失败:", err);
        wx.showToast({ title: err.errMsg || "跳转失败", icon: "none" });
      },
    });
  },
});
