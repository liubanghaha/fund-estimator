const api = require("../../utils/api");

// 记账记录 id 前缀（区分 ledger_records 与 holdings 两个集合）
const LEDGER_PREFIX = "L_";

Page({
  data: {
    theme: "red",
    isEdit: false,
    isLedger: false, // true=记账记录(ledger_records)，false=旧基金记录(holdings)
    id: "",

    // OCR
    ocrLoading: false,
    ocrRows: [],
    ocrSaving: false,
    ocrCheckedCount: 0,

    // 手动表单
    amount: "",
    note: "",
    buyDate: "",
    group: "",
    groups: [],
    showGroupPicker: false,

    // 旧基金记录字段（兼容编辑，仅 isLedger=false 时使用）
    fundCode: "",
    shares: "",

    // 加减仓/交易记录（仅旧基金记录）
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
      this.setData({
        isEdit: true,
        id: options.id,
        isLedger: options.id.indexOf(LEDGER_PREFIX) === 0,
      });
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
    const { id, isLedger } = this.data;
    try {
      if (isLedger) {
        const res = await api.ledgerGet(id.slice(LEDGER_PREFIX.length));
        if (res.result && res.result.code === 0) {
          const r = res.result.data;
          this.setData({
            amount: String(r.amount || ""),
            note: r.note || "",
            buyDate: r.date || "",
            group: r.group || "",
          });
        }
      } else {
        const res = await api.holdingGet(id);
        if (res.result && res.result.code === 0) {
          const h = res.result.data;
          this.setData({
            fundCode: h.fundCode || "",
            shares: String(h.shares || ""),
            amount: String(h.totalCost || h.marketValue || h.buyPrice || ""),
            note: h.fundName || "",
            buyDate: h.buyDate || "",
            group: h.group || "",
          });
        }
        // 加载交易记录
        const txRes = await api.transactionList(this.data.fundCode);
        if (txRes.result && txRes.result.code === 0) {
          this.setData({ transactions: txRes.result.data || [] });
        }
      }
    } catch (e) {
      console.error("加载记录失败:", e);
    }
  },

  async loadGroups() {
    try {
      const res = await api.holdingGetGroups();
      if (res.result && res.result.code === 0) {
        const filtered = (res.result.data || []).filter(g => g && g !== 'all' && g !== 'ungrouped' && g !== '未分组' && g !== '全部');
        this.setData({ groups: filtered });
      }
    } catch (e) { /* ignore */ }
  },

  // ==== OCR（添加记录：只支持截图导入） ====
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
          // 调用OCR（ledger 模式：返回原始文本）
          const ocrRes = await api.ocrLedger(cloudRes.fileID);
          if (ocrRes.result && ocrRes.result.code === 0) {
            const rows = this.parseLedgerText(ocrRes.result.data.raw);
            this.setData({ ocrRows: rows, ocrLoading: false, ocrCheckedCount: rows.length });
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

  // 从原始识别文本中提取金额行（如 ¥123.45 / 123.45元 / 1,234.56）
  parseLedgerText(raw) {
    const lines = String(raw || "").split("\n").map(l => l.trim()).filter(l => l);
    const rows = [];
    for (const line of lines) {
      if (/[%％]/.test(line)) continue; // 跳过百分比
      const m = line.match(/(?:¥|￥)?\s*([\d,]+\.\d{1,2})\s*(?:元)?/);
      if (!m) continue;
      const amount = parseFloat(m[1].replace(/,/g, ""));
      if (!amount || amount <= 0) continue;
      const note = line.replace(m[0], "").replace(/^[\s\-—:：·]+/, "").trim().slice(0, 30);
      rows.push({ amount: amount.toFixed(2), note, _checked: true });
    }
    return rows.slice(0, 50);
  },

  toggleOcrItem(e) {
    const idx = e.currentTarget.dataset.index;
    const rows = this.data.ocrRows.concat();
    rows[idx]._checked = !rows[idx]._checked;
    const count = rows.filter(r => r._checked).length;
    this.setData({ ocrRows: rows, ocrCheckedCount: count });
  },

  onOcrNoteChange(e) {
    const idx = e.currentTarget.dataset.index;
    const rows = this.data.ocrRows.concat();
    rows[idx].note = e.detail.value;
    this.setData({ ocrRows: rows });
  },

  async onOcrSave() {
    const selected = this.data.ocrRows.filter(r => r._checked && r.amount);
    if (selected.length === 0) {
      wx.showToast({ title: "请至少选择一条记录", icon: "none" });
      return;
    }
    this.setData({ ocrSaving: true });
    try {
      for (const r of selected) {
        await api.ledgerAdd({ amount: r.amount, note: r.note, date: "" });
      }
      wx.showToast({ title: `已添加 ${selected.length} 条记录`, icon: "success" });
      wx.removeStorageSync("ledger_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
      setTimeout(() => wx.navigateBack(), 1500);
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

  // ==== 保存修改（仅编辑模式有表单） ====
  async onSave() {
    const { amount, note, buyDate, group, isEdit, id, isLedger, fundCode, shares } = this.data;
    if (!amount || parseFloat(amount) <= 0) { wx.showToast({ title: "请输入有效金额", icon: "none" }); return; }
    if (!isEdit) { wx.showToast({ title: "请先保存记录", icon: "none" }); return; }

    wx.showLoading({ title: "更新中..." });
    try {
      if (isLedger) {
        await api.ledgerUpdate(id.slice(LEDGER_PREFIX.length), {
          amount: parseFloat(amount).toFixed(2),
          note: note.trim(),
          date: buyDate || "",
          group: group || "",
        });
      } else {
        await api.holdingUpdate(id, {
          fundCode: fundCode.trim(),
          fundName: note.trim(),
          shares: parseFloat(shares),
          totalCost: parseFloat(amount).toFixed(2),
          group: group || "",
          buyDate: buyDate || "",
        });
      }
      wx.hideLoading();
      wx.showToast({ title: "已更新", icon: "success" });
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
      content: "确定删除此条记录吗？",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          if (this.data.isLedger) {
            await api.ledgerRemove(this.data.id.slice(LEDGER_PREFIX.length));
          } else {
            await api.holdingRemove(this.data.id);
          }
          wx.showToast({ title: "已删除", icon: "success" });
          wx.removeStorageSync("ledger_cache");
          setTimeout(() => wx.navigateBack(), 1500);
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },

  // ==== 加减仓 / 交易记录（仅旧基金记录） ====
  onToggleTrade() { this.setData({ showTrade: !this.data.showTrade }); },
  onTradeTypeChange(e) { this.setData({ tradeType: e.currentTarget.dataset.type }); },
  onTradeInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  async onSaveTrade() {
    const { tradeType, tradeAmount, tradePrice, tradeDate, fundCode, shares, amount, isEdit } = this.data;
    if (!tradeAmount || parseFloat(tradeAmount) <= 0) { wx.showToast({ title: "请输入金额", icon: "none" }); return; }
    if (!tradePrice || parseFloat(tradePrice) <= 0) { wx.showToast({ title: "请输入价格", icon: "none" }); return; }

    if (!isEdit) {
      wx.showToast({ title: "请先保存记录再加减仓", icon: "none" });
      return;
    }

    const amt = parseFloat(tradeAmount);
    const price = parseFloat(tradePrice);
    const tradeShares = amt / price;
    const sign = tradeType === "buy" ? 1 : -1;
    const newShares = Math.max(0, parseFloat(shares) + sign * tradeShares);
    const newCost = Math.max(0, parseFloat(amount) + sign * amt);

    wx.showLoading({ title: "保存中..." });
    try {
      await api.transactionAdd({
        fundCode,
        fundName: this.data.note,
        type: tradeType,
        amount: amt,
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
        amount: String(newCost.toFixed(2)),
        tradeAmount: "", tradePrice: "", tradeDate: "",
      });
      wx.removeStorageSync("ledger_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },
});
