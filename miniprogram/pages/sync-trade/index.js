const api = require("../../utils/api");

Page({
  data: {
    fundCode: "", fundName: "", tradeType: "buy",
    amount: "", fee: "", netAmount: "",
    dateList: [],
    selectedDate: "",
    selectedDateIdx: -1,
    isAfter3PM: false,
  },

  onLoad(options) {
    const { fundCode, fundName, type } = options;
    const tradeType = type || "buy";
    // 如果 fundName 没通过 URL 传入，从 globalData 读取
    let name = fundName || "";
    if (!name) {
      const app = getApp();
      const cached = app.globalData._syncTradeFund;
      if (cached && cached.fundCode === fundCode) {
        name = cached.fundName;
        app.globalData._syncTradeFund = null;
      }
    }
    this.setData({
      fundCode: fundCode || "",
      fundName: name,
      tradeType,
    });
    wx.setNavigationBarTitle({ title: tradeType === "buy" ? "同步加仓" : "同步减仓" });
    this.buildDateList();
  },

  buildDateList() {
    const list = [];
    const now = new Date();
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      list.push({
        date: dateStr,
        label: `${dateStr} 周${days[d.getDay()]}`,
        isToday: i === 0,
      });
    }
    this.setData({ dateList: list, selectedDate: list[0].date, selectedDateIdx: 0 });
  },

  onDateChange(e) {
    const idx = e.detail.value[0];
    this.setData({ selectedDate: this.data.dateList[idx].date, selectedDateIdx: idx });
  },

  onToggle3PM() {
    this.setData({ isAfter3PM: !this.data.isAfter3PM });
  },

  onAmountInput(e) {
    this.calcNet(e.detail.value, this.data.fee);
  },
  onFeeInput(e) {
    this.calcNet(this.data.amount, e.detail.value);
  },
  calcNet(amountStr, feeStr) {
    const amount = parseFloat(amountStr) || 0;
    const fee = parseFloat(feeStr) || 0;
    const netAmount = Math.max(0, amount - fee).toFixed(2);
    this.setData({ amount: amountStr, fee: feeStr, netAmount });
  },

  async onSubmit() {
    const { netAmount, amount, fee, selectedDate, isAfter3PM, tradeType, fundCode, fundName } = this.data;
    const finalAmount = parseFloat(netAmount) || 0;
    if (finalAmount <= 0) {
      wx.showToast({ title: "请输入有效金额", icon: "none" }); return;
    }
    if (!selectedDate) {
      wx.showToast({ title: "请选择交易日期", icon: "none" }); return;
    }

    // 计算有效日期（三点后算次日）
    let effectiveDate = selectedDate;
    if (isAfter3PM) {
      const d = new Date(selectedDate);
      d.setDate(d.getDate() + 1);
      const pad = (n) => String(n).padStart(2, "0");
      effectiveDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    wx.showLoading({ title: "保存中..." });
    try {

      // 获取当前净值
      let nav = 0, actualNavForMV = 0;
      try {
        const estRes = await api.fetchFundEstimate(fundCode);
        if (estRes.result && estRes.result.code === 0 && estRes.result.data) {
          const ed = estRes.result.data;
          const raw = parseFloat(ed.estimatedNav || ed.actualNav || ed.nav);
          actualNavForMV = parseFloat(ed.actualNav) || 0;
          if (!isNaN(raw) && raw > 0) nav = raw;
        }
      } catch (e) { /* handled below */ }
      if (!nav || nav <= 0) {
        wx.hideLoading();
        wx.showToast({ title: "获取净值失败，请重试", icon: "none" });
        return;
      }

      const price = nav;
      const shares = price > 0 ? parseFloat((finalAmount / price).toFixed(2)) : 0;

      const txData = { fundCode, fundName, type: tradeType, amount: finalAmount, fee: parseFloat(fee) || 0, grossAmount: parseFloat(amount) || 0, shares: parseFloat(shares), price, date: effectiveDate };
      await api.transactionAdd(txData);

      // 2. 更新持仓（客户端直查兜底，兼容 _openid 问题）
      let holding = null;
      const checkRes = await api.holdingCheck(fundCode);
      if (checkRes.result && checkRes.result.code === 0 && checkRes.result.data) {
        holding = checkRes.result.data;
      }
      if (!holding) {
        try {
          const db = wx.cloud.database();
          const cr = await db.collection("holdings").where({ fundCode }).get();
          if (cr.data && cr.data.length > 0) holding = cr.data[0];
        } catch (e) { /* ignore */ }
      }
      if (holding) {
        let oldShares = parseFloat(holding.shares || 0);
        let oldBuyPrice = parseFloat(holding.buyPrice || holding.nav || 0);

        // OCR 导入兜底：shares/buyPrice 为 0 时用市场价值反推
        const fallbackNav = actualNavForMV > 0 ? actualNavForMV : nav;
        if ((!oldShares || !oldBuyPrice) && holding.marketValue && fallbackNav > 0) {
          const mv = parseFloat(holding.marketValue) || 0;
          const hr = parseFloat(holding.holdingReturn) || 0;
          if (!oldShares) oldShares = mv / fallbackNav;
          if (!oldBuyPrice && oldShares > 0) oldBuyPrice = fallbackNav - (hr / oldShares);
          if (!oldBuyPrice || oldBuyPrice <= 0) oldBuyPrice = fallbackNav;
        }

        const oldCost = oldBuyPrice * oldShares;
        const newSharesVal = tradeType === "buy"
          ? oldShares + shares
          : Math.max(0, oldShares - shares);
        const newCost = tradeType === "buy"
          ? oldCost + finalAmount
          : Math.max(0, oldCost - finalAmount);
        const newBuyPrice = newSharesVal > 0 ? newCost / newSharesVal : 0;
        // 市值直接加减交易金额
        const oldMarketValue = parseFloat(holding.marketValue || 0);
        const newMarketValue = +(tradeType === "buy"
          ? oldMarketValue + finalAmount
          : oldMarketValue - finalAmount).toFixed(2);
        const newHoldingReturn = +(newMarketValue - newCost).toFixed(2);
        const updateData = {
          shares: parseFloat(newSharesVal.toFixed(2)),
          buyPrice: parseFloat(newBuyPrice.toFixed(4)),
          buyAmount: parseFloat(newCost.toFixed(2)),
          marketValue: parseFloat(newMarketValue.toFixed(2)),
          holdingReturn: parseFloat(newHoldingReturn.toFixed(2)),
        };
        // 直接客户端更新
        const db = wx.cloud.database();
        await db.collection("holdings").doc(holding._id).update({ data: updateData });
        // 清除首页缓存并强制刷新
        wx.removeStorageSync("portfolio_cache");
        wx.setStorageSync("portfolio_force_refresh", true);
      } else {
        // 新基金没有持仓记录，只保存交易
      }

      wx.hideLoading();
      wx.showToast({ title: "保存成功", icon: "success" });
      setTimeout(() => { wx.navigateBack({ delta: 2 }); }, 800);
    } catch (e) {
      wx.hideLoading();
      console.error("保存失败:", e);
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },
});
