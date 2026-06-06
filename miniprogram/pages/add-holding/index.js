const api = require("../../utils/api");
Page({
  data: {
    mode: "",
    ocrLoading: false,
    screenshotUrl: "",
    ocrFunds: [],
    _editIdx: -1,
    unsavedCount: 0,
    saving: false,
    fundCode: "", fundName: "", buyDate: "",
    holdingReturn: "", holdingReturnAbs: "", holdingSign: 1,
    marketValue: "",
    isEdit: false, id: "",
  },

  onShow() {
    const app = getApp();
    if (app.globalData._ocrFunds && this.data.mode === "screenshot") {
      const funds = app.globalData._ocrFunds;
      app.globalData._ocrFunds = null;
      const unsaved = funds.filter((f) => !f._saved).length;
      this.setData({ ocrFunds: funds, unsavedCount: unsaved });
    }
  },

  onLoad(options) {
    if (options.editScreenshot) {
      const app = getApp();
      const funds = app.globalData._ocrFunds || [];
      app.globalData._ocrFunds = null;
      const idx = parseInt(options.idx) || 0;
      const fund = funds[idx] || {};
      this.setData({
        _editIdx: idx,
        mode: "manual",
        ocrFunds: funds,
        fundCode: fund.fundCode || "",
        fundName: fund.fundName || "",
        marketValue: fund.marketValue || "",
        holdingReturn: fund.holdingReturn || "",
        holdingReturnAbs: fund.holdingReturn ? String(Math.abs(parseFloat(fund.holdingReturn) || 0)) : "",
        holdingSign: parseFloat(fund.holdingReturn) < 0 ? -1 : 1,
      });
      wx.setNavigationBarTitle({ title: "编辑持仓" });
      return;
    }
    if (options.id) {
      this.setData({ isEdit: true, id: options.id, mode: "manual" });
      wx.setNavigationBarTitle({ title: "编辑持仓" });
      this.loadHolding(options.id);
      return;
    }
    if (options.fundCode || options.fundName) {
      this.setData({ mode: "manual" });
      wx.setNavigationBarTitle({ title: "添加持仓" });
      if (options.fundCode) this.setData({ fundCode: options.fundCode });
      if (options.fundName) this.setData({ fundName: decodeURIComponent(options.fundName) });
      return;
    }
    this.setData({ mode: "screenshot" });
    wx.setNavigationBarTitle({ title: "截图添加持仓" });
    if (options.autoScreenshot) {
      wx.nextTick(() => {
        const app = getApp();
        const path = app.globalData._screenshotPath;
        if (path) {
          app.globalData._screenshotPath = null;
          this.doOCR(path);
        }
      });
    }
    if (!this.data.mode) wx.switchTab({ url: "/pages/index/index" });
  },

  // ========== 截图导入 ==========

  onImportScreenshot() {
    const _this = this;
    wx.chooseMedia({
      count: 1, mediaType: ["image"],
      sourceType: ["album"], sizeType: ["compressed"],
      success(mediaRes) {
        _this.doOCR(mediaRes.tempFiles[0].tempFilePath);
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
      const ocrRes = await api.ocrScreenshot(uploadRes.fileID);
      wx.hideLoading();
      this.setData({ ocrLoading: false });

      if (ocrRes.result && ocrRes.result.code === 0 && ocrRes.result.data) {
        const d = ocrRes.result.data;
        const holdings = d.holdings || [];
        if (holdings.length === 0) {
          wx.showToast({ title: "未识别到基金信息", icon: "none" });
          return;
        }
        const funds = holdings.map((h) => ({
          fundCode: h.fundCode || "",
          fundName: h.fundName || "未知基金",
          marketValue: h.marketValue || "",
          holdingReturn: h.holdingReturn || "",
          buyPrice: h.buyPrice || "",
          shares: h.shares || "",
          buyDate: h.buyDate || "",
          buyAmount: h.buyAmount || "",
          _editing: false,
          _saving: false,
          _saved: false,
        }));
        this.setData({ ocrFunds: funds, unsavedCount: funds.length });
      } else {
        wx.showToast({ title: "识别失败", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ ocrLoading: false });
      wx.showToast({ title: "识别失败，请重试", icon: "none" });
    }
  },

  async onSaveAll() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const funds = [...this.data.ocrFunds];
    let added = 0, skipped = 0;
    const skippedCodes = [];

    wx.showLoading({ title: "保存中..." });
    try {
      for (const f of funds) {
        if (f._saved) continue;
        if (!f.fundCode) { skippedCodes.push("无代码"); skipped++; continue; }
        try {
          const db = wx.cloud.database();
          const cr = await db.collection("holdings").where({ fundCode: f.fundCode }).get();
          if (cr.data && cr.data.length > 0) {
            skippedCodes.push(f.fundCode);
            skipped++;
            continue;
          }

          const mv = parseFloat(f.marketValue) || 0;
          const hr = parseFloat(f.holdingReturn) || 0;
          let shares = 0, buyPrice = 0;

          if (mv > 0) {
            const estRes = await api.fetchFundEstimate(f.fundCode);
            if (estRes.result && estRes.result.code === 0) {
              const nav = estRes.result.data.actualNav || estRes.result.data.nav;
              if (nav && nav > 0) {
                shares = parseFloat((mv / nav).toFixed(2));
                buyPrice = parseFloat((nav - hr / shares).toFixed(4));
              }
            }
          }

          await db.collection("holdings").add({
            data: {
              fundCode: f.fundCode, fundName: f.fundName,
              buyPrice: buyPrice || 0,
              shares: shares || 0,
              marketValue: mv,
              holdingReturn: hr,
              buyAmount: shares > 0 && buyPrice > 0 ? parseFloat((shares * buyPrice).toFixed(2)) : 0,
              buyDate: f.buyDate || "",
              createTime: new Date(),
            },
          });
          f._saved = true;
          added++;
          api.watchlistAdd(f.fundCode, f.fundName).catch(() => {});
        } catch (err) {
          console.error("保存失败:", f.fundCode, err);
        }
      }
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
    wx.removeStorageSync("portfolio_cache");
    wx.setStorageSync("portfolio_force_refresh", true);

    const unsaved = funds.filter((f) => !f._saved).length;
    this.setData({ ocrFunds: funds, unsavedCount: unsaved });

    if (skipped > 0) {
      const codeList = skippedCodes.join("\n");
      wx.showModal({
        title: `添加 ${added} 个，${skipped} 个已存在`,
        content: codeList,
        showCancel: false,
        confirmText: added > 0 ? "查看持仓" : "知道了",
        success: () => {
          if (added > 0) { getApp().globalData._ocrFunds = null; wx.switchTab({ url: "/pages/index/index" }); }
        },
      });
    } else {
      wx.showToast({ title: `已添加 ${added} 个`, icon: added > 0 ? "success" : "none" });
      if (added > 0) {
        setTimeout(() => wx.switchTab({ url: "/pages/index/index" }), 800);
      }
    }
  },

  onOcrCodeInput(e) {
    const idx = parseInt(e.currentTarget.dataset.index);
    const funds = [...this.data.ocrFunds];
    funds[idx].fundCode = e.detail.value;
    this.setData({ ocrFunds: funds });
  },

  onEditFund(e) {
    const idx = e.currentTarget.dataset.index;
    const fund = this.data.ocrFunds[idx];
    const app = getApp();
    app.globalData._ocrFunds = this.data.ocrFunds;
    app.globalData._editFundIdx = idx;
    wx.navigateTo({ url: `/pages/add-holding/index?editScreenshot=1&idx=${idx}` });
  },

  onRemoveScreenshot() {
    this.setData({ screenshotUrl: "", ocrFunds: [] });
  },

  onUnload() {
    if (this.data._editIdx >= 0) {
      const app = getApp();
      const funds = app.globalData._ocrFunds || [];
      if (funds[this.data._editIdx]) {
        funds[this.data._editIdx].marketValue = this.data.marketValue;
        funds[this.data._editIdx].holdingReturn = this.data.holdingReturn;
      }
    }
  },

  onBackToCards() {
    this.setData({
      mode: "screenshot", _editIdx: -1,
      fundCode: "", fundName: "", marketValue: "", holdingReturn: "", holdingReturnAbs: "", holdingSign: 1, buyDate: "",
    });
    wx.setNavigationBarTitle({ title: "截图添加持仓" });
  },

  // ========== 手动表单 ==========

  async loadHolding(id) {
    try {
      const db = wx.cloud.database();
      const ui = wx.getStorageSync("userInfo") || {};
      const cr = await db.collection("holdings").where({ _openid: ui.openid || "", _id: id }).get();
      const h = (cr.data && cr.data[0]) || {};
      if (!h._id) {
        const res = await api.holdingGet(id);
        if (res.result && res.result.code === 0 && res.result.data) Object.assign(h, res.result.data);
      }
      if (!h._id) { wx.showToast({ title: "加载失败", icon: "none" }); return; }

      const hr = parseFloat(h.holdingReturn) || 0;
      this.setData({
        fundCode: h.fundCode, fundName: h.fundName,
        marketValue: String(h.marketValue || ""),
        holdingReturn: String(hr),
        holdingReturnAbs: String(Math.abs(hr)),
        holdingSign: hr < 0 ? -1 : 1,
        buyDate: h.buyDate || "",
      });
    } catch (e) {
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  onFundCodeInput(e) { this.setData({ fundCode: e.detail.value }); },
  onFundNameInput(e) { this.setData({ fundName: e.detail.value }); },
  onMarketValueInput(e) { this.setData({ marketValue: e.detail.value }); },
  onHoldingReturnInput(e) {
    this.setData({ holdingReturnAbs: e.detail.value });
    const val = parseFloat(e.detail.value) || 0;
    this.setData({ holdingReturn: String(val * this.data.holdingSign) });
  },
  onToggleHoldingSign() {
    const newSign = this.data.holdingSign > 0 ? -1 : 1;
    const absVal = parseFloat(this.data.holdingReturnAbs) || 0;
    this.setData({ holdingSign: newSign, holdingReturn: String(absVal * newSign) });
  },
  onDateChange(e) { this.setData({ buyDate: e.detail.value }); },

  async onSubmit() {
    const { id, isEdit, fundCode, fundName, holdingReturn, marketValue, buyDate } = this.data;
    if (!fundCode.trim()) { wx.showToast({ title: "请输入基金代码", icon: "none" }); return; }
    if (!fundName.trim()) { wx.showToast({ title: "请输入基金名称", icon: "none" }); return; }
    const mv = parseFloat(marketValue);
    if (!mv || mv <= 0) { wx.showToast({ title: "请输入有效持有金额", icon: "none" }); return; }

    wx.showLoading({ title: "保存中..." });
    try {
      const estRes = await api.fetchFundEstimate(fundCode.trim());
      if (!estRes.result || estRes.result.code !== 0) {
        wx.hideLoading();
        wx.showToast({ title: "获取净值失败", icon: "none" });
        return;
      }
      const nav = estRes.result.data.actualNav || estRes.result.data.nav;
      if (!nav || nav <= 0) {
        wx.hideLoading();
        wx.showToast({ title: "获取净值失败", icon: "none" });
        return;
      }

      const hr = parseFloat(holdingReturn) || 0;
      const shares = parseFloat((mv / nav).toFixed(2));
      const buyPrice = parseFloat((nav - hr / shares).toFixed(4));
      const buyAmount = parseFloat((shares * buyPrice).toFixed(2));

      const db = wx.cloud.database();
      if (!isEdit) {
        const cr = await db.collection("holdings").where({ fundCode: fundCode.trim() }).get();
        if (cr.data && cr.data.length > 0) {
          wx.hideLoading();
          wx.showModal({ title: "重复添加", content: `基金 ${fundCode.trim()} 已在持仓中`, showCancel: false });
          return;
        }
      }
      const data = {
        fundCode: fundCode.trim(), fundName: fundName.trim(),
        buyPrice, shares,
        holdingReturn: hr, marketValue: mv,
        buyAmount, buyDate,
      };
      if (isEdit) {
        await db.collection("holdings").doc(id).update({ data });
      } else {
        data.createTime = new Date();
        await db.collection("holdings").add({ data });
      }
      if (!isEdit) {
        api.watchlistAdd(fundCode.trim(), fundName.trim()).catch(() => {});
      }

      if (this.data._editIdx >= 0 && !isEdit) {
        const funds = [...this.data.ocrFunds];
        funds[this.data._editIdx]._saved = true;
        const unsaved = funds.filter((f) => !f._saved).length;
        this.setData({
          mode: "screenshot", _editIdx: -1, ocrFunds: funds, unsavedCount: unsaved,
          fundCode: "", fundName: "", marketValue: "", holdingReturn: "", holdingReturnAbs: "", holdingSign: 1, buyDate: "",
        });
        wx.setNavigationBarTitle({ title: "截图添加持仓" });
        return;
      }

      setTimeout(() => { wx.navigateBack(); }, 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },

  // ========== 编辑已有持仓 ==========

  // TODO: 微信审核金融功能，同步加减仓暂时注释，后续实现
  // onSyncBuy() {
  //   const { fundCode, fundName } = this.data;
  //   const app = getApp();
  //   app.globalData._syncTradeFund = { fundCode, fundName };
  //   wx.navigateTo({ url: `/pages/sync-trade/index?type=buy&fundCode=${fundCode}` });
  // },
  // onSyncSell() {
  //   const { fundCode, fundName } = this.data;
  //   const app = getApp();
  //   app.globalData._syncTradeFund = { fundCode, fundName };
  //   wx.navigateTo({ url: `/pages/sync-trade/index?type=sell&fundCode=${fundCode}` });
  // },
  async onDelete() {
    const { id, isEdit, fundCode } = this.data;
    if (!isEdit) return;
    wx.showModal({
      title: "确认删除", content: "确定要删除这条持仓及关联交易记录吗？",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const db = wx.cloud.database();
          await db.collection("holdings").doc(id).remove();
          await db.collection("transactions").where({ fundCode: fundCode.trim() }).remove();
          wx.showToast({ title: "已删除", icon: "success" });
          setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },
});
