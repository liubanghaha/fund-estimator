const api = require("../../utils/api");
Page({
  data: {
    id: "",
    fundCode: "", fundName: "", buyPrice: "", shares: "", buyAmount: "", buyDate: "",
    isEdit: false, ocrLoading: false,
    screenshotUrl: "",
    ocrHoldings: [],
    showPicker: false,
    allSelected: true,
    selectedCount: 0,
    currentNav: "", holdingReturn: "", marketValue: "",
  },
  onLoad(options) {
    if (options.id) {
      this.setData({ isEdit: true, id: options.id });
      wx.setNavigationBarTitle({ title: "编辑持仓" });
      this.loadHolding(options.id);
    } else {
      wx.setNavigationBarTitle({ title: "添加持仓" });
    }
    if (options.fundCode) this.setData({ fundCode: options.fundCode });
    if (options.fundName) this.setData({ fundName: decodeURIComponent(options.fundName) });
  },
  async loadHolding(id) {
    try {
      const db = wx.cloud.database();
      const res = await db.collection("holdings").doc(id).get();
      const h = res.data;
      const buyPrice = h.buyPrice || h.nav || 0;
      const shares = h.shares || h.amount || 0;
      this.setData({
        fundCode: h.fundCode, fundName: h.fundName,
        buyPrice: String(buyPrice), shares: String(shares),
        buyAmount: String(h.buyAmount || ""), buyDate: h.buyDate || "",
        holdingReturn: String(h.holdingReturn || ""),
        marketValue: String(h.marketValue || ""),
      });
      this.fetchCurrentNav(h.fundCode);
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  async fetchCurrentNav(fundCode) {
    try {
      const res = await api.fetchFundEstimate(fundCode);
      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        const nav = d.actualNav || d.nav;
        if (nav) {
          this.setData({ currentNav: String(nav) });
          // 持有金额 → 自动算份额
          const mv = parseFloat(this.data.marketValue);
          if (!isNaN(mv) && mv > 0) {
            this.setData({ shares: (mv / nav).toFixed(2) });
          }
          // 持有收益 → 自动算买入净值
          this.calcBuyPriceFromReturn();
        }
      }
    } catch (e) { /* ignore */ }
  },

  onImportScreenshot() {
    const _this = this;
    wx.showActionSheet({
      itemList: ["从相册选择", "拍照"],
      success(res) {
        const sourceType = res.tapIndex === 0 ? ["album"] : ["camera"];
        wx.chooseMedia({
          count: 1, mediaType: ["image"],
          sourceType, sizeType: ["compressed"],
          success(mediaRes) {
            _this.doOCR(mediaRes.tempFiles[0].tempFilePath);
          },
        });
      },
    });
  },

  async doOCR(tempPath) {
    this.setData({ ocrLoading: true, screenshotUrl: tempPath });
    wx.showLoading({ title: "识别中..." });

    try {
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `screenshots/${Date.now()}.jpg`,
        filePath: tempPath,
      });

      const ocrRes = await wx.cloud.callFunction({
        name: "ocrScreenshot",
        data: { fileID: uploadRes.fileID },
      });

      wx.hideLoading();
      this.setData({ ocrLoading: false });

      if (ocrRes.result && ocrRes.result.code === 0) {
        const d = ocrRes.result.data;
        const holdings = (d.holdings || []).map((h) => ({ ...h, _checked: true }));
        if (holdings.length === 0) {
          wx.showModal({
            title: "提示",
            content: "未识别到基金信息，请手动输入",
            showCancel: false,
          });
          return;
        }
        if (holdings.length === 1) {
          this.fillForm(d);
        } else {
          this.setData({
            ocrHoldings: holdings,
            showPicker: true,
            allSelected: true,
            selectedCount: holdings.length,
          });
        }
      } else {
        wx.showModal({
          title: "识别失败",
          content: "请检查截图是否清晰，或手动输入",
          showCancel: false,
        });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ ocrLoading: false });
      wx.showModal({
        title: "识别失败",
        content: "请检查截图是否清晰，或手动输入",
        showCancel: false,
      });
    }
  },

  fillForm(d) {
    const updates = {};
    if (d.fundCode) updates.fundCode = d.fundCode;
    if (d.fundName) updates.fundName = d.fundName;
    if (d.buyPrice) updates.buyPrice = d.buyPrice;
    if (d.shares) updates.shares = d.shares;
    if (d.marketValue) updates.marketValue = d.marketValue;
    if (d.holdingReturn) updates.holdingReturn = d.holdingReturn;
    if (d.buyAmount) updates.buyAmount = d.buyAmount;

    if (Object.keys(updates).length > 0) {
      this.setData(updates);
      // 有持有金额或持有收益时，尝试获取净值后自动计算
      if (d.marketValue || d.holdingReturn) {
        const code = d.fundCode || this.data.fundCode;
        if (code && code.length === 6) this.fetchCurrentNav(code);
      }
      wx.showModal({
        title: "识别成功",
        content: "已自动填入持仓信息，请核对后保存",
        showCancel: false,
      });
    } else {
      wx.showModal({
        title: "提示",
        content: "未提取到完整信息，请对照截图手动填写",
        showCancel: false,
      });
    }
  },

  noop() {},

  onToggleItem(e) {
    const idx = e.currentTarget.dataset.index;
    const holdings = this.data.ocrHoldings;
    holdings[idx]._checked = !holdings[idx]._checked;
    const selectedCount = holdings.filter((h) => h._checked).length;
    this.setData({
      ocrHoldings: holdings,
      selectedCount,
      allSelected: selectedCount === holdings.length,
    });
  },

  onSelectAll() {
    const allSelected = !this.data.allSelected;
    const holdings = this.data.ocrHoldings.map((h) => ({ ...h, _checked: allSelected }));
    this.setData({
      ocrHoldings: holdings,
      allSelected,
      selectedCount: allSelected ? holdings.length : 0,
    });
  },

  onPickerCancel() {
    this.setData({ showPicker: false });
  },

  async onPickerConfirm() {
    const selected = this.data.ocrHoldings.filter((h) => h._checked);
    if (selected.length === 0) {
      wx.showToast({ title: "请选择一个基金", icon: "none" });
      return;
    }

    wx.showLoading({ title: "添加中..." });
    const db = wx.cloud.database();
    let added = 0, skipped = 0, failed = 0;

    for (const h of selected) {
      try {
        // Idempotency: check if fund already exists (scoped to current user)
        const openid = (wx.getStorageSync("userInfo") || {}).openid || "";
        const existRes = await db.collection("holdings")
          .where({ _openid: openid, fundCode: h.fundCode })
          .count();
        if (existRes.total > 0) {
          skipped++;
          continue;
        }
        await db.collection("holdings").add({
          data: {
            fundCode: h.fundCode || "",
            fundName: h.fundName || "",
            buyPrice: parseFloat(h.buyPrice) || 0,
            shares: parseFloat(h.shares) || 0,
            marketValue: parseFloat(h.marketValue) || 0,
            holdingReturn: parseFloat(h.holdingReturn) || 0,
            buyAmount: parseFloat(h.buyAmount) || 0,
            buyDate: "",
            createTime: new Date(),
          },
        });
        added++;
      } catch (e) {
        failed++;
      }
    }

    wx.hideLoading();
    this.setData({ showPicker: false });

    const parts = [];
    if (added > 0) parts.push(`成功添加 ${added} 个`);
    if (skipped > 0) parts.push(`${skipped} 个已存在`);
    if (failed > 0) parts.push(`${failed} 个失败`);
    wx.showModal({
      title: "添加结果",
      content: parts.join("\n"),
      showCancel: false,
      success: () => {
        if (added > 0) {
          setTimeout(() => wx.switchTab({ url: "/pages/index/index" }), 300);
        }
      },
    });
  },

  onRemoveScreenshot() {
    this.setData({ screenshotUrl: "" });
  },

  onFundCodeInput(e) {
    this.setData({ fundCode: e.detail.value });
    if (e.detail.value.length === 6) this.fetchCurrentNav(e.detail.value);
  },
  onFundNameInput(e) { this.setData({ fundName: e.detail.value }); },
  onBuyPriceInput(e) { this.setData({ buyPrice: e.detail.value }); },
  onSharesInput(e) { this.setData({ shares: e.detail.value }); },
  onMarketValueInput(e) {
    this.setData({ marketValue: e.detail.value });
    const mv = parseFloat(e.detail.value);
    const nav = parseFloat(this.data.currentNav);
    if (!isNaN(mv) && nav > 0 && mv > 0) {
      this.setData({ shares: (mv / nav).toFixed(2) });
      this.calcBuyPriceFromReturn();
    }
  },
  onHoldingReturnInput(e) {
    this.setData({ holdingReturn: e.detail.value });
    this.calcBuyPriceFromReturn();
  },

  calcBuyPriceFromReturn() {
    const { holdingReturn, shares, currentNav } = this.data;
    const hr = parseFloat(holdingReturn);
    const sh = parseFloat(shares);
    const nav = parseFloat(currentNav);
    if (!isNaN(hr) && sh > 0 && nav > 0) {
      const bp = nav - (hr / sh);
      if (bp > 0) this.setData({ buyPrice: bp.toFixed(4) });
    }
  },
  onBuyAmountInput(e) { this.setData({ buyAmount: e.detail.value }); },
  onDateChange(e) { this.setData({ buyDate: e.detail.value }); },
  async onSubmit() {
    const { id, isEdit, fundCode, fundName, buyPrice, shares, holdingReturn, marketValue, buyAmount, buyDate } = this.data;
    if (!fundCode.trim()) { wx.showToast({ title: "请输入基金代码", icon: "none" }); return; }
    if (!fundName.trim()) { wx.showToast({ title: "请输入基金名称", icon: "none" }); return; }
    if (!buyPrice || parseFloat(buyPrice) <= 0) { wx.showToast({ title: "请输入有效净值", icon: "none" }); return; }
    if (!shares || parseFloat(shares) <= 0) { wx.showToast({ title: "请输入有效份额", icon: "none" }); return; }
    wx.showLoading({ title: "保存中..." });
    try {
      const db = wx.cloud.database();
      if (!isEdit) {
        // Idempotency: check duplicate (scoped to current user)
        const openid = (wx.getStorageSync("userInfo") || {}).openid || "";
        const existRes = await db.collection("holdings")
          .where({ _openid: openid, fundCode: fundCode.trim() })
          .count();
        if (existRes.total > 0) {
          wx.hideLoading();
          wx.showModal({
            title: "重复添加",
            content: `基金 ${fundCode.trim()} 已在持仓中`,
            showCancel: false,
          });
          return;
        }
      }
      const data = {
        fundCode: fundCode.trim(), fundName: fundName.trim(),
        buyPrice: parseFloat(buyPrice), shares: parseFloat(shares),
        holdingReturn: parseFloat(holdingReturn) || 0,
        marketValue: parseFloat(marketValue) || 0,
        buyAmount: parseFloat(buyAmount) || 0, buyDate,
      };
      if (isEdit) {
        await db.collection("holdings").doc(id).update({ data });
      } else {
        data.createTime = new Date();
        await db.collection("holdings").add({ data });
      }
      wx.hideLoading();
      wx.showToast({ title: isEdit ? "更新成功" : "添加成功", icon: "success" });
      setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },
  async onDelete() {
    const { id, isEdit } = this.data;
    if (!isEdit) return;
    wx.showModal({
      title: "确认删除", content: "确定要删除这条持仓吗？",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const db = wx.cloud.database();
          await db.collection("holdings").doc(id).remove();
          wx.showToast({ title: "已删除", icon: "success" });
          setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },
});
