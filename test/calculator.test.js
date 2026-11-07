"use strict";
/**
 * calculator.js 核心口径单测（生产级补课 #1）。
 * 这里的每个函数都直接决定用户看到的收益数字——口径类 bug（2026-11 月度 CSV 累加、
 * 回本列表口径分裂）本可在这些用例里拦住。
 */
const { test, eq, ok, approx, setFile } = require("./helpers");
const calc = require("../miniprogram/utils/calculator");

setFile("calculator.test.js");

// ---------- selectNav：净值口径三值选择 ----------
test("selectNav：官方净值已更新（≠昨收）→ 用实际值", () => {
  eq(calc.selectNav(1.5, 1.6, 1.55), 1.6);
});
test("selectNav：官方净值未更新（=昨收）→ 用估算值", () => {
  eq(calc.selectNav(1.5, 1.5, 1.55), 1.55);
});
test("selectNav：无估算 → 回退昨收", () => {
  eq(calc.selectNav(1.5, 1.5, null), 1.5);
});
test("selectNav：全缺失 → NaN 透出（调用方判空）", () => {
  ok(isNaN(calc.selectNav(null, null, null)));
});

// ---------- calcPeriodReturns：区间收益锚点 ----------
// 构造 history：最新在前。2026-11-07 起，每 30 天一个点，nav 线性已知
function makeHist(dates, navs) {
  return dates.map((d, i) => ({ date: d, nav: navs[i], changeRate: 0 }));
}
test("calcPeriodReturns：一年锚点命中 → 正确涨幅", () => {
  const hist = makeHist(
    ["2026-11-07", "2025-11-10", "2025-11-06"],
    [1.5, 1.4, 1.0]
  );
  const r = calc.calcPeriodReturns(hist);
  // year 锚点目标=365 天前=2025-11-07 → 取 date<=2025-11-07 第一条=2025-11-06(1.0)
  approx(r.year, 50.0, "year=(1.5-1.0)/1.0");
});
test("calcPeriodReturns：三年数据不足 → threeYear=null（诚实显示）", () => {
  const hist = makeHist(["2026-11-07", "2024-05-01"], [1.5, 1.0]);
  const r = calc.calcPeriodReturns(hist);
  eq(r.threeYear, null, "1095 天锚点不存在（基金成立不足三年）");
});
test("calcPeriodReturns：锚点日 nav 为 null → 返回 null（不猜）", () => {
  const hist = makeHist(["2026-11-07", "2025-11-10"], [1.5, null]);
  const r = calc.calcPeriodReturns(hist);
  eq(r.year, null);
});
test("calcPeriodReturns：空历史 → 全 null 不抛错", () => {
  const r = calc.calcPeriodReturns([]);
  eq(r.year, null);
  eq(r.day, null);
});

// ---------- calcMaxDrawdown：回撤口径 ----------
test("calcMaxDrawdown：100→50→80 → 回撤 -50%，峰谷日期正确", () => {
  // history 最新在前：2026-11-07(80) ← 2026-10-01(50) ← 2026-09-01(100)
  const hist = makeHist(["2026-11-07", "2026-10-01", "2026-09-01", "2026-08-01", "2026-07-01"], [80, 50, 100, 90, 85]);
  const d = calc.calcMaxDrawdown(hist);
  approx(d.drawdown, -50.0, "最大回撤");
  eq(d.peakDate, "2026-09-01");
  eq(d.troughDate, "2026-10-01");
  approx(d.currentDrawdown, -20.0, "当前距峰值");
});
test("calcMaxDrawdown：序列 <5 条 → null（样本不足不出数）", () => {
  const hist = makeHist(["2026-11-07", "2026-10-01"], [80, 50]);
  eq(calc.calcMaxDrawdown(hist).drawdown, null);
});

// ---------- calcVolatility / calcSharpe：样本守卫 ----------
test("calcVolatility：样本 <20 → null", () => {
  const hist = makeHist(["2026-11-07", "2026-11-06", "2026-11-05"], [1.1, 1.2, 1.3]);
  eq(calc.calcVolatility(hist), null);
});
test("calcSharpe：波动率 0 → null（除零守卫）", () => {
  const navs = [];
  const dates = [];
  for (let i = 0; i < 25; i++) {
    dates.push(`2026-1${String(Math.floor(i / 10)).padStart(1, "0")}-${String(10 + (i % 10)).padStart(2, "0")}`);
    navs.push(1.0); // 完全平坦：波动率 0
  }
  const hist = makeHist(dates.reverse(), navs.slice().reverse());
  eq(calc.calcSharpe(hist), null);
});

// ---------- calcRunningDrawdown：滚动回撤（风险体检同款口径） ----------
test("calcRunningDrawdown：升序序列全程 0 回撤", () => {
  const r = calc.calcRunningDrawdown([{ value: 1 }, { value: 2 }, { value: 3 }]);
  eq(r, [0, 0, 0]);
});
test("calcRunningDrawdown：回撤自峰值计（2026-11-07 排除今天点的口径一致）", () => {
  const r = calc.calcRunningDrawdown([{ value: 100 }, { value: 50 }, { value: 80 }]);
  approx(r[1], -50.0, "距峰值回撤");
  approx(r[2], -20.0, "回升仍距峰值");
});

// ---------- 格式化：金额/百分位 ----------
test("formatMoney：千分位 + 负数 + 可选正号", () => {
  eq(calc.formatMoney(1234567.89), "1,234,567.89");
  eq(calc.formatMoney(-1234.5), "-1,234.50");
  eq(calc.formatMoney(1234.5, true), "+1,234.50");
});
test("formatMoney：非数字 → --", () => {
  eq(calc.formatMoney(NaN), "--");
});
test("formatPercent：±0.005 内归零（防 ±0.00% 抖动）", () => {
  eq(calc.formatPercent(0.004), "0.00%");
  eq(calc.formatPercent(1.234), "+1.23%");
  eq(calc.formatPercent(-1.234), "-1.23%");
});

// ---------- selectChangeRate：当日涨跌口径 ----------
test("selectChangeRate：净值已更新 → 用官方涨跌幅", () => {
  eq(calc.selectChangeRate(1.5, 1.6, 2.1, 6.67), 6.67);
});
test("selectChangeRate：未更新 → 用估算涨跌幅", () => {
  eq(calc.selectChangeRate(1.5, 1.5, 2.1, 6.67), 2.1);
});
