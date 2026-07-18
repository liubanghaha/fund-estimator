import { callFunction as invokeCF } from '../cloudbase';

/**
 * 调用云函数（替代 wx.cloud.callFunction）
 */
async function callFunction(name: string, data: Record<string, unknown> = {}) {
  const res = await invokeCF(name, data);
  return res.result ?? res;
}

/** 自动注入 uid（优先使用绑定的 OPENID，否则用本地 UID） */
function withUid(data: Record<string, unknown> = {}): Record<string, unknown> {
  // 优先绑定的旧账号 OPENID
  const boundOpenid = localStorage.getItem('h5_bound_openid');
  const uid = boundOpenid || localStorage.getItem('h5_uid');
  return uid ? { ...data, testOpenid: uid } : data;
}

/** 获取基金基本信息 */
export function fetchFundInfo(fundCode: string) {
  return callFunction('fetchFundInfo', { fundCode });
}

/** 搜索基金 */
export function searchFund(keyword: string) {
  return callFunction('searchFund', { keyword });
}

/** 获取基金实时估值 */
export function fetchFundEstimate(fundCode: string) {
  return callFunction('fetchFundEstimate', { fundCode });
}

/** 获取持仓组合（估值 + 温度 + 健康分） */
export function getPortfolio(historyDays?: number) {
  return callFunction('getPortfolio', withUid(historyDays ? { historyDays } : {}));
}

/** 获取历史净值 */
export function fetchFundNAVHistory(fundCode: string, days?: number) {
  return callFunction('fetchFundNAVHistory', { fundCode, days });
}

/** 获取基金档案 */
export function fetchFundProfile(fundCode: string) {
  return callFunction('fetchFundProfile', { fundCode });
}

/** 获取基金概览 */
export function fetchFundOverview(fundCode: string) {
  return callFunction('fetchFundOverview', { fundCode });
}

/** 获取基金排名 */
export function fetchFundRank(fundCode: string, fundType?: string) {
  return callFunction('fetchFundRank', { fundCode, fundType });
}

/** 用户登录 */
export function userLogin() {
  return callFunction('userLogin', {});
}

/** 提交反馈 */
export function submitFeedback(params: { content?: string; type?: string; contact?: string; images?: string[] }) {
  return callFunction('submitFeedback', params);
}

/** 批量添加持仓 */
export function batchAddHoldings(funds: unknown[]) {
  return callFunction('batchAddHoldings', { funds });
}

/** OCR 截图识别 */
export function ocrScreenshot(fileID: string) {
  return callFunction('ocrScreenshot', { fileID });
}

export function ocrTransaction(fileID: string) {
  return callFunction('ocrTransaction', { fileID });
}

/** 自选管理 */
export const watchlist = {
  add: (fundCode: string, fundName?: string) =>
    callFunction('manageWatchlist', withUid({ action: 'add', fundCode, fundName })),
  remove: (fundCode: string) =>
    callFunction('manageWatchlist', withUid({ action: 'remove', fundCode })),
  list: () =>
    callFunction('manageWatchlist', withUid({ action: 'list' })),
  check: (fundCode: string) =>
    callFunction('manageWatchlist', withUid({ action: 'check', fundCode })),
  setGroup: (fundCodes: string[], group: string) =>
    callFunction('manageWatchlist', withUid({ action: 'setGroup', fundCodes, group })),
  getGroups: () =>
    callFunction('manageWatchlist', withUid({ action: 'getGroups' })),
  renameGroup: (group: string, newGroup: string) =>
    callFunction('manageWatchlist', withUid({ action: 'renameGroup', group, newGroup })),
  deleteGroup: (group: string) =>
    callFunction('manageWatchlist', withUid({ action: 'deleteGroup', group })),
};

/** 持仓管理 */
export const holding = {
  update: (id: string, data: Record<string, unknown>) =>
    callFunction('manageHolding', withUid({ action: 'update', id, data })),
  remove: (id: string) =>
    callFunction('manageHolding', withUid({ action: 'remove', id })),
  get: (id: string) =>
    callFunction('manageHolding', withUid({ action: 'get', id })),
  check: (fundCode: string) =>
    callFunction('manageHolding', withUid({ action: 'check', data: { fundCode } })),
  setGroup: (fundCodes: string[], group: string) =>
    callFunction('manageHolding', withUid({ action: 'setGroup', fundCodes, group })),
  getGroups: () =>
    callFunction('manageHolding', withUid({ action: 'getGroups' })),
  renameGroup: (group: string, newGroup: string) =>
    callFunction('manageHolding', withUid({ action: 'renameGroup', group, newGroup })),
  deleteGroup: (group: string) =>
    callFunction('manageHolding', withUid({ action: 'deleteGroup', group })),
};

/** 交易记录 */
export const transaction = {
  add: (data: Record<string, unknown>) =>
    callFunction('manageTransaction', withUid({ action: 'add', data })),
  list: (fundCode?: string) =>
    callFunction('manageTransaction', withUid({ action: 'list', fundCode })),
};

/** 批量获取估值 */
export function batchFetchEstimate(codes: string[]) {
  return callFunction('batchFetchEstimate', { codes });
}

/** 获取指数数据（改为云函数代理，H5 浏览器 CORS 限制不能用客户端直连） */
export function fetchMarketIndex(indexCode: string, days?: number) {
  return callFunction('fetchMarketIndex', { indexCode, days });
}

export function fetchIndexIntraday(indexCode: string) {
  return callFunction('fetchIndexIntraday', { indexCode });
}

/** 定投回测 */
export function dcaBacktest(params: Record<string, unknown>) {
  return callFunction('dcaBacktest', params);
}

/** 持仓重合度分析 */
export function computeCorrelation(params?: Record<string, unknown>) {
  return callFunction('computeCorrelation', withUid(params || {}));
}

/** H5 绑定码 */
export const bindH5 = {
  generate: (h5Uid: string) => callFunction('bindH5', { action: 'generate', h5Uid }),
  check: (h5Uid: string) => callFunction('bindH5', { action: 'check', h5Uid }),
};

/** 估值温度 */
export function computeFundTemperature(fundCode: string) {
  return callFunction('computeFundTemperature', { fundCode });
}
