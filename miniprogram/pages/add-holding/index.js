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
      this.setData({
        fundCode: h.fundCode, fundName: h.fundName,
        buyPrice: String(h.buyPrice), shares: String(h.shares),
        buyAmount: String(h.buyAmount || ""), buyDate: h.buyDate || "",
      });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
    }
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
          wx.showToast({ title: "未能识别出基金信息", icon: "none" });
          return;
        }
        if (holdings.length === 1) {
          // 单只基金直接填充
          this.fillForm(d);
        } else {
          // 多只基金弹窗多选
          this.setData({
            ocrHoldings: holdings,
            showPicker: true,
            allSelected: true,
            selectedCount: holdings.length,
          });
        }
      } else {
        wx.showToast({ title: "识别失败，请对照截图填写", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ ocrLoading: false });
      wx.showToast({ title: "识别失败，请对照截图填写", icon: "none" });
    }
  },

  fillForm(d) {
    const updates = {};
    if (d.fundCode) updates.fundCode = d.fundCode;
    if (d.fundName) updates.fundName = d.fundName;
    if (d.buyPrice) updates.buyPrice = d.buyPrice;
    if (d.shares) updates.shares = d.shares;
    if (d.buyAmount) updates.buyAmount = d.buyAmount;

    if (Object.keys(updates).length > 0) {
      this.setData(updates);
      wx.showToast({ title: `已识别(${d.method})，请核对`, icon: "success" });
    } else {
      wx.showToast({ title: "未能提取信息，请对照截图填写", icon: "none" });
    }
  },

  // 多选弹窗逻辑
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
      wx.showToast({ title: "请至少选择一个基金", icon: "none" });
      return;
    }

    wx.showLoading({ title: `正在添加 ${selected.length} 个基金...` });
    const db = wx.cloud.database();
    const errors = [];

    for (const h of selected) {
      try {
        await db.collection("holdings").add({
          data: {
            fundCode: h.fundCode || "",
            fundName: h.fundName || "",
            buyPrice: parseFloat(h.buyPrice) || 0,
            shares: parseFloat(h.shares) || 0,
            buyAmount: parseFloat(h.buyAmount) || 0,
            buyDate: "",
            createTime: new Date(),
          },
        });
      } catch (e) {
        errors.push(h.fundName);
      }
    }

    wx.hideLoading();
    this.setData({ showPicker: false });

    if (errors.length > 0) {
      wx.showToast({ title: `${errors.length} 个添加失败`, icon: "none" });
    } else {
      wx.showToast({ title: `已添加 ${selected.length} 个基金`, icon: "success" });
    }
    setTimeout(() => {
      wx.switchTab({ url: "/pages/index/index" });
    }, 800);
  },

  onRemoveScreenshot() {
    this.setData({ screenshotUrl: "" });
  },

  onFundCodeInput(e) { this.setData({ fundCode: e.detail.value }); },
  onFundNameInput(e) { this.setData({ fundName: e.detail.value }); },
  onBuyPriceInput(e) { this.setData({ buyPrice: e.detail.value }); },
  onSharesInput(e) { this.setData({ shares: e.detail.value }); },
  onBuyAmountInput(e) { this.setData({ buyAmount: e.detail.value }); },
  onDateChange(e) { this.setData({ buyDate: e.detail.value }); },
  async onSubmit() {
    const { id, isEdit, fundCode, fundName, buyPrice, shares, buyAmount, buyDate } = this.data;
    if (!fundCode.trim()) { wx.showToast({ title: "请输入基金代码", icon: "none" }); return; }
    if (!fundName.trim()) { wx.showToast({ title: "请输入基金名称", icon: "none" }); return; }
    if (!buyPrice || parseFloat(buyPrice) <= 0) { wx.showToast({ title: "请输入有效的买入净值", icon: "none" }); return; }
    if (!shares || parseFloat(shares) <= 0) { wx.showToast({ title: "请输入有效的份额", icon: "none" }); return; }
    wx.showLoading({ title: "保存中..." });
    try {
      const db = wx.cloud.database();
      const data = {
        fundCode: fundCode.trim(), fundName: fundName.trim(),
        buyPrice: parseFloat(buyPrice), shares: parseFloat(shares),
        buyAmount: parseFloat(buyAmount) || 0, buyDate,
      };
      if (isEdit) {
        await db.collection("holdings").doc(id).update({ data });
      } else {
        data.createTime = new Date();
        await db.collection("holdings").add({ data });
      }
      wx.hideLoading();
      wx.showToast({ title: isEdit ? "更新成功" : "保存成功", icon: "success" });
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
      title: "确认删除", content: "确定要删除这条持仓记录吗？",
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
