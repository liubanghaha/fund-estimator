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
    // 分组
    groups: [],
    groupPickerRange: ["未分组"],
    groupPickerIndex: 0,
    selectedGroup: "",
  },

  onShow() {
    const app = getApp();
    if (app.globalData._ocrFunds && this.data.mode === "screenshot") {
      const funds = app.globalData._ocrFunds;
      app.globalData._ocrFunds = null;
      const unsaved = funds.filter((f) => !f._saved).length;
      this.setData({ ocrFunds: funds, unsavedCount: unsaved });
    }
    // 加载已有分组列表（不影响主流程）
    this.loadGroups().catch(() => {});
  },

  onLoad(options) {
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
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
    wx.showActionSheet({
      itemList: ["从相册选择"],
      success: () => {
        wx.chooseMedia({
          count: 1, mediaType: ["image"],
          sourceType: ["album"], sizeType: ["compressed"],
          success: (mr) => this.doOCR(mr.tempFiles[0].tempFilePath),
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
      const ocrRes = await api.ocrScreenshot(uploadRes.fileID);
      wx.hideLoading();
      this.setData({ ocrLoading: false });

      if (ocrRes.result && ocrRes.result.code === 0 && ocrRes.result.data) {
        const d = ocrRes.result.data;
        const holdings = d.holdings || [];
        if (holdings.length === 0) {
          wx.showToast({ title: "未识别到有效信息", icon: "none" });
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
        // 自动按名称匹配基金代码
        this.autoMatchCodes(funds);
      } else {
        console.error("[doOCR] ocr failed:", JSON.stringify(ocrRes));
        wx.showToast({ title: "识别失败", icon: "none" });
      }
    } catch (e) {
      console.error("[doOCR] exception:", e.message);
      wx.hideLoading();
      this.setData({ ocrLoading: false });
      wx.showToast({ title: "识别失败，请重试", icon: "none" });
    }
  },

  async autoMatchCodes(funds) {
    const codesToSearch = funds.filter((f) => !f.fundCode && f.fundName && f.fundName !== "未知基金");
    if (codesToSearch.length === 0) return;
    for (const f of codesToSearch) {
      try {
        f.fundCode = await this.searchFundCode(f.fundName);
      } catch (e) {
        // 搜索失败不阻塞流程
      }
    }
    this.setData({ ocrFunds: funds });
  },

  async searchFundCode(name) {
    // 策略1：全名搜索
    let code = await this.trySearch(name);
    if (code) return code;

    // 策略2：去掉后缀搜索（ETF联接C / 股票C / 指数C / 混合A 等）
    const shortName = name.replace(/(?:ETF|LOF|QDII|FOF)?\s*联接\s*(?:\(QDII\))?\s*[AC]?\s*$/, "")
      .replace(/(?:混合|股票|指数|债券|货币)\s*[AC]\s*$/, "")
      .replace(/(?:混合|股票|指数|债券|货币)\s*$/, "")
      .trim();
    if (shortName && shortName !== name && shortName.length >= 3) {
      code = await this.trySearch(shortName);
      if (code) return code;
    }

    // 策略3：只取前6个字搜索
    if (name.length > 6) {
      const short = name.replace(/[（(].*$/, "").slice(0, 6);
      code = await this.trySearch(short);
      if (code) return code;
    }

    return "";
  },

  async trySearch(keyword) {
    const res = await api.searchFund(keyword);
    if (!res.result || res.result.code !== 0 || !res.result.data || res.result.data.length === 0) return null;
    const results = res.result.data;
    const clean = (s) => (s || "").replace(/\s/g, "").replace(/[（）()]/g, "");
    const kw = clean(keyword);
    // 优先精确匹配
    let best = results.find((r) => clean(r.fundName || r.name) === kw);
    // 其次包含匹配
    if (!best) {
      best = results.find((r) => {
        const rn = clean(r.fundName || r.name);
        return rn.includes(kw) || kw.includes(rn);
      });
    }
    // 前缀匹配（前6个字符一致）
    if (!best && kw.length >= 6) {
      const prefix = kw.slice(0, 6);
      best = results.find((r) => clean(r.fundName || r.name).startsWith(prefix));
    }
    // 最后取第一个
    if (!best) best = results[0];
    return best ? (best.code || best.fundCode || "") : null;
  },

  async onSaveAll() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const funds = [...this.data.ocrFunds];
    const unsaved = funds.filter(f => !f._saved && f.fundCode);

    if (unsaved.length === 0) {
      this.setData({ saving: false });
      wx.showToast({ title: "无有效持仓可保存", icon: "none" });
      return;
    }

    wx.showLoading({ title: "保存中..." });
    try {
      const res = await api.batchAddHoldings(unsaved.map(f => ({
        fundCode: f.fundCode,
        fundName: f.fundName,
        marketValue: f.marketValue || "",
        holdingReturn: f.holdingReturn || "",
        buyDate: f.buyDate || "",
        shares: f.shares || "",
        buyPrice: f.buyPrice || "",
      })));

      wx.hideLoading();
      this.setData({ saving: false });

      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        // 标记所有未保存为已保存
        for (const f of funds) {
          if (!f._saved && f.fundCode) f._saved = true;
        }
        const remaining = funds.filter(f => !f._saved).length;
        this.setData({ ocrFunds: funds, unsavedCount: remaining });
        wx.removeStorageSync("portfolio_cache");
        wx.setStorageSync("portfolio_force_refresh", true);

        const totalSkipped = (d.skippedList || []).length || d.skipped || 0;
        if (d.added > 0 && totalSkipped > 0) {
          const codeList = (d.skippedList || []).map(s => `${s.name || s.code} 已存在`).join("\n");
          wx.showModal({
            title: `已添加 ${d.added} 个，${totalSkipped} 个已存在`,
            content: codeList,
            showCancel: false,
            confirmText: "查看持仓",
            success: () => {
              getApp().globalData._ocrFunds = null;
              wx.switchTab({ url: "/pages/index/index" });
            },
          });
        } else if (d.added > 0) {
          wx.showToast({ title: `已添加 ${d.added} 个`, icon: "success" });
          setTimeout(() => wx.switchTab({ url: "/pages/index/index" }), 800);
        } else {
          wx.showToast({ title: "所有持仓已存在", icon: "none" });
        }
      } else {
        wx.showToast({ title: res.result?.msg || "保存失败", icon: "none" });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ saving: false });
      console.error("批量保存失败:", e);
      wx.showToast({ title: "网络错误，请重试", icon: "none" });
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
      const group = h.group || "";
      this.setData({
        fundCode: h.fundCode, fundName: h.fundName,
        marketValue: String(h.marketValue || ""),
        holdingReturn: String(hr),
        holdingReturnAbs: String(Math.abs(hr)),
        holdingSign: hr < 0 ? -1 : 1,
        buyDate: h.buyDate || "",
        selectedGroup: group,
      });
      // 更新 picker 选中位置
      const range = this.data.groupPickerRange;
      const idx = range.indexOf(group);
      if (idx >= 0) this.setData({ groupPickerIndex: idx });
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
      let shares = parseFloat((mv / nav).toFixed(2));
      if (shares <= 0) shares = parseFloat((mv / nav).toFixed(4));
      if (shares <= 0) shares = 0.01;
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
        group: this.data.selectedGroup || "",
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

  // ========== 分组选择 ==========

  async loadGroups() {
    try {
      // 优先从缓存读取
      const cached = wx.getStorageSync("holding_groups_cache") || [];
      if (cached.length) {
        this.setData({ groups: cached });
        this.updatePickerRange(cached);
      }
      const res = await api.holdingGetGroups();
      if (res.result && res.result.code === 0) {
        const serverGroups = res.result.data || [];
        const merged = [...new Set([...cached, ...serverGroups])].sort();
        this.setData({ groups: merged });
        this.updatePickerRange(merged);
        if (merged.length !== cached.length) {
          wx.setStorageSync("holding_groups_cache", merged);
        }
      }
    } catch (e) {
      // 静默失败
    }
  },

  updatePickerRange(groups) {
    const safeGroups = Array.isArray(groups) ? groups : [];
    const range = ["未分组", ...safeGroups, "+ 新建分组"];
    const idx = range.indexOf(this.data.selectedGroup);
    this.setData({ groupPickerRange: range, groupPickerIndex: idx >= 0 ? idx : 0 });
  },

  onGroupChange(e) {
    const idx = e.detail.value;
    const { groups } = this.data;
    if (idx === 0) {
      // 未分组
      this.setData({ selectedGroup: "", groupPickerIndex: 0 });
    } else if (idx === groups.length + 1) {
      // 新建分组
      wx.showModal({
        title: "新建分组",
        editable: true,
        placeholderText: "输入分组名称",
        content: "",
        success: (res) => {
          if (!res.confirm || !res.content) return;
          const name = res.content.trim().slice(0, 20);
          if (name) {
            const newGroups = [...groups, name];
            this.setData({ groups: newGroups, selectedGroup: name });
            this.updatePickerRange(newGroups);
            wx.setStorageSync("holding_groups_cache", newGroups);
          }
        },
      });
    } else {
      this.setData({ selectedGroup: groups[idx - 1] || "", groupPickerIndex: idx });
    }
  },
});
