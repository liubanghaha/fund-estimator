// 持仓体检：纯客户端一致性扫描（读 manageHolding list 原始记录），只读不改数据
const api = require("../../utils/api");

// ========== 体检规则（独立纯函数：输入持仓记录，返回问题项 / null，便于单独阅读） ==========
// 问题项结构：{ type, label, fundCode, fundName, id, desc, meta }

// 规则①：负成本 —— 有份额但成本价 <= 0（历史 OCR 导入、旧版本 bug 写入过的脏数据）
// 老 schema 兜底：与 add-holding/adjust-holding 同口径（shares||amount、buyPrice||nav），
// 否则老记录会被误报"负成本/份额矛盾"
function _sharesOf(h) { return Number(h.shares || h.amount) || 0; }
function _buyPriceOf(h) { return Number(h.buyPrice || h.nav) || 0; }

function checkNegativeCost(h) {
  const shares = _sharesOf(h);
  const buyPrice = _buyPriceOf(h);
  if (!(shares > 0 && buyPrice <= 0)) return null;
  return {
    type: "cost",
    label: "负成本",
    fundCode: h.fundCode,
    fundName: h.fundName || h.fundCode,
    id: h._id,
    desc: "份额 " + shares + "，但成本价为 " + buyPrice + "，无法计算持有收益",
  };
}

// 规则②：重复持仓 —— 同 fundCode 存在多条记录（如重复添加），每条生成一个问题项、逐条可跳校准
function checkDuplicate(list) {
  const groups = {};
  list.forEach((h) => {
    const code = String(h.fundCode || "");
    if (!code) return;
    (groups[code] = groups[code] || []).push(h);
  });
  const issues = [];
  Object.keys(groups).forEach((code) => {
    const arr = groups[code];
    if (arr.length <= 1) return;
    arr.forEach((h) => {
      issues.push({
        type: "duplicate",
        label: "重复持仓",
        fundCode: code,
        fundName: h.fundName || code,
        id: h._id,
        desc: "代码 " + code + " 存在 " + arr.length + " 条持仓记录，可能重复添加",
        meta: "记录ID：" + (h._id || "-"),
      });
    });
  });
  return issues;
}

// 规则③：份额/市值矛盾 —— 份额为 0 却有市值，或有份额有成本却没有市值
function checkSharesMismatch(h) {
  const shares = _sharesOf(h);
  const buyPrice = _buyPriceOf(h);
  const marketValue = Number(h.marketValue) || 0;
  if (shares <= 0 && marketValue > 0) {
    return {
      type: "mismatch",
      label: "份额矛盾",
      fundCode: h.fundCode,
      fundName: h.fundName || h.fundCode,
      id: h._id,
      desc: "份额为 " + shares + " 但市值为 " + marketValue + " 元，数据自相矛盾",
    };
  }
  if (marketValue <= 0 && shares > 0 && buyPrice > 0) {
    return {
      type: "mismatch",
      label: "份额矛盾",
      fundCode: h.fundCode,
      fundName: h.fundName || h.fundCode,
      id: h._id,
      desc: "份额 " + shares + "、成本 " + buyPrice + "，但市值为 0，请校准份额",
    };
  }
  return null;
}

// 规则④：无估值覆盖 —— 968 开头的互认基金，东财不收录，无盘中估值/温度（提示性）
function checkNoEstimate(h) {
  const code = String(h.fundCode || "");
  if (!/^968/.test(code)) return null;
  return {
    type: "noestimate",
    label: "无估值覆盖",
    fundCode: code,
    fundName: h.fundName || code,
    id: h._id,
    desc: "互认基金（968 开头），数据源不收录，无盘中估值与温度，收益按净值计算",
  };
}

// 汇总执行：单条规则①③④逐持仓检查，规则②需全量列表做分组对比
function runChecks(list) {
  const issues = [];
  list.forEach((h) => {
    [checkNegativeCost, checkSharesMismatch, checkNoEstimate].forEach((fn) => {
      const issue = fn(h);
      if (issue) issues.push(issue);
    });
  });
  return issues.concat(checkDuplicate(list));
}

Page({
  data: {
    theme: "red",
    status: "loading", // loading | error | empty | done
    total: 0,
    issueCount: 0,
    issues: [],
  },

  onLoad() {
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
    this.runCheck();
  },

  onShow() {
    // 主题可能在本页停留期间被其他页切换，返回时同步一次
    this.setData({ theme: wx.getStorageSync("theme") || "red" });
  },

  runCheck() {
    this.setData({ status: "loading" });
    api.holdingList().then((res) => {
      const r = res.result || {};
      if (r.code !== 0 || !Array.isArray(r.data)) {
        this.setData({ status: "error" });
        return;
      }
      const holdings = r.data;
      if (!holdings.length) {
        this.setData({ status: "empty" });
        return;
      }
      const issues = runChecks(holdings);
      this.setData({
        status: "done",
        total: holdings.length,
        issueCount: issues.length,
        issues,
      });
    }).catch(() => {
      this.setData({ status: "error" });
    });
  },

  onRetry() {
    this.runCheck();
  },

  // 去校准：跳详情页「我的持仓 → 校准」入口
  onGoCalibrate(e) {
    const code = e.currentTarget.dataset.code;
    const name = e.currentTarget.dataset.name || "";
    wx.navigateTo({
      url: "/subpackages/analysis/pages/fund-detail/index?fundCode=" + code + "&fundName=" + encodeURIComponent(name),
    });
  },
});
