const api = require("../../utils/api");
const calc = require("../../utils/calculator");

Page({
  data: {
    fundCode: "", fundName: "", loading: true, errorMsg: "",
    nav: null, estimatedNav: null, estimatedChangeRate: null, estimateTime: "",
    actualNav: "", actualDate: "", actualChangeRate: null,
    navHistory: [],
    todayReturn: null, weekReturn: null, monthReturn: null,
    threeMonthReturn: null, sixMonthReturn: null, yearReturn: null,
    profile: null, manager: null, holdings: [],
    hasHolding: false, holdingId: null, holdingData: null, followed: false, activeTab: "trend",
    showAllHistory: false,
    isTrading: false,
    chartPeriod: '1M',
    chartTxMap: {},
    transactionList: [],
    showTransactions: false,
    scrollToTx: "",
  },

  onLoad(options) {
    if (!options.fundCode) return;
    const fundName = options.fundName ? decodeURIComponent(options.fundName) : "基金详情";
    this.setData({ fundCode: options.fundCode, fundName });
    wx.setNavigationBarTitle({ title: fundName });
    this._firstLoad = true;
    this.fetchAll();
  },

  onShow() {
    // 从子页面返回时刷新数据
    if (this._firstLoad) { this._firstLoad = false; return; }
    const { fundCode } = this.data;
    if (!fundCode) return;
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
    try {
      await Promise.all([this.fetchEstimate(), this.fetchHistory(), this.checkFollow(), this.checkHolding(), this.fetchTransactions()]);
      this.updateDisplay();
      this.enrichHoldingData();
      this.setData({ loading: false });
      setTimeout(() => this.drawChart(), 500);
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
    const { estimatedChangeRate, actualChangeRate, nav, actualNav } = this.data;
    // 与 getPortfolio 逻辑一致：实际净值已更新用实际涨跌幅，否则有估算用估算
    let displayChangeRate;
    if (actualNav != null && nav != null && parseFloat(actualNav) !== nav) {
      displayChangeRate = actualChangeRate;
    } else if (estimatedChangeRate != null) {
      displayChangeRate = estimatedChangeRate;
    } else {
      displayChangeRate = actualChangeRate;
    }
    this.setData({ isTrading, displayChangeRate });
  },

  async fetchEstimate() {
    try {
      const res = await api.fetchFundEstimate(this.data.fundCode);
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        const actualCR = d.actualChangeRate != null ? d.actualChangeRate : this.data.actualChangeRate;
        const yesterdayNav = d.nav != null ? d.nav : this.data.nav;
        const actNavRaw = d.actualNav != null ? d.actualNav : parseFloat(this.data.actualNav);
        let displayCR;
        if (actNavRaw != null && yesterdayNav != null && actNavRaw !== yesterdayNav) {
          displayCR = actualCR;
        } else if (d.estimatedChangeRate != null) {
          displayCR = d.estimatedChangeRate;
        } else {
          displayCR = actualCR;
        }
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
        this.setData({
          profile: p, manager: res.result.data.manager,
          holdings: res.result.data.holdings || [],
        });
      }
    } catch (e) { console.error("获取基金档案失败:", e); }
  },

  calcReturns(history) {
    const r = calc.calcPeriodReturns(history);
    const { displayChangeRate } = this.data;
    this.setData({
      todayReturn: displayChangeRate != null ? displayChangeRate : (r.day || 0),
      weekReturn: r.week, monthReturn: r.month, threeMonthReturn: r.threeMonth,
      sixMonthReturn: r.sixMonth, yearReturn: r.year,
    });
  },

  drawChart() {
    const history = this.data.navHistory;
    if (history.length < 2) return;
    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260 };
    const days = PERIOD_DAYS[this.data.chartPeriod] || 260;
    const sliced = history.slice(0, days);
    if (sliced.length < 2) return;
    const ctx = wx.createCanvasContext('navCanvas', this);
    const w = 340, h = 180;
    const data = [...sliced].reverse();
    const navs = data.map(d => d.nav);
    const minNav = Math.min(...navs), maxNav = Math.max(...navs);
    const range = maxNav - minNav || 0.01;
    const pad = range * 0.15;
    const yMin = minNav - pad, yMax = maxNav + pad;
    const m = { top: 16, right: 8, bottom: 22, left: 56 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (data.length - 1)) * i;
    const yp = (nav) => m.top + ph - ((nav - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, w, h);

    const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
    gradient.addColorStop(0, 'rgba(228,57,60,0.12)');
    gradient.addColorStop(1, 'rgba(228,57,60,0.01)');
    ctx.beginPath();
    data.forEach((d, i) => { const x = xp(i), y = yp(d.nav); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.lineTo(xp(data.length - 1), h - m.bottom);
    ctx.lineTo(xp(0), h - m.bottom);
    ctx.closePath();
    ctx.setFillStyle(gradient);
    ctx.fill();

    ctx.beginPath();
    data.forEach((d, i) => { const x = xp(i), y = yp(d.nav); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.setStrokeStyle('#E4393C');
    ctx.setLineWidth(1.5);
    ctx.stroke();

    ctx.setFillStyle('#999');
    ctx.setFontSize(9);
    ctx.setTextAlign('right');
    ctx.setTextBaseline('middle');
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(4), m.left - 4, yp(val));
    }
    ctx.setTextAlign('center');
    ctx.setTextBaseline('top');
    const steps = Math.min(5, data.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (data.length - 1));
      ctx.fillText(data[idx].date.slice(5), xp(idx), h - m.bottom + 4);
    }
    // 交易标记点
    const txMap = this.data.chartTxMap || {};
    let hasTx = false;
    data.forEach((d, i) => {
      const tx = txMap[d.date];
      if (!tx) return;
      const x = xp(i), y = yp(d.nav);
      if (tx.buys > 0 && tx.sells > 0) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI);
        ctx.setStrokeStyle('#2E8B57');
        ctx.setLineWidth(2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.setFillStyle('#E4393C');
        ctx.fill();
      } else if (tx.buys > 0) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.setFillStyle('#E4393C');
        ctx.fill();
      } else if (tx.sells > 0) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.setFillStyle('#2E8B57');
        ctx.fill();
      }
      hasTx = true;
    });

    ctx.draw();
  },

  async onChartPeriod(e) {
    const period = e.currentTarget.dataset.period;
    const PERIOD_DAYS = { '1M': 22, '3M': 66, '6M': 132, '1Y': 260 };
    const neededDays = PERIOD_DAYS[period] || 260;
    this.setData({ chartPeriod: period });
    if (this.data.navHistory.length < neededDays) {
      await this.fetchHistory(Math.min(neededDays + 20, 280));
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
        const raw = cr.data[0];
        console.log("=== 详情页 checkHolding ===");
        console.log("DB原始数据:", JSON.stringify({ _id: raw._id, shares: raw.shares, buyPrice: raw.buyPrice, buyAmount: raw.buyAmount, marketValue: raw.marketValue, holdingReturn: raw.holdingReturn, nav: raw.nav, amount: raw.amount }));
        return;
      }
    } catch (e) { console.error("checkHolding 客户端失败:", e); }
  },

  async fetchTransactions() {
    try {
      const res = await api.transactionList(this.data.fundCode);
      const txns = (res.result && res.result.data) || [];
      const map = {};
      txns.forEach((tx) => {
        if (!tx.date) return;
        if (!map[tx.date]) map[tx.date] = { buys: 0, sells: 0 };
        if (tx.type === "buy") map[tx.date].buys++;
        else if (tx.type === "sell") map[tx.date].sells++;
      });
      txns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      this.setData({ chartTxMap: map, transactionList: txns });
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

    // 选择当前净值：与 getPortfolio 云函数逻辑一致
    // 如果今日实际净值已更新且与昨日不同，用实际净值；否则用估算净值
    const actualNavNum = parseFloat(actualNav);
    const estimatedNavNum = parseFloat(estimatedNav);
    let currentNav;
    if (actualNavNum != null && actualNavNum !== yesterdayNav) {
      currentNav = actualNavNum;
    } else if (estimatedNavNum != null) {
      currentNav = estimatedNavNum;
    } else {
      currentNav = actualNavNum || yesterdayNav;
    }

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
    this.setData({ activeTab: tab });
    if (tab === 'trend') {
      setTimeout(() => this.drawChart(), 300);
    } else if ((tab === 'holdings' || tab === 'profile') && !this.data.profile) {
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
      const res = await wx.cloud.callFunction({ name: "ocrScreenshot", data: { fileID: up.fileID } });
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
