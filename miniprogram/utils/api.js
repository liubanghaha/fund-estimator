const api = {
  // 请求去重缓存：相同参数 5s 内复用 Promise
  _pending: {},
  _pendingTs: {},

  callFunction(name, data = {}) {
    const key = name + "|" + JSON.stringify(data);
    const now = Date.now();
    if (this._pending[key] && now - (this._pendingTs[key] || 0) < 5000) {
      return this._pending[key];
    }
    const p = wx.cloud.callFunction({ name, data });
    this._pending[key] = p;
    this._pendingTs[key] = now;
    p.finally(() => {
      if (this._pending[key] === p) {
        delete this._pending[key];
        delete this._pendingTs[key];
      }
    });
    return p;
  },

  // === 用户 ===
  userLogin() {
    return this.callFunction("userLogin", {});
  },
  submitFeedback({ content, type, contact, images } = {}) {
    return this.callFunction("submitFeedback", { content, type, contact, images });
  },

  // === 搜索 ===
  searchFund(keyword) {
    return this.callFunction("searchFund", { keyword });
  },

  // === 持仓管理 ===
  getPortfolio(historyDays) {
    return this.callFunction("getPortfolio", historyDays ? { historyDays } : {});
  },
  batchAddHoldings(funds) {
    return this.callFunction("batchAddHoldings", { funds });
  },
  holdingUpdate(id, data) {
    return this.callFunction("manageHolding", { action: "update", id, data });
  },
  holdingRemove(id) {
    return this.callFunction("manageHolding", { action: "remove", id });
  },
  holdingGet(id) {
    return this.callFunction("manageHolding", { action: "get", id });
  },
  holdingCheck(fundCode) {
    return this.callFunction("manageHolding", { action: "check", data: { fundCode } });
  },
  holdingSetGroup(fundCodes, group) {
    return this.callFunction("manageHolding", { action: "setGroup", fundCodes, group });
  },
  holdingGetGroups() {
    return this.callFunction("manageHolding", { action: "getGroups" });
  },
  holdingRenameGroup(group, newGroup) {
    return this.callFunction("manageHolding", { action: "renameGroup", group, newGroup });
  },
  holdingDeleteGroup(group) {
    return this.callFunction("manageHolding", { action: "deleteGroup", group });
  },

  // === 自选管理 ===
  watchlistAdd(fundCode, fundName) {
    return this.callFunction("manageWatchlist", { action: "add", fundCode, fundName });
  },
  watchlistRemove(fundCode) {
    return this.callFunction("manageWatchlist", { action: "remove", fundCode });
  },
  watchlistList() {
    return this.callFunction("manageWatchlist", { action: "list" });
  },
  watchlistCheck(fundCode) {
    return this.callFunction("manageWatchlist", { action: "check", fundCode });
  },
  watchlistSetGroup(fundCodes, group) {
    return this.callFunction("manageWatchlist", { action: "setGroup", fundCodes, group });
  },
  watchlistGetGroups() {
    return this.callFunction("manageWatchlist", { action: "getGroups" });
  },
  watchlistRenameGroup(group, newGroup) {
    return this.callFunction("manageWatchlist", { action: "renameGroup", group, newGroup });
  },
  watchlistDeleteGroup(group) {
    return this.callFunction("manageWatchlist", { action: "deleteGroup", group });
  },

  // === 记账记录 ===
  ledgerList() {
    return this.callFunction("manageLedger", { action: "list" });
  },
  ledgerGet(id) {
    return this.callFunction("manageLedger", { action: "get", id });
  },
  ledgerAdd(data) {
    return this.callFunction("manageLedger", { action: "add", data });
  },
  ledgerUpdate(id, data) {
    return this.callFunction("manageLedger", { action: "update", id, data });
  },
  ledgerRemove(id) {
    return this.callFunction("manageLedger", { action: "remove", id });
  },
  ledgerSetGroup(ids, group) {
    return this.callFunction("manageLedger", { action: "setGroup", ids, group });
  },

  // === 交易记录 ===
  transactionAdd(data) {
    return this.callFunction("manageTransaction", { action: "add", data });
  },
  transactionList(fundCode) {
    return this.callFunction("manageTransaction", { action: "list", fundCode });
  },

  // === OCR ===
  ocrScreenshot(fileID) {
    return this.callFunction("ocrScreenshot", { fileID });
  },
  ocrLedger(fileID) {
    return this.callFunction("ocrScreenshot", { fileID, mode: "ledger" });
  },
  ocrTransaction(fileID) {
    return this.callFunction("ocrTransaction", { fileID });
  },
};

module.exports = api;
