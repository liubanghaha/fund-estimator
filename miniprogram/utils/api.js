const api = {
  callFunction(name, data = {}) {
    return wx.cloud.callFunction({ name, data });
  },
  searchFund(keyword) {
    return this.callFunction("searchFund", { keyword });
  },
  fetchFundInfo(fundCode) {
    return this.callFunction("fetchFundInfo", { fundCode });
  },
  fetchFundEstimate(fundCode) {
    return this.callFunction("fetchFundEstimate", { fundCode });
  },
  getPortfolio() {
    return this.callFunction("getPortfolio", {});
  },
  fetchFundNAVHistory(fundCode, pageSize) {
    return this.callFunction("fetchFundNAVHistory", { fundCode, pageSize });
  },
  fetchFundProfile(fundCode) {
    return this.callFunction("fetchFundProfile", { fundCode });
  },
  userLogin() {
    return this.callFunction("userLogin", {});
  },
  ocrScreenshot(fileID) {
    return this.callFunction("ocrScreenshot", { fileID });
  },
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
  fetchMarketIndex(indexCode, days) {
    return this.callFunction("fetchMarketIndex", { indexCode, days });
  },
};
module.exports = api;
