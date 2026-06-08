const api = require("../../utils/api");
const calc = require("../../utils/calculator");

Page({
  data: {
    holdings: [],
    ocrLoading: false,
    ocrResults: [],
    redirecting: false,
    matchedCount: 0,
    loadPercent: 0,
    showPicker: false,
    showForm: false,
    editIndex: -1, editFundCode: "", editFundName: "",
    editCurrentShares: "", editCurrentBuyPrice: "",
    editTxType: "buy", editTxShares: "", editTxPrice: "", editTxAmount: "",
    editPreview: false, editNewShares: "", editNewBuyPrice: "",
    editValid: false, editError: "",
  },

  onLoad(options) {
    // 如果指定了基金，直接跳转 sync-trade 页面（基金名通过 globalData 传递，避免 URL 编码问题）
    if (options.fundCode) {
      this.setData({ redirecting: true });
      wx.redirectTo({ url: `/pages/sync-trade/index?fundCode=${options.fundCode}` });
    }
  },

  onShow() {
    if (this.data.holdings.length === 0) this.loadHoldings();
  },

  onUnload() {
    if (this._loadTimer) { clearInterval(this._loadTimer); this._loadTimer = null; }
  },

  async loadHoldings() {
    try {
      const db = wx.cloud.database();
      const cr = await db.collection("holdings").get();
      const data = cr.data || [];
      this.setData({
        holdings: data.map((h) => {
          const s = h.shares || h.amount || 0;
          const bp = h.buyPrice || h.nav || 0;
          return { ...h, _currentShares: s.toFixed(2), _currentBuyPrice: bp.toFixed(4) };
        }),
      });
    } catch (e) { /* ignore */ }
  },

  // 多层匹配：OCR 识别的基金名 → 持仓中的基金
  matchHolding(ocrName) {
    const holdings = this.data.holdings;
    if (!ocrName || holdings.length === 0) return -1;

    // 第1层：直接包含
    let idx = holdings.findIndex((h) =>
      h.fundName.includes(ocrName) || ocrName.includes(h.fundName)
    );
    if (idx >= 0) return idx;

    // 第2层：去噪包含（去空格括号，保留字母）
    const clean = (s) => s.replace(/[\s（）()]/g, "");
    const cn = clean(ocrName);
    idx = holdings.findIndex((h) => {
      const hn = clean(h.fundName);
      return hn.includes(cn) || cn.includes(hn);
    });
    if (idx >= 0) return idx;

    // 第3层：去掉A/C后缀后再匹配
    const trimAC = (s) => s.replace(/[AC]$/, "");
    const tn = trimAC(clean(ocrName));
    idx = holdings.findIndex((h) => {
      const hn = trimAC(clean(h.fundName));
      return hn.includes(tn) || tn.includes(hn);
    });
    if (idx >= 0) return idx;

    // 第4层：中文关键词重叠（至少3个连续相同中文字符）
    const chineseOnly = (s) => s.replace(/[^一-鿿]/g, "");
    const cn_ocr = chineseOnly(ocrName);
    let bestIdx = -1, bestOverlap = 0;
    holdings.forEach((h, i) => {
      const cn_h = chineseOnly(h.fundName);
      // 找最长公共子串长度
      let maxLen = 0;
      for (let a = 0; a < cn_ocr.length; a++) {
        for (let b = a + 3; b <= cn_ocr.length; b++) {
          if (cn_h.includes(cn_ocr.substring(a, b))) {
            maxLen = Math.max(maxLen, b - a);
          }
        }
      }
      if (maxLen > bestOverlap) { bestOverlap = maxLen; bestIdx = i; }
    });
    if (bestOverlap >= 4) return bestIdx;
    if (idx >= 0) return idx;

    return -1;
  },

  // ==== 截图导入 ====
  onImportScreenshot() {
    wx.showActionSheet({
      itemList: ["从相册选择", "拍照"],
      success: (res) => {
        wx.chooseMedia({
          count: 1, mediaType: ["image"],
          sourceType: res.tapIndex === 0 ? ["album"] : ["camera"],
          sizeType: ["compressed"],
          success: (mr) => this.doOCR(mr.tempFiles[0].tempFilePath),
        });
      },
    });
  },

  drawLoadRing(pct) {
    const ctx = wx.createCanvasContext('loadCanvas', this);
    if (!ctx) return;
    const w = 60, cx = 30, cy = 30, r = 24, lw = 5;
    ctx.clearRect(0, 0, w, w);
    // 底色环
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.setStrokeStyle('#F0F0F0');
    ctx.setLineWidth(lw);
    ctx.setLineCap('round');
    ctx.stroke();
    // 渐变进度弧
    if (pct > 0) {
      const endAngle = (pct / 100) * 2 * Math.PI - Math.PI / 2;
      const gradient = ctx.createLinearGradient(0, 0, w, w);
      gradient.addColorStop(0, '#E4393C');
      gradient.addColorStop(1, '#FF6B6B');
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, endAngle);
      ctx.setStrokeStyle(pct >= 100 ? '#2E8B57' : gradient);
      ctx.setLineWidth(lw);
      ctx.setLineCap('round');
      ctx.stroke();
    }
    // 中间百分比
    ctx.setFillStyle('#333');
    ctx.setFontSize(14);
    ctx.setTextAlign('center');
    ctx.setTextBaseline('middle');
    ctx.fillText(Math.round(pct) + '%', cx, cy);
    ctx.draw();
  },

  async doOCR(tempPath) {
    this.setData({ ocrLoading: true, loadPercent: 0 });
    let pct = 0;
    this._loadTimer = setInterval(() => {
      if (pct < 85) {
        pct = Math.min(pct + 5, 85);
        this.setData({ loadPercent: pct });
        this.drawLoadRing(pct);
      }
    }, 200);
    try {
      const up = await wx.cloud.uploadFile({ cloudPath: `transactions/${Date.now()}.jpg`, filePath: tempPath });
      const res = await api.ocrTransaction(up.fileID);

      if (res.result && res.result.code === 0) {
        const d = res.result.data;
        const txs = d.transactions || (d.fundName ? [d] : []);
        if (txs.length === 0) {
          clearInterval(this._loadTimer);
          this.setData({ ocrLoading: false });
          wx.showToast({ title: "未能识别", icon: "none" });
          return;
        }

        // 匹配持仓
        const matchedList = [];
        for (const tx of txs) {
          let matched = false, idx = -1, currentShares = "", currentBuyPrice = "";
          if (tx.fundName) {
            idx = this.matchHolding(tx.fundName);
            if (idx >= 0) {
              matched = true;
              currentShares = this.data.holdings[idx]._currentShares;
              currentBuyPrice = this.data.holdings[idx]._currentBuyPrice;
            }
          }
          matchedList.push({ tx, matched, idx, currentShares, currentBuyPrice });
        }

        // 并行获取所有匹配基金的实时净值
        const navMap = {};
        const estimateReqs = matchedList
          .filter((m) => m.matched)
          .map((m) =>
            api.fetchFundEstimate(this.data.holdings[m.idx].fundCode)
              .then((r) => {
                if (r.result && r.result.code === 0) {
                  const ed = r.result.data;
                  navMap[this.data.holdings[m.idx].fundCode] = ed.estimatedNav || ed.actualNav || ed.nav || "";
                }
              })
              .catch(() => {})
          );
        await Promise.all(estimateReqs);

        // 组装结果，用实时净值算确认份额
        const results = matchedList.map(({ tx, matched, idx, currentShares, currentBuyPrice }) => {
          let confirmShares = "", liveNav = "";
          if (matched) {
            liveNav = navMap[this.data.holdings[idx].fundCode] || "";
            const amount = parseFloat(tx.amount) || 0;
            const price = parseFloat(tx.price) || parseFloat(liveNav) || 0;
            if (amount > 0 && price > 0) confirmShares = (amount / price).toFixed(2);
          }
          return {
            ...tx,
            amount: tx.amount || "",
            fundCode: tx.fundCode || (idx >= 0 ? this.data.holdings[idx].fundCode : ""),
            matched, _idx: idx, currentShares, currentBuyPrice, confirmShares,
            _liveNav: liveNav,
          };
        });

        clearInterval(this._loadTimer);
        this.setData({ loadPercent: 100 });
        this.drawLoadRing(100);
        setTimeout(() => {
          this.setData({
            ocrLoading: false,
            ocrResults: results,
            matchedCount: results.filter((r) => r.matched).length,
          });
        }, 600);
      } else {
        clearInterval(this._loadTimer);
        this.setData({ ocrLoading: false });
        wx.showToast({ title: "未能识别", icon: "none" });
      }
    } catch (e) {
      clearInterval(this._loadTimer);
      this.setData({ ocrLoading: false });
      wx.showToast({ title: "识别失败", icon: "none" });
    }
  },

  onRemoveItem(e) {
    const idx = e.currentTarget.dataset.index;
    const results = this.data.ocrResults.filter((_, i) => i !== idx);
    this.setData({
      ocrResults: results,
      matchedCount: results.filter((r) => r.matched).length,
    });
  },

  async onConfirmItem(e) {
    const item = this.data.ocrResults[e.currentTarget.dataset.index];
    if (!item || !item.matched) return;
    wx.showLoading({ title: "保存中..." });
    try {
      await this.processItem(item);
      wx.hideLoading();
      wx.showToast({ title: "保存成功", icon: "success" });
      wx.removeStorageSync("portfolio_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
      setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },

  async onConfirmAll() {
    const matched = this.data.ocrResults.filter((item) => item.matched);
    if (matched.length === 0) {
      wx.showToast({ title: "请先将基金加入持仓", icon: "none" });
      return;
    }
    const lines = matched.map((item) => `${item.fundName} ${item.type === 'buy' ? '加仓' : '减仓'} ${item.amount}元`);
    const ok = await new Promise((r) => {
      wx.showModal({
        title: `确认全部（${matched.length}笔）`,
        content: lines.join("\n"),
        success: (res) => r(res.confirm),
        fail: () => r(false),
      });
    });
    if (!ok) return;

    wx.showLoading({ title: "保存中..." });
    let done = 0;
    for (const item of matched) {
      try {
        await this.processItem(item);
        done++;
      } catch (e) {
        console.error("保存交易失败:", item.fundName, e);
      }
    }
    wx.hideLoading();
    if (done > 0) {
      wx.showToast({ title: `已处理 ${done} 笔`, icon: "success" });
      this.setData({ ocrResults: [] });
      wx.removeStorageSync("portfolio_cache");
      wx.setStorageSync("portfolio_force_refresh", true);
      setTimeout(() => { wx.switchTab({ url: "/pages/index/index" }); }, 800);
    } else {
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },

  async processItem(item) {
    const h = this.data.holdings[item._idx];
    if (!h || !h._id) throw new Error("持仓数据异常");
    const amount = parseFloat(item.amount) || 0;
    const liveNav = parseFloat(item._liveNav) || 0;
    const price = parseFloat(item.price) || liveNav || 0;
    if (amount <= 0 || price <= 0) throw new Error("金额或净值无效");
    const shares = (amount / price).toFixed(2);
    const s = parseFloat(shares);
    const type = item.type || "buy";
    let oldS = parseFloat(item.currentShares) || 0;
    let oldP = parseFloat(item.currentBuyPrice) || 0;

    // OCR 导入兜底：shares/buyPrice 为 0 时反推
    if ((!oldS || !oldP) && h.marketValue && liveNav > 0) {
      const mv = parseFloat(h.marketValue) || 0;
      const hr = parseFloat(h.holdingReturn) || 0;
      if (!oldS) oldS = mv / liveNav;
      if (!oldP && oldS > 0) oldP = liveNav - (hr / oldS);
      if (!oldP || oldP <= 0) oldP = liveNav;
    }
    const now = new Date();
    const today = calc.formatDate(now);

    await api.transactionAdd({
      fundCode: h.fundCode, fundName: h.fundName,
      type, shares: s, price, amount,
      date: item.date || today,
    });

    let ns, np;
    const oldMV = parseFloat(h.marketValue) || 0;
    if (type === "buy") { ns = oldS + s; np = (oldP * oldS + price * s) / ns; }
    else { ns = oldS - s; np = oldP; }

    const newMarketValue = type === "buy"
      ? +(oldMV + amount).toFixed(2)
      : +(oldMV - amount).toFixed(2);

    const updateRes = await api.holdingUpdate(h._id, {
      shares: parseFloat(ns.toFixed(4)),
      buyPrice: parseFloat(np.toFixed(4)),
      buyAmount: parseFloat((ns * np).toFixed(2)),
      marketValue: newMarketValue,
      holdingReturn: +(newMarketValue - ns * np).toFixed(2),
    });
    if (!updateRes.result || updateRes.result.code !== 0) {
      throw new Error("持仓更新失败");
    }
  },

  // TODO: 微信审核金融功能，手动加减仓暂时注释，后续实现
  // async onManual() {
  //   wx.showLoading({ title: "加载中..." });
  //   await this.loadHoldings();
  //   wx.hideLoading();
  //   if (this.data.holdings.length === 0) {
  //     wx.showToast({ title: "暂无持仓", icon: "none" });
  //     return;
  //   }
  //   this.setData({ showPicker: true });
  // },
  // onClosePicker() { this.setData({ showPicker: false }); },
  // onSelectFund(e) {
  //   const idx = e.currentTarget.dataset.index;
  //   const h = this.data.holdings[idx];
  //   this.setData({ showPicker: false });
  //   const app = getApp();
  //   app.globalData._syncTradeFund = { fundCode: h.fundCode, fundName: h.fundName };
  //   wx.navigateTo({ url: `/pages/sync-trade/index?fundCode=${h.fundCode}` });
  // },

  // ==== 通用表单 ====
  openForm(idx, h, prefill) {
    this.setData({
      showPicker: false, showForm: true, editIndex: idx,
      editFundCode: h.fundCode, editFundName: h.fundName,
      editCurrentShares: h._currentShares, editCurrentBuyPrice: h._currentBuyPrice,
      editTxType: prefill.type || "buy",
      editTxShares: prefill.shares || "", editTxPrice: prefill.price || "", editTxAmount: prefill.amount || "",
      editPreview: false, editValid: false, editError: "",
    });
    if (prefill.shares && prefill.price) this.recalcEdit();
  },

  onCloseForm() { this.setData({ showForm: false }); },

  onToggleType(e) { this.setData({ editTxType: e.currentTarget.dataset.type }); this.recalcEdit(); },

  onEditInput(e) {
    const field = e.currentTarget.dataset.field;
    const key = field === "shares" ? "editTxShares" : field === "price" ? "editTxPrice" : "editTxAmount";
    this.setData({ [key]: e.detail.value });
    if (field === "shares" || field === "price") {
      const s = parseFloat(field === "shares" ? e.detail.value : this.data.editTxShares);
      const p = parseFloat(field === "price" ? e.detail.value : this.data.editTxPrice);
      if (!isNaN(s) && !isNaN(p) && s > 0 && p > 0) this.setData({ editTxAmount: (s * p).toFixed(2) });
    }
    this.recalcEdit();
  },

  recalcEdit() {
    const oldS = parseFloat(this.data.editCurrentShares) || 0;
    const oldP = parseFloat(this.data.editCurrentBuyPrice) || 0;
    const addS = parseFloat(this.data.editTxShares) || 0;
    const txP = parseFloat(this.data.editTxPrice) || 0;
    const type = this.data.editTxType;

    if (addS <= 0) { this.setData({ editPreview: false, editValid: false }); return; }
    if (type === "sell" && addS >= oldS) {
      this.setData({ editPreview: true, editNewShares: "超额", editValid: false, editError: "减仓份额不能超过当前份额" });
      return;
    }
    if (type === "buy") {
      const ns = oldS + addS;
      const np = ns > 0 ? ((oldP * oldS + txP * addS) / ns) : oldP;
      this.setData({ editPreview: true, editNewShares: ns.toFixed(2), editNewBuyPrice: np.toFixed(4), editValid: true, editError: "" });
    } else {
      this.setData({ editPreview: true, editNewShares: (oldS - addS).toFixed(2), editNewBuyPrice: this.data.editCurrentBuyPrice, editValid: true, editError: "" });
    }
  },

  async onSubmitOne() {
    if (!this.data.editValid) return;
    const h = this.data.holdings[this.data.editIndex];
    const s = parseFloat(this.data.editTxShares);
    const p = parseFloat(this.data.editTxPrice);
    const oldS = parseFloat(this.data.editCurrentShares);
    const oldP = parseFloat(this.data.editCurrentBuyPrice);
    const type = this.data.editTxType;

    const ok = await new Promise((r) => {
      wx.showModal({
        title: type === "buy" ? "确认加仓" : "确认减仓",
        content: `${h.fundName}\n${this.data.editCurrentShares} → ${this.data.editNewShares} 份`,
        success: (res) => r(res.confirm),
      });
    });
    if (!ok) return;

    wx.showLoading({ title: "保存中..." });
    try {
      const amt = parseFloat(this.data.editTxAmount) || (s * p);
      const now = new Date();
      const today = calc.formatDate(now);

      await api.transactionAdd({
        fundCode: h.fundCode, fundName: h.fundName, type, shares: s, price: p, amount: amt, date: today,
      });

      let ns, np;
      if (type === "buy") { ns = oldS + s; np = (oldP * oldS + p * s) / ns; }
      else { ns = oldS - s; np = oldP; }

      await api.holdingUpdate(h._id, {
        shares: parseFloat(ns.toFixed(4)),
        buyPrice: parseFloat(np.toFixed(4)),
        buyAmount: parseFloat((ns * np).toFixed(2)),
        });

      wx.hideLoading();
      wx.showToast({ title: type === "buy" ? "加仓成功" : "减仓成功", icon: "success" });
      this.setData({ showForm: false, ocrResults: [] });
      this.loadHoldings();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  },

  noop() {},
});
