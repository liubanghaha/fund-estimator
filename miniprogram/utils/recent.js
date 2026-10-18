// 最近查看的基金（R6，本地存储）：首页空态「最近查看」+ 搜索行关注的共用数据源。
// 最多 10 条，按 code 去重、新在前；读取失败静默返回空数组（不能阻塞首页空态）。
// 不做云端同步——本地存储即可（需求 R6.5）
const KEY = "recent_funds";
const MAX = 10;

function addFund(code, name) {
  if (!code) return;
  try {
    const list = (wx.getStorageSync(KEY) || []).filter(r => r && r.code !== code);
    list.unshift({ code, name: name || "", ts: Date.now() });
    wx.setStorageSync(KEY, list.slice(0, MAX));
  } catch (e) { /* ignore */ }
}

function getRecentFunds(limit) {
  try {
    const list = wx.getStorageSync(KEY);
    if (!Array.isArray(list)) return [];
    return limit ? list.slice(0, limit) : list;
  } catch (e) { return []; }
}

module.exports = { addFund, getRecentFunds };
