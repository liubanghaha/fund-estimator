const api = require("../../utils/api");
const track = require("../../utils/track");
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
    adjustAmount: '', adjustAmountAbs: '', adjustSign: 1,
    adjustDate: '', adjustNote: '',
    showAdjustPicker: false,
  },

  onShow() {
    // 每次显示同步主题色（返回/切换时立即生效）
    const theme = wx.getStorageSync("theme") || "red";
    this.setData({ theme });
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
    wx.chooseMedia({
      count: 1, mediaType: ["image"],
      sourceType: ["album", "camera"], sizeType: ["compressed"],
      success: (mr) => {
        const tempPath = mr.tempFiles[0].tempFilePath;
        // 与加减仓页对齐：先压缩再上传（大截图直传慢且易 OCR 超时）
        wx.compressImage({
          src: tempPath,
          quality: 50,
          success: (cr) => this.doOCR(cr.tempFilePath),
          fail: () => this.doOCR(tempPath),
        });
      },
    });
  },

  async doOCR(tempPath) {
    if (this._ocrRunning) return; // 防重复触发
    this._ocrRunning = true;
    this.setData({ ocrLoading: true, screenshotUrl: tempPath });
    wx.showLoading({ title: "识别中...", mask: true });
    try {
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `screenshots/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`, // 随机段防路径枚举
        filePath: tempPath,
      });
      const ocrRes = await api.ocrScreenshot(uploadRes.fileID);
      wx.hideLoading();
      this.setData({ ocrLoading: false });

      if (ocrRes.result && ocrRes.result.code === 0 && ocrRes.result.data) {
        const d = ocrRes.result.data;
        const holdings = d.holdings || [];
        if (holdings.length === 0) {
          wx.showModal({
            title: '未识别到基金信息',
            content: '请确认截图包含持仓明细，或搜索基金代码添加',
            confirmText: '去搜索',
            cancelText: '好',
            success: (res) => {
              if (res.confirm) wx.navigateTo({ url: '/pages/search/index' });
            },
          });
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
        this._ocrFail(tempPath, '服务暂不可用');
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ ocrLoading: false });
      this._ocrFail(tempPath, '网络异常');
    } finally {
      this._ocrRunning = false;
    }
  },

  // 识别失败兜底：给「重试 / 去搜索」两条出路
  _ocrFail(tempPath, reason) {
    wx.showModal({
      title: '识别失败',
      content: reason + '，可重试识别或搜索基金代码手动添加',
      confirmText: '重试识别',
      cancelText: '去搜索',
      success: (res) => {
        if (res.confirm && tempPath) this.doOCR(tempPath);
        else if (res.cancel) wx.navigateTo({ url: '/pages/search/index' });
      },
    });
  },

  async autoMatchCodes(funds) {
    const codesToSearch = funds.filter((f) => !f.fundCode && f.fundName && f.fundName !== "未知基金");
    if (codesToSearch.length === 0) return;
    // 限并发 4：OCR 多基金时串行（每只最多 3 次搜索）会拖到数十秒
    const CONCURRENT = 4;
    let idx = 0;
    const workers = [];
    const run = async () => {
      while (idx < codesToSearch.length) {
        const f = codesToSearch[idx++];
        try {
          const r = await this.searchFundCodeStrict(f.fundName);
          if (r && r.confident) {
            f.fundCode = r.code;
          } else if (r && r.code) {
            // 低置信匹配（兜底"取第一个结果"）不自动写入：错基金静默入库比留空更糟，
            // 留空代码让用户在卡片上手动补（保存时无代码的卡片会被自然跳过）
            f._needConfirm = true;
          }
        } catch (e) {
          // 搜索失败不阻塞流程
        }
      }
    };
    for (let w = 0; w < Math.min(CONCURRENT, codesToSearch.length); w++) workers.push(run());
    await Promise.all(workers);
    this.setData({ ocrFunds: funds });
  },

  async searchFundCode(name) {
    const r = await this.searchFundCodeStrict(name);
    return r ? r.code : "";
  },

  // 返回 { code, confident }：confident=false 表示只有"取第一个结果"级别的弱匹配
  async searchFundCodeStrict(name) {
    // 策略1：全名搜索
    let r = await this.trySearch(name);
    if (r) return r;

    // 策略2：去掉后缀搜索（ETF联接C / 股票C / 指数C / 混合A 等）
    const shortName = name.replace(/(?:ETF|LOF|QDII|FOF)?\s*联接\s*(?:\(QDII\))?\s*[AC]?\s*$/, "")
      .replace(/(?:混合|股票|指数|债券|货币)\s*[AC]\s*$/, "")
      .replace(/(?:混合|股票|指数|债券|货币)\s*$/, "")
      .trim();
    if (shortName && shortName !== name && shortName.length >= 3) {
      r = await this.trySearch(shortName);
      if (r) return r;
    }

    // 策略3：只取前6个字搜索
    if (name.length > 6) {
      const short = name.replace(/[（(].*$/, "").slice(0, 6);
      r = await this.trySearch(short);
      if (r) return r;
    }

    return null;
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
    // 最后取第一个：这是弱匹配，调用方需让用户确认
    const confident = !!best;
    if (!best) best = results[0];
    const code = best ? (best.code || best.fundCode || "") : "";
    return code ? { code, confident } : null;
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
        wx.showToast({ title: (res.result && res.result.msg) || "保存失败", icon: "none" });
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
      const res = await api.holdingGet(id);
      const h = (res.result && res.result.code === 0 && res.result.data) || {};
      if (!h._id) { wx.showToast({ title: "加载失败", icon: "none" }); return; }

	      // 用当前净值重算市值和收益，与详情页保持一致
	      let mv = parseFloat(h.marketValue) || 0;
	      let hr = parseFloat(h.holdingReturn) || 0;
	      const shares = parseFloat(h.shares) || 0;
	      const buyPrice = parseFloat(h.buyPrice) || 0;
	      try {
	        const estRes = await api.fetchFundEstimate(h.fundCode);
	        const currentNav = ((estRes.result && estRes.result.data && estRes.result.data.actualNav) || (estRes.result && estRes.result.data && estRes.result.data.nav));
	        if (currentNav && shares > 0 && buyPrice > 0) {
	          mv = parseFloat((currentNav * shares).toFixed(2));
	          hr = parseFloat(((currentNav - buyPrice) * shares).toFixed(2));
	        }
	      } catch (e) { /* 获取净值失败，沿用 DB 快照值 */ }

      const group = h.group || "";
      this._rawHolding = h;
      // DB 快照口径备份：预填的重算值只用于展示，用户未改字段时保存仍用快照（防口径漂移）
      this._dbSnapshot = { marketValue: mv, holdingReturn: hr };
      this._formDirty = false;
      this.setData({
	        fundCode: h.fundCode, fundName: h.fundName,
	        marketValue: String(mv || ""),
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
  onMarketValueInput(e) { this._formDirty = true; this.setData({ marketValue: e.detail.value }); },
  onHoldingReturnInput(e) {
    this._formDirty = true;
    this.setData({ holdingReturnAbs: e.detail.value });
    const val = parseFloat(e.detail.value) || 0;
    this.setData({ holdingReturn: String(val * this.data.holdingSign) });
  },
  onToggleHoldingSign() {
    this._formDirty = true;
    const newSign = this.data.holdingSign > 0 ? -1 : 1;
    const absVal = parseFloat(this.data.holdingReturnAbs) || 0;
    this.setData({ holdingSign: newSign, holdingReturn: String(absVal * newSign) });
  },
  onDateChange(e) { this.setData({ buyDate: e.detail.value }); },

  onAdjustInput(e) {
    this._formDirty = true;
    this.setData({ adjustAmountAbs: e.detail.value });
    const val = parseFloat(e.detail.value) || 0;
    this.setData({ adjustAmount: String(val * this.data.adjustSign) });
  },
  onToggleAdjustSign() {
    this._formDirty = true;
    const newSign = this.data.adjustSign > 0 ? -1 : 1;
    const absVal = parseFloat(this.data.adjustAmountAbs) || 0;
    this.setData({ adjustSign: newSign, adjustAmount: String(absVal * newSign) });
  },
  onAdjustFocus() {
    this.setData({ showAdjustPicker: true });
  },
  onAdjustDateChange(e) {
    this.setData({ adjustDate: e.detail.value });
  },
  onAdjustNoteInput(e) {
    this.setData({ adjustNote: e.detail.value });
  },

  async onSubmit() {
    const { id, isEdit, fundCode, fundName, marketValue, buyDate } = this.data;
    let holdingReturn = this.data.holdingReturn;
    if (!fundCode.trim()) { wx.showToast({ title: "请输入基金代码", icon: "none" }); return; }
    if (!fundName.trim()) { wx.showToast({ title: "请输入基金名称", icon: "none" }); return; }
      let mv = parseFloat(marketValue);
      const adjAmount = isEdit ? (parseFloat(this.data.adjustAmount) || 0) : 0;
      if (!adjAmount && (!mv || mv <= 0)) { wx.showToast({ title: "请输入有效持有金额", icon: "none" }); return; }

      // 编辑且用户未改任何字段 → 回用 DB 快照口径：预填的实时重算值只用于展示，
      // 否则不改任何字段直接保存会把 DB 快照悄悄覆盖成估算值（口径漂移）
      if (isEdit && !this._formDirty && this._dbSnapshot) {
        if (this._dbSnapshot.marketValue > 0) mv = this._dbSnapshot.marketValue;
        holdingReturn = String(this._dbSnapshot.holdingReturn || 0);
      }

    if (this._submitting) return; // 防双击并发重复入库
    this._submitting = true;
    wx.showLoading({ title: "保存中...", mask: true });
    try {
      // 查重前置：原来放在取净值之后，重复添加要多等两次网络请求才发现
      if (!isEdit) {
        const chk = await api.holdingCheck(fundCode.trim());
        if (chk.result && chk.result.code === 0 && chk.result.data) {
          wx.hideLoading();
          wx.showModal({ title: "重复添加", content: `基金 ${fundCode.trim()} 已在持仓中`, showCancel: false });
          return;
        }
      }
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
      let shares, buyPrice, finalMV, finalHR;
      const today = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;

      // 处理加减持仓
      if (adjAmount !== 0 && this._rawHolding) {
        const adjDate = this.data.adjustDate || today;
        const h = this._rawHolding;
        const type = adjAmount > 0 ? 'buy' : 'sell';
        const absAmount = Math.abs(adjAmount);
        const adjShares = parseFloat((absAmount / nav).toFixed(2));
        const oldS = parseFloat(h.shares || h.amount || 0);
        const oldP = parseFloat(h.buyPrice || h.nav || 0);
        const oldMV = parseFloat(h.marketValue) || 0;

        if (type === 'sell' && adjShares > oldS) {
          wx.hideLoading();
          wx.showToast({ title: '超出当前份额', icon: 'none' });
          return;
        }

        let ns, np, newMV;
        if (type === 'buy') {
          ns = oldS + adjShares;
          np = (oldP * oldS + nav * adjShares) / ns;
          newMV = +(oldMV + absAmount).toFixed(2);
        } else {
          ns = oldS - adjShares;
          np = oldP;
          newMV = +(oldMV - absAmount).toFixed(2);
        }

        await api.transactionAdd({
          fundCode: fundCode.trim(), fundName: fundName.trim(),
          type, shares: adjShares, price: nav, amount: absAmount, date: adjDate,
          note: this.data.adjustNote.trim() || '',
        });
        track.recordTrade({ source: "add_submit", direction: type, amount: absAmount, amountBand: track.amountBand(absAmount), fundCode: fundCode.trim() });

        shares = ns;
        buyPrice = np;
        finalMV = newMV;
        finalHR = +(newMV - ns * np).toFixed(2);
      } else {
        shares = parseFloat((mv / nav).toFixed(2));
        if (shares <= 0) shares = parseFloat((mv / nav).toFixed(4));
        if (shares <= 0) shares = 0.01;
        buyPrice = parseFloat((nav - hr / shares).toFixed(4));
        if (buyPrice <= 0) {
          // 成本价为负会让后续收益展示全部失真：一般是持有收益输得比市值还大
          wx.hideLoading();
          wx.showToast({ title: "持有收益与金额矛盾，请核对输入", icon: "none" });
          return;
        }
        finalMV = mv;
        finalHR = hr;
      }
      const buyAmount = parseFloat((shares * buyPrice).toFixed(2));
      const data = {
        fundCode: fundCode.trim(), fundName: fundName.trim(),
        buyPrice, shares,
        holdingReturn: finalHR, marketValue: finalMV,
        buyAmount, buyDate,
        group: this.data.selectedGroup || "",
      };
      if (isEdit) {
        await api.holdingUpdate(id, data);
      } else {
        await api.holdingAdd(data);
      }
      if (!isEdit) {
        api.watchlistAdd(fundCode.trim(), fundName.trim()).catch(() => {});
      }

      wx.removeStorageSync('portfolio_cache');
      wx.setStorageSync('portfolio_force_refresh', true);
      this.setData({ adjustAmount: '', adjustAmountAbs: '', adjustSign: 1, adjustDate: '', adjustNote: '', showAdjustPicker: false });

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
    } finally {
      this._submitting = false;
    }
  },

  // ========== 编辑已有持仓 ==========

  async onDelete() {
    const { isEdit } = this.data;
    if (!isEdit) return;
    wx.showModal({
      title: "确认删除", content: "确定要删除这条持仓及关联交易记录吗？",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.holdingRemove(id);
          wx.showToast({ title: "已删除", icon: "success" });
          // 与其它写入路径一致：失效首页缓存，否则删除后切回首页仍显示旧总市值
          wx.removeStorageSync('portfolio_cache');
          wx.setStorageSync('portfolio_force_refresh', true);
          setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      },
    });
  },

  // ========== 调整持仓 ==========

  onAdjust() {
    const h = this._rawHolding;
    if (!h || !h._id) {
      wx.showToast({ title: '数据异常', icon: 'none' });
      return;
    }
    const val = parseFloat(this.data.adjustAmount);
    if (!val || val === 0) {
      wx.showToast({ title: '请输入调整数额', icon: 'none' });
      return;
    }
    this.processAdjust(h, val);
  },

  async processAdjust(h, amount) {
    const type = amount > 0 ? 'buy' : 'sell';
    const absAmount = Math.abs(amount);
    wx.showLoading({ title: '处理中...' });
    try {
      const estRes = await api.fetchFundEstimate(h.fundCode);
      const liveNav = ((estRes.result && estRes.result.data && estRes.result.data.estimatedNav) || (estRes.result && estRes.result.data && estRes.result.data.actualNav) || (estRes.result && estRes.result.data && estRes.result.data.nav));
      const price = parseFloat(liveNav) || 0;
      if (price <= 0) throw new Error('获取净值失败');

      const shares = parseFloat((absAmount / price).toFixed(2));
      const oldS = parseFloat(h.shares || h.amount || 0);
      const oldP = parseFloat(h.buyPrice || h.nav || 0);
      const oldMV = parseFloat(h.marketValue) || 0;
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

      if (type === 'sell' && shares > oldS) {
        wx.hideLoading();
        wx.showToast({ title: '超出当前份额', icon: 'none' });
        return;
      }

      await api.transactionAdd({
        fundCode: h.fundCode, fundName: h.fundName,
        type, shares, price, amount: absAmount, date: today,
      });
      track.recordTrade({ source: "add_adjust", direction: type, amount: absAmount, amountBand: track.amountBand(absAmount), fundCode: h.fundCode });

      let ns, np, newMV;
      if (type === 'buy') {
        ns = oldS + shares;
        np = (oldP * oldS + price * shares) / ns;
        newMV = +(oldMV + absAmount).toFixed(2);
      } else {
        ns = oldS - shares;
        np = oldP;
        newMV = +(oldMV - absAmount).toFixed(2);
      }

      await api.holdingUpdate(h._id, {
        shares: parseFloat(ns.toFixed(4)),
        buyPrice: parseFloat(np.toFixed(4)),
        buyAmount: parseFloat((ns * np).toFixed(2)),
        marketValue: newMV,
        holdingReturn: +(newMV - ns * np).toFixed(2),
      });

      wx.hideLoading();
      wx.showToast({ title: '已更新', icon: 'success' });
      wx.removeStorageSync('portfolio_cache');
      wx.setStorageSync('portfolio_force_refresh', true);
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '处理失败', icon: 'none' });
    }
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
