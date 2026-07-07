const api = {
  callFunction(name, data = {}) {
    return wx.cloud.callFunction({ name, data });
  },
  searchFund(keyword) {
    return this.callFunction("searchFund", { keyword });
  },
  fetchFundEstimate(fundCode) {
    return this.callFunction("fetchFundEstimate", { fundCode });
  },
  getPortfolio(historyDays) {
    return this.callFunction("getPortfolio", historyDays ? { historyDays } : {});
  },
  fetchFundNAVHistory(fundCode, days) {
    return this.callFunction("fetchFundNAVHistory", { fundCode, days });
  },
  fetchFundProfile(fundCode) {
    return this.callFunction("fetchFundProfile", { fundCode });
  },
  fetchFundOverview(fundCode) {
    return this.callFunction("fetchFundOverview", { fundCode });
  },
  fetchFundRank(fundCode, fundType) {
    return this.callFunction("fetchFundRank", { fundCode, fundType });
  },
  userLogin() {
    return this.callFunction("userLogin", {});
  },
  submitFeedback({ content, type, contact, images } = {}) {
    return this.callFunction("submitFeedback", { content, type, contact, images });
  },
  batchAddHoldings(funds) {
    return this.callFunction("batchAddHoldings", { funds });
  },
  ocrScreenshot(fileID) {
    return this.callFunction("ocrScreenshot", { fileID });
  },
  ocrTransaction(fileID) {
    return this.callFunction("ocrTransaction", { fileID });
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
  transactionAdd(data) {
    return this.callFunction("manageTransaction", { action: "add", data });
  },
  transactionList(fundCode) {
    return this.callFunction("manageTransaction", { action: "list", fundCode });
  },
  batchFetchEstimate(codes) {
    return this.callFunction("batchFetchEstimate", { codes });
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

    const doRequest = (url) => new Promise((resolve) => {
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

    const endpoints = [
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${days}`,
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=${secid.split(".")[1]},day,,,${days},qfq`,
    ];

    const tryRequest = async (url, retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        const res = await doRequest(url);
        if (res.code === 0 && res.data && res.data.length > 0) return res;
        if (i < retries) await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
      return { code: 500, msg: "多次重试后仍无数据" };
    };

    return tryRequest(endpoints[0]).then(res => {
      if (res.code === 0) return res;
      return tryRequest(endpoints[1]);
    });
  },

  // 获取指数当天分时数据（客户端直连，绕过云函数 https 限制）
  async fetchIndexIntradayClient(indexCode) {
    const SECID = { "000001": "1.000001", "399001": "0.399001", "000300": "1.000300", "399006": "0.399006" };
    const secid = SECID[indexCode] || "1.000001";
    return new Promise((resolve) => {
      wx.request({
        url: `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=1&fqt=1&end=20500101&lmt=250`,
        header: { Referer: "https://quote.eastmoney.com/" },
        success(res) {
          try {
            const json = res.data;
            const klines = (json.data && json.data.klines) || [];
            if (!klines.length) { resolve({ code: 500, msg: "无分时数据" }); return; }
            const parsed = klines.map(line => {
              const parts = line.split(",");
              return {
                time: parts[0].length >= 16 ? parts[0].slice(11, 16) : parts[0],
                date: parts[0].slice(0, 10),
                close: parseFloat(parts[2]) || 0,
                changeRate: parseFloat(parts[8]) || 0,
              };
            }).filter(d => d.time && d.time.length === 5);
            const dates = [...new Set(parsed.map(d => d.date))].sort();
            const latestDate = dates[dates.length - 1];
            const intraday = parsed.filter(d => d.date === latestDate);
            if (intraday.length < 2) { resolve({ code: 500, msg: "今日数据不足" }); return; }
            resolve({
              code: 0, data: intraday.map(d => ({ time: d.time, close: d.close, changeRate: d.changeRate })),
            });
          } catch (e) { resolve({ code: 500, msg: "解析失败" }); }
        },
        fail() { resolve({ code: 500, msg: "请求失败" }); },
      });
    });
  },

  // 获取指数当天分时数据（腾讯分钟级 API，客户端可用）
  async fetchIndexIntradayTencent(indexCode) {
    const S = { "000001": "sh000001", "399001": "sz399001", "000300": "sh000300", "399006": "sz399006" };
    const code = S[indexCode] || "sh000001";
    // 今日日期 (YYYYMMDD)
    const d = new Date();
    const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return new Promise((resolve) => {
      wx.request({
        url: `https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=min_data&code=${code}`,
        header: { Referer: "https://gu.qq.com/" },
        success(res) {
          try {
            const raw = (typeof res.data === 'string') ? res.data : JSON.stringify(res.data);
            const json = JSON.parse(raw.replace(/^min_data=/, '').trim());
            const stockData = (json.data && json.data[code]) || {};
            const points = (stockData.data && stockData.data.data) || [];
            const apiDate = (stockData.data && stockData.data.date) || '';
            // 日期校验：非今日数据直接返回空（盘前可能返回昨日数据）
            if (apiDate !== today) { resolve({ code: 500, msg: "非今日数据" }); return; }
            if (points.length < 2) { resolve({ code: 500, msg: "分时数据不足" }); return; }
            // 从同一响应中取昨日收盘价（qt.sh000001[4]）
            const qtFields = (stockData.qt && stockData.qt[code]) || [];
            const preClose = parseFloat(qtFields[4]) || parseFloat(points[0].split(' ')[1]);
            if (!preClose) { resolve({ code: 500, msg: "获取昨收失败" }); return; }
            // 格式：["0930 4019.49 3524345 8608767272.90", ...]
            const parsed = points.map(line => {
              const parts = line.split(' ');
              const timeRaw = parts[0];
              const price = parseFloat(parts[1]);
              return {
                time: timeRaw.slice(0, 2) + ':' + timeRaw.slice(2, 4),
                close: price,
                changeRate: +( ((price - preClose) / preClose) * 100 ).toFixed(2),
              };
            });
            resolve({ code: 0, data: parsed });
          } catch (e) { resolve({ code: 500, msg: "解析失败" }); }
        },
        fail() { resolve({ code: 500, msg: "请求失败" }); },
      });
    });
  },

  fetchMarketIndexTencent(indexCode, days = 80) {
    const S = { "000001": "1.000001", "399001": "0.399001", "000300": "1.000300", "399006": "0.399006" };
    const sym = (S[indexCode] || "1.000001").split(".")[1];
    return new Promise((resolve) => {
      wx.request({
        url: `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=${sym},day,,,${days},qfq`,
        header: { Referer: "https://gu.qq.com/" },
        success(res) {
          try {
            const str = res.data.replace(/^(var\s+)?\w+\s*=\s*/, "").replace(/;?\s*$/, "");
            const json = JSON.parse(str);
            const list = (json.data && json.data[sym] && json.data[sym].day) || json.data || [];
            if (!Array.isArray(list) || !list.length) { resolve({ code: 500 }); return; }
            const data = list.map(item => {
              const parts = Array.isArray(item) ? item : typeof item === 'string' ? item.split(",") : [];
              return { date: parts[0] || "", close: +parts[2] || 0 };
            });
            resolve({ code: 0, data });
          } catch (e) { resolve({ code: 500 }); }
        },
        fail() { resolve({ code: 500 }); },
      });
    });
  },
};
module.exports = api;
