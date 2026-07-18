const api = {
  callFunction(name, data = {}) {
    return wx.cloud.callFunction({ name, data });
  },

  // === 用户 ===
  userLogin() {
    return this.callFunction("userLogin", {});
  },
  submitFeedback({ content, type, contact, images } = {}) {
    return this.callFunction("submitFeedback", { content, type, contact, images });
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
  ocrTransaction(fileID) {
    return this.callFunction("ocrTransaction", { fileID });
  },

  // === 数据迁移 ===
  exportData() {
    return this.callFunction("transferData", { action: "export" });
  },
  importData(code) {
    return this.callFunction("transferData", { action: "import", code });
  },
};

module.exports = api;
