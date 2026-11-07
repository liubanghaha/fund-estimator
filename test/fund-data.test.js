"use strict";
/**
 * _shared/fund-data.js 核心口径单测（生产级补课 #1）。
 * pickEstimate 是四个估值入口共用的源选择口径（estimate-source-no-silent-switch 纪律的
 * 执行点）——"缺值不换源/不静默"的每一条规则都在这里。
 */
const { test, eq, approx, setFile } = require("./helpers");
const fd = require("../cloudfunctions/_shared/fund-data");

setFile("fund-data.test.js");

// ---------- pickEstimate：估值源选择矩阵 ----------
const BASE = { todayStr: "2026-11-07", now: Date.now() };

test("pickEstimate：数据源一新浪有值 → 永远优先（本轮真值）", () => {
  const r = fd.pickEstimate({ ...BASE, pref: "sina", sinaRate: -1.2, sinaTime: "14:30", sinaNav: 1.23, selfRate: -0.9 });
  eq(r.source, "sina");
  approx(r.rate, -1.2);
  approx(r.nav, 1.23);
});
test("pickEstimate：数据源二自算有值 → 自算优先，无 nav 字段", () => {
  const r = fd.pickEstimate({ ...BASE, pref: "self", sinaRate: -1.2, selfRate: -0.9, selfTime: "14:30" });
  eq(r.source, "self");
  approx(r.rate, -0.9);
  eq(r.nav, null);
});
test("pickEstimate：数据源二自算缺 → 新浪兜底（原行为保持）", () => {
  const r = fd.pickEstimate({ ...BASE, pref: "self", sinaRate: -1.2, selfRate: null });
  eq(r.source, "sina");
  approx(r.rate, -1.2);
});
test("pickEstimate：数据源一缺值 → 同源最近缓存（缺值不换源纪律）", () => {
  const cached = { rate: -0.8, time: "10:00", nav: 1.21, date: "2026-11-07", ts: Date.now() - 60000 };
  const r = fd.pickEstimate({ ...BASE, pref: "sina", sinaRate: null, cached, selfRate: -0.9 });
  eq(r.source, "sina");
  approx(r.rate, -0.8);
  approx(r.nav, 1.21);
});
test("pickEstimate：数据源一缺值且缓存过期（盘中超时）→ 才轮到自算", () => {
  // 显式构造周四盘中（北京 10:00 = UTC 02:00）：staleCacheUsable 的 live 判定依赖 now 的北京时间
  const now = Date.parse("2026-11-05T02:00:00Z"); // 2026-11-05 周四
  const cached = { rate: -0.8, date: "2026-11-05", ts: now - 2 * 3600 * 1000 }; // 2h 前 > 盘中阈值
  const r = fd.pickEstimate({ ...BASE, pref: "sina", sinaRate: null, cached, selfRate: -0.9, now });
  eq(r.source, "self");
  approx(r.rate, -0.9);
});
test("pickEstimate：缓存日期非今日 → 不可用（隔夜值不冒充今日）", () => {
  const cached = { rate: -0.8, date: "2026-11-06", ts: Date.now() };
  const r = fd.pickEstimate({ ...BASE, pref: "sina", sinaRate: null, cached, selfRate: null });
  eq(r.rate, null);
  eq(r.source, "");
});
test("pickEstimate：全无 → rate=null（未出估值，调用方按 -- 处理）", () => {
  const r = fd.pickEstimate({ ...BASE, pref: "sina", sinaRate: null, cached: null, selfRate: null });
  eq(r.rate, null);
});
test("pickEstimate：全部缺失 → 不产生伪造值（0/负值也不冒充）", () => {
  const r = fd.pickEstimate({ ...BASE, pref: "sina", sinaRate: null, selfRate: 0 });
  // selfRate=0 是有效值（0 涨跌真实存在）——应返回 self 而非 null
  eq(r.source, "self");
  eq(r.rate, 0);
});

// ---------- getQuarterParams：季报季度定位（含 4 月空窗回退） ----------
test("getQuarterParams：1 月 → 上年 Q4（Q1 披露截止前无当年表）", () => {
  eq(fd.getQuarterParams(new Date(2026, 0, 15)), { year: 2025, month: 12 });
});
test("getQuarterParams：4 月 → Q1（空窗回退已修）", () => {
  eq(fd.getQuarterParams(new Date(2026, 3, 10)), { year: 2026, month: 3 });
});
test("getQuarterParams：7 月 → Q2", () => {
  eq(fd.getQuarterParams(new Date(2026, 6, 20)), { year: 2026, month: 6 });
});
test("getQuarterParams：10 月 → Q3", () => {
  eq(fd.getQuarterParams(new Date(2026, 9, 15)), { year: 2026, month: 9 });
});
test("getQuarterParams：12 月 → Q3（Q4 尚未披露）", () => {
  eq(fd.getQuarterParams(new Date(2026, 11, 1)), { year: 2026, month: 9 });
});

// ---------- isValidHoldings：占比合计校验（脏数据防线） ----------
test("isValidHoldings：合计 >100.5% → false（多季度混合脏数据拒收）", () => {
  eq(fd.isValidHoldings([{ navRatio: 60 }, { navRatio: 50 }]), false);
});
test("isValidHoldings：正常前十（合计 <100%）→ true", () => {
  eq(fd.isValidHoldings([{ navRatio: 9.19 }, { navRatio: 8.68 }]), true);
});
test("isValidHoldings：空/非数组 → false", () => {
  eq(fd.isValidHoldings([]), false);
  eq(fd.isValidHoldings(null), false);
});
test("isValidHoldings：全部缺失占比 → false（全 0 拒收）", () => {
  eq(fd.isValidHoldings([{ navRatio: null }, { ratio: null }]), false);
});
test("isValidHoldings：ratio 字段名兼容", () => {
  eq(fd.isValidHoldings([{ ratio: 40 }, { ratio: 30 }]), true);
});
