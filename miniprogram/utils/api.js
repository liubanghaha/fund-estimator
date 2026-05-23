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
  fetchMarketIndexClient(indexCode, days = 80) {
    const INDEX_SECID = {
      "000001": "1.000001",
      "399001": "0.399001",
      "000300": "1.000300",
      "399006": "0.399006",
    };
    const secid = INDEX_SECID[indexCode] || "1.000001";
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`;
    return new Promise((resolve, reject) => {
      wx.request({
        url,
        header: { Referer: "https://quote.eastmoney.com/" },
        success(res) {
          try {
            const json = res.data;
            const klines = (json.data && json.data.klines) || [];
            const list = klines.map((line) => {
              const parts = line.split(",");
              return {
                date: parts[0],
                open: parseFloat(parts[1]) || 0,
                close: parseFloat(parts[2]) || 0,
                high: parseFloat(parts[3]) || 0,
                low: parseFloat(parts[4]) || 0,
                volume: parseFloat(parts[5]) || 0,
                amount: parseFloat(parts[6]) || 0,
                amplitude: parseFloat(parts[7]) || 0,
                changeRate: parseFloat(parts[8]) || 0,
                changeAmount: parseFloat(parts[9]) || 0,
                turnover: parseFloat(parts[10]) || 0,
              };
            });
            resolve({ code: 0, data: list });
          } catch (e) {
            resolve({ code: 500, msg: e.message });
          }
        },
        fail(err) {
          resolve({ code: 500, msg: err.errMsg || "请求失败" });
        },
      });
    });
  },
};
module.exports = api;
