const api = require("../../utils/api");

Page({
  data: {
    theme: "red",
    // 模式
    mode: "manual", // manual | ocr
    isEdit: false,
    id: "",

    // OCR
    ocrLoading: false,
    ocrFunds: [],
    ocrSaving: false,
    ocrCheckedCount: 0,

    // 手动表单
    fundCode: "",
    fundName: "",
    shares: "",
    cost: "",
    buyDate: "",
    group: "",
    groups: [],
    showGroupPicker: false,

    // 加减仓/交易记录
    showTrade: false,
    tradeType: "buy", // buy | sell
    tradeAmount: "",
    tradePrice: "",
    tradeDate: "",
    tradeNote: "",

    // 已有的交易记录
    transactions: [],
  },

  onLoad(options) {
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
    if (options.id) {
      this.setData({ isEdit: true, id: options.id });
    }
  },

  onShow() {
    if (this.data.isEdit && this.data.id) {
      this.loadHolding();
    }
    this.loadGroups();
  },

  // ==== 加载数据 ====
  async loadHolding() {
    try {
      const res = await api.holdingGet(this.data.id);
      if (res.result && res.result.code === 0) {
        const h = res.result.data;
        this.setData({
          fundCode: h.fundCode || "",
          fundName: h.fundName || "",
          shares: String(h.shares || ""),
          cost: String(h.totalCost || h.marketValue || h.buyPrice || ""),
          buyDate: h.buyDate || "",
          group: h.group || "",
        });
      }
      // 加载交易记录
      const txRes = await api.transactionList(this.data.fundCode);
      if (txRes.result && txRes.result.code === 0) {
        this.setData({ transactions: txRes.result.data || [] });
      }
    } catch (e) {
      console.error("加载记录失败:", e);
    }
  },

  async loadGroups() {
    try {
      const res = await api.holdingGetGroups();
      if (res.result && res.result.code === 0) {
        this.setData({ groups: res.result.data || [] });
      }
    } catch (e) { /* ignore */ }
  },

  // ==== 模式切换 ====
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({ mode });
  },

  // ==== OCR ====
  onChooseImage() {
    wx.chooseMedia({
      count: 1, mediaType: ["image"], sourceType: ["album"],
      sizeType: ["compressed"],
      success: async (res) => {
        const tempPath = res.tempFiles[0].tempFilePath;
        this.setData({ ocrLoading: true });
        try {
          // 上传到云存储
          const cloudRes = await wx.cloud.uploadFile({
            cloudPath: `ocr/${Date.now()}.jpg`,
            filePath: tempPath,
          });
          // 调用OCR
          const ocrRes = await api.ocrScreenshot(cloudRes.fileID);
          if (ocrRes.result && ocrRes.result.code === 0) {
            const funds = (ocrRes.result.data || []).map(f => Object.assign({}, f, { _checked: true }));
            this.setData({ ocrFunds: funds, ocrLoading: false, ocrCheckedCount: funds.length });
          } else {
            wx.showToast({ title: (ocrRes.result && ocrRes.result.msg) || "识别失败", icon: "none" });
            this.setData({ ocrLoading: false });
          }
        } catch (e) {
          wx.showToast({ title: "识别失败，请重试", icon: "none" });
          this.setData({ ocrLoading: false });
        }
      },
    });
  },

  toggleOcrItem(e) {
    const idx = e.currentTarget.dataset.index;
    const funds = this.data.ocrFunds.concat();
    funds[idx]._checked = !funds[idx]._checked;
    const count = funds.filter(f => f._checked).length;
    this.setData({ ocrFunds: funds, ocrCheckedCount: count });
  },

  onOcrNameChange(e) {
    const idx = e.currentTarget.dataset.index;
    const funds = this.data.ocrFunds.concat();
    funds[idx].fundName = e.detail.value;
    this.setData({ ocrFunds: funds });
  },

  async onOcrSave() {
    const selected = this.data.ocrFunds.filter(f => f._checked && f.fundCode && f.fundName);
    if (selected.length === 0) {
      wx.showToast({ title: "请至少选择一条记录", icon: "none" });
      return;
    }
    this.setData({ ocrSaving: true });
    try {
      const res = await api.batchAddHoldings(selected);
      if (res.result && res.result.code === 0) {
        wx.showToast({ title: `已添加 ${selected.length} 条记录`, icon: "success" });
        wx.removeStorageSync("portfolio_cache");
        wx.removeStorageSync("ledger_cache");
        wx.setStorageSync("portfolio_force_refresh", true);
        setTimeout(() => wx.navigateBack(), 1500);
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || "保存失败", icon: "none" });
      }
    } catch (e) {
      wx.showToast({ title: "保存失败", icon: "none" });
    }
    this.setData({ ocrSaving: false });
  },

  // ==== 手动表单 ====
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  // ==== 分组选择 ====
  onToggleGroupPicker() { this.setData({ showGroupPicker: !this.data.showGroupPicker }); },
  onSelectGroup(e) {
    this.setData({ group: e.currentTarget.dataset.group || "", showGroupPicker: false });
  },

  // ==== 保存/更新记录 ====
  async onSave() {
    const { fundCode, fundName, shares, cost, buyDate, group, isEdit, id } = this.data;
    if (!fundCode.trim()) { wx.showToast({ title: "请输入产品代码", icon: "none" }); return; }
    if (!fundName.trim()) { wx.showToast({ title: "请输入产品名称", icon: "none" }); return; }
    if (!shares || parseFloat(shares) <= 0) { wx.showToast({ title: "请输入有效份额", icon: "none" }); return; }
    if (!cost || parseFloat(cost) <= 0) { wx.showToast({ title: "请输入有效成本", icon: "none" }); return; }

    wx.showLoading({ title: isEdit ? "更新中..." : "添加中..." });
    try {
      if (isEdit) {
        await api.holdingUpdate(id, {
          fundCode: fundCode.trim(),
          fundName: fundName.trim(),
          shares: parseFloat(shares),
          totalCost: parseFloat(cost).toFixed(2),
          group: group || "",
          buyDate: buyDate || "",
        });
      } else {
        await api.batchAddHoldings([{
          fundCode: fundCode.trim(),
          fundName: fundName.trim(),
          shares: parseFloat(shares),
          totalCost: parseFloat(cost).toFixed(2),
          group: group || "",
          buyDate: buyDate || "",
        }]);
      }
      wx.hideLoading();
      wx.showToast({ title: isEdit ? "已更新" : "已添加", icon: "success" });
      wx.removeStorageSync("portfolio_cache");
      wx.removeStorageSync("ledger_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },

  // ==== 删除 ====
  onDelete() {
    wx.showModal({
      title: "确认删除",
      content: "确定删除此条记录吗？关联的交易记录也会清除。",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.holdingRemove(this.data.id);
          wx.showToast({ title: "已删除", icon: "success" });
          wx.removeStorageSync("portfolio_cache");
          wx.removeStorageSync("ledger_cache");
          setTimeout(() => wx.navigateBack(), 1500);
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },

  // ==== 加减仓 / 交易记录 ====
  onToggleTrade() { this.setData({ showTrade: !this.data.showTrade }); },
  onTradeTypeChange(e) { this.setData({ tradeType: e.currentTarget.dataset.type }); },
  onTradeInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  async onSaveTrade() {
    const { tradeType, tradeAmount, tradePrice, tradeDate, fundCode, fundName, shares, cost, isEdit } = this.data;
    if (!tradeAmount || parseFloat(tradeAmount) <= 0) { wx.showToast({ title: "请输入金额", icon: "none" }); return; }
    if (!tradePrice || parseFloat(tradePrice) <= 0) { wx.showToast({ title: "请输入价格", icon: "none" }); return; }

    if (!isEdit) {
      wx.showToast({ title: "请先保存记录再加减仓", icon: "none" });
      return;
    }

    const amount = parseFloat(tradeAmount);
    const price = parseFloat(tradePrice);
    const tradeShares = amount / price;
    const sign = tradeType === "buy" ? 1 : -1;
    const newShares = Math.max(0, parseFloat(shares) + sign * tradeShares);
    const newCost = Math.max(0, parseFloat(cost) + sign * amount);

    wx.showLoading({ title: "保存中..." });
    try {
      await api.transactionAdd({
        fundCode,
        fundName,
        type: tradeType,
        amount,
        price,
        shares: tradeShares.toFixed(4),
        date: tradeDate || "",
      });
      await api.holdingUpdate(this.data.id, {
        shares: newShares,
        totalCost: newCost.toFixed(2),
      });
      wx.hideLoading();
      wx.showToast({ title: "已记录", icon: "success" });
      this.setData({
        showTrade: false,
        shares: String(newShares),
        cost: String(newCost.toFixed(2)),
        tradeAmount: "", tradePrice: "", tradeDate: "",
      });
      wx.removeStorageSync("portfolio_cache");
      wx.removeStorageSync("ledger_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },
});
