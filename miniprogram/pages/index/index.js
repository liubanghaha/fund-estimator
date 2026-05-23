const api = require("../../utils/api");

Page({
  data: {
    isLoggedIn: false,
    watchlist: [],
    holdings: [],
    totalAmount: "0.00",
    todayProfit: "0.00",
    todayProfitRate: "0.00",
    totalReturn: "0.00",
    totalReturnRate: "0.00",
    updateTime: "",
    profitHistory: [],
    totalCost: 0,
  },

  onShow() {
    const userInfo = wx.getStorageSync("userInfo");
    if (userInfo && userInfo.loggedIn) {
      this.setData({ isLoggedIn: true });
      this.fetchPortfolio();
      this.fetchWatchlist();
    } else {
      this.setData({ isLoggedIn: false, holdings: [], watchlist: [] });
    }
  },

  async fetchPortfolio() {
    try {
      const res = await api.getPortfolio();
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        this.setData({
          holdings: (d.holdings || []).map((h) => ({ ...h, _swiped: false })),
          totalAmount: d.totalAmount,
          todayProfit: d.todayProfit,
          todayProfitRate: d.todayProfitRate,
          totalReturn: d.totalReturn,
          totalReturnRate: d.totalReturnRate,
          updateTime: d.updateTime || "",
        });
        this.fetchProfitHistory(d.holdings || []);
      }
    } catch (e) {
      console.error("获取持仓失败:", e);
    }
  },

  async fetchProfitHistory(holdings) {
    if (holdings.length === 0) return;
    try {
      const totalCost = holdings.reduce((sum, h) => sum + h.buyPrice * h.shares, 0);
      const histories = await Promise.all(
        holdings.map((h) =>
          api.fetchFundNAVHistory(h.fundCode, 30).catch(() => null)
        )
      );

      const dateMap = {};
      histories.forEach((res, i) => {
        if (!res || !res.result || res.result.code !== 0) return;
        const list = res.result.data;
        if (!list || list.length === 0) return;
        const shares = holdings[i].shares;
        list.forEach((item) => {
          const date = item.date;
          if (!dateMap[date]) dateMap[date] = 0;
          dateMap[date] += item.nav * shares;
        });
      });

      let profitHistory = Object.entries(dateMap)
        .map(([date, value]) => ({ date, value: +value.toFixed(2), profit: +(value - totalCost).toFixed(2) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      if (profitHistory.length > 30) {
        profitHistory = profitHistory.slice(profitHistory.length - 30);
      }

      this.setData({ profitHistory, totalCost });
      setTimeout(() => this.drawProfitChart(), 500);
    } catch (e) {
      console.error("获取收益历史失败:", e);
    }
  },

  drawProfitChart() {
    const history = this.data.profitHistory;
    if (history.length < 2) return;
    const ctx = wx.createCanvasContext('profitCanvas', this);
    const w = 340, h = 180;
    const profits = history.map(d => d.profit);
    const minP = Math.min(...profits), maxP = Math.max(...profits);
    const range = Math.max(maxP - minP, 0.01);
    const pad = range * 0.15;
    const yMin = minP - pad, yMax = maxP + pad;
    const m = { top: 16, right: 8, bottom: 22, left: 8 };
    const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
    const xp = (i) => m.left + (pw / (history.length - 1)) * i;
    const yp = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, w, h);

    const gradient = ctx.createLinearGradient(0, m.top, 0, h - m.bottom);
    const isUp = profits[profits.length - 1] >= profits[0];
    const color = isUp ? '228,57,60' : '46,139,87';
    gradient.addColorStop(0, `rgba(${color},0.12)`);
    gradient.addColorStop(1, `rgba(${color},0.01)`);
    ctx.beginPath();
    history.forEach((d, i) => { const x = xp(i), y = yp(d.profit); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.lineTo(xp(history.length - 1), h - m.bottom);
    ctx.lineTo(xp(0), h - m.bottom);
    ctx.closePath();
    ctx.setFillStyle(gradient);
    ctx.fill();

    ctx.beginPath();
    history.forEach((d, i) => { const x = xp(i), y = yp(d.profit); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.setStrokeStyle(isUp ? '#E4393C' : '#2E8B57');
    ctx.setLineWidth(1.5);
    ctx.stroke();

    ctx.setFillStyle('#999');
    ctx.setFontSize(9);
    ctx.setTextAlign('right');
    ctx.setTextBaseline('middle');
    for (let i = 0; i <= 4; i++) {
      const val = yMax - (yMax - yMin) / 4 * i;
      ctx.fillText(val.toFixed(0), m.left + 52, yp(val));
    }
    ctx.setTextAlign('center');
    ctx.setTextBaseline('top');
    const steps = Math.min(5, history.length);
    for (let i = 0; i < steps; i++) {
      const idx = Math.round((i / (steps - 1)) * (history.length - 1));
      ctx.fillText(history[idx].date.slice(5), xp(idx), h - m.bottom + 4);
    }
    ctx.draw();
  },

  async fetchWatchlist() {
    try {
      const res = await api.watchlistList();
      if (res.result && res.result.code === 0 && res.result.data.length > 0) {
        const items = res.result.data;
        const estimates = await Promise.all(
          items.map((w) => api.fetchFundEstimate(w.fundCode).catch(() => null))
        );
        const watchlist = items.map((w, i) => {
          const e = estimates[i] && estimates[i].result && estimates[i].result.code === 0
            ? estimates[i].result.data : null;
          return {
            fundCode: w.fundCode,
            fundName: w.fundName,
            nav: e ? e.nav : null,
            estimatedNav: e ? e.estimatedNav : null,
            estimatedChangeRate: e ? e.estimatedChangeRate : null,
            estimateTime: e ? e.estimateTime : null,
          };
        });
        this.setData({ watchlist });
      }
    } catch (e) {}
  },
  onTapWatchlist(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onLogin() { wx.navigateTo({ url: "/pages/login/index" }); },
  onSearch() { wx.navigateTo({ url: "/pages/search/index" }); },
  onAdd() { wx.navigateTo({ url: "/pages/add-holding/index" }); },

  // 左滑删除
  onTouchStart(e) {
    const idx = e.currentTarget.dataset.index;
    this._touchData = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, index: idx };
  },

  onTouchEnd(e) {
    if (!this._touchData) return;
    const deltaX = e.changedTouches[0].clientX - this._touchData.startX;
    const deltaY = e.changedTouches[0].clientY - this._touchData.startY;
    const idx = this._touchData.index;
    const holdings = this.data.holdings;

    if (deltaX < -40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
      for (let i = 0; i < holdings.length; i++) {
        if (i !== idx) holdings[i]._swiped = false;
      }
      holdings[idx]._swiped = true;
    } else {
      holdings[idx]._swiped = false;
    }

    this.setData({ holdings });
    this._touchData = null;
  },

  onTapHolding(e) {
    const holdings = this.data.holdings;
    const idx = e.currentTarget.dataset.index;
    if (holdings[idx] && holdings[idx]._swiped) {
      holdings[idx]._swiped = false;
      this.setData({ holdings });
      return;
    }
    const { code, name } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/fund-detail/index?fundCode=${code}&fundName=${encodeURIComponent(name || '')}` });
  },

  onDeleteHolding(e) {
    const id = e.currentTarget.dataset.id;
    const _this = this;
    wx.showModal({
      title: "确认删除",
      content: "确定要删除此持仓记录吗？",
      success(res) {
        if (!res.confirm) return;
        wx.showLoading({ title: "删除中..." });
        wx.cloud.database().collection("holdings").doc(id).remove()
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: "已删除", icon: "success" });
            _this.fetchPortfolio();
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },
});
