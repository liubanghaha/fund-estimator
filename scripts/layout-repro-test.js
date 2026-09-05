// 布局解析器 本地复刻测试（不改云函数，先验证改进逻辑）
// 复刻自 cloudfunctions/ocrScreenshot/index.js 的 layout* 纯函数
// mock words 结构: { words: string, location: {left,top,width,height} }

const LAYOUT_UI_WORDS = /^(买入|卖出|赎回|基金|持有|代码|金额|收益|份额|净值|成本|我的|全部|自选|黄金|详情|名称|资产|截图|添加|更多|产品|去市场|客服|转换|定投|讨论|理财师|投资指南|投资计划|收益明细|交易记录|累计盈亏|业绩走势|返回|清仓|分析|复盘|历史|持仓|现金|红利|再投资|待确认|中高|风险|昨日|日涨幅|基金净值|持仓成本价|持有份额|持有金额|持有收益|累计收益|收益率|日涨|市场|解读|公司|电台|基金市场|机会|看|偏股|偏债|指数|全部持有|明细|搜索|持有收益率|金额\/昨日|单位|资产详情)$/;
const LAYOUT_FUND_KW = /混合|股票|指数|债券|货币|ETF|LOF|QDII|FOF|联接|稳健|优选|精选|灵活|配置|成长|价值|蓝筹|红利|医疗|医药|消费|科技|资源|创新|前沿|多元|策略|增强|驱动|领航|纳斯达克|标普|恒生|全球|海外|黄金/;
const LAYOUT_MONEY_RE = /^[¥￥]?([\d,]+)(\.\d{1,2})?$/;
const LAYOUT_SIGNED_RE = /^[+-][\d,]+\.?\d{0,2}$/;

function layoutRows(words) {
  const toks = (words || []).map((w) => ({
    text: w.words, x: (w.location || {}).left || 0, y: (w.location || {}).top || 0,
    w: (w.location || {}).width || 0, h: (w.location || {}).height || 0,
  }));
  const rows = [];
  for (const t of toks) {
    const c = t.y + t.h / 2;
    let row = null;
    for (const r of rows) {
      const rc = r.y + r.h / 2;
      if (Math.abs(rc - c) < Math.max(r.h, t.h) * 0.75) { row = r; break; }
    }
    if (!row) { rows.push({ toks: [], y: t.y, h: t.h }); row = rows[rows.length - 1]; }
    row.toks.push(t);
    row.y = Math.min(row.y, t.y);
    row.h = Math.max(row.h, t.h);
  }
  return rows
    .map((r) => {
      r.toks.sort((a, b) => a.x - b.x);
      r.x0 = r.toks[0].x;
      r.text = r.toks.map((t) => t.text).join(" ");
      return r;
    })
    .sort((a, b) => a.y - b.y);
}

function layoutMoney(t) {
  const m = t.match(LAYOUT_MONEY_RE);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, "") + (m[2] || ""));
}
function layoutSigned(t) {
  if (!LAYOUT_SIGNED_RE.test(t) || t.endsWith("%")) return null;
  return parseFloat(t.replace(/,/g, ""));
}
function layoutIsCode6(t) { return /^\d{6}$/.test(t); }
function layoutIsNameish(t) {
  if (!t || t.length < 2) return false;
  if (LAYOUT_UI_WORDS.test(t) && t.length <= 8) return false;
  if (LAYOUT_FUND_KW.test(t)) return true;
  return /^[一-鿿]{3,}$/.test(t);
}
function layoutIsNameTail(t) {
  return /^[一-鿿]{0,3}[ABC]$/.test(t) || /^[一-鿿（）()A-Za-z]{1,8}?(?:混合|股票|指数|债券|联接|ETF|LOF|货币|稳健)[AC]?$/.test(t);
}

// ===== 现有版 =====
function layoutParseListOld(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const toks = r.toks;
    if (toks.length < 2) continue;
    const j0 = toks.findIndex((t) => layoutMoney(t.text) === null && layoutSigned(t.text) === null && !layoutIsCode6(t.text));
    if (j0 < 0 || !layoutIsNameish(toks[j0].text)) continue;
    let mv = null, hr = null, mi = -1;
    for (let k = 0; k < toks.length; k++) {
      const v = layoutMoney(toks[k].text);
      if (v !== null && v >= 10 && mi < 0) { mv = v; mi = k; }
      else if (layoutSigned(toks[k].text) !== null && !hr) hr = toks[k].text;
    }
    if (!mv || mi <= j0) continue;
    let name = toks.slice(j0, mi).map((t) => t.text).join("");
    const nameEndsWell = /[ABC]$/.test(name) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(name);
    if (!nameEndsWell) {
      const nx = rows[i + 1];
      if (nx && nx.y - r.y < 200 && nx.toks.length > 0 && layoutIsNameTail(nx.toks[0].text) && Math.abs(nx.x0 - r.x0) < 60) {
        name += nx.toks[0].text;
      }
    }
    if (out.some((h) => h.fundName === name)) continue;
    out.push({ fundName: name, marketValue: String(mv), holdingReturn: hr ? hr.replace(/,/g, "") : "" });
  }
  return out;
}

// ===== 改进版 =====
// 1. 名称取到第一个"6位代码 或 金额"之前
// 2. 市值排除 6 位代码；优先带小数点的金额
// 3. 跨行兜底：行内无真实市值时，向下找"资产/持有金额"标签后的数值（列对齐优先）
function layoutParseListNew(rows) {
  const out = [];
  // 市值须出现在名称之后；6位代码不是市值
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const toks = r.toks;
    if (toks.length < 2) continue;
    const j0 = toks.findIndex((t) => layoutMoney(t.text) === null && layoutSigned(t.text) === null && !layoutIsCode6(t.text));
    if (j0 < 0 || !layoutIsNameish(toks[j0].text)) continue;

    // 名称边界：从 j0 到第一个 代码 或 金额 为止
    let nEnd = toks.length;
    for (let k = j0; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text) || layoutMoney(toks[k].text) !== null || layoutSigned(toks[k].text) !== null) {
        nEnd = k; break;
      }
    }
    let name = toks.slice(j0, nEnd).map((t) => t.text).join("");

    // 找市值：名称后第一个 非6位代码 的 >=10 金额（市值=第一金额列）
    // 支付宝：名称后第一个金额即市值；天天：名称后紧跟代码，跳过代码后第一个金额即市值
    let mv = null, mi = -1;
    for (let k = j0 + 1; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text)) continue;
      const v = layoutMoney(toks[k].text);
      if (v !== null && v >= 10) { mv = v; mi = k; break; }
    }
    // 跨行兜底：行内没有市值（或全是代码）→ 找"资产/持有金额"标签行下方数值
    if (mv === null || mv < 10) {
      const fallback = findAssetBelow(rows, i, r);
      if (fallback) { mv = fallback.value; mi = -1; }
    }
    // 名称结尾不完整 → 拼下一行首词
    const nameEndsWell = /[ABC]$/.test(name) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(name);
    if (!nameEndsWell) {
      const nx = rows[i + 1];
      if (nx && nx.y - r.y < 200 && nx.toks.length > 0 && layoutIsNameTail(nx.toks[0].text) && Math.abs(nx.x0 - r.x0) < 60) {
        name += nx.toks[0].text;
      }
    }
    if (!mv) continue;
    if (out.some((h) => h.fundName === name)) continue;
    out.push({ fundName: name, marketValue: String(mv), holdingReturn: "" });
  }
  return out;
}

// 向下跨行找资产标签行的数值：找含"资产/金额/持有金额"标签的行，取它下方最近的一行数值（列对齐）
function findAssetBelow(rows, i, r) {
  for (let j = i + 1; j < rows.length && j < i + 4; j++) {
    const rr = rows[j];
    if (rr.y - r.y > 220) break;
    if (/资产|金额|持有金额|市值/.test(rr.text)) {
      // 标签行下一行是数值
      const nr = rows[j + 1];
      if (nr && nr.y - rr.y < 200) {
        for (const t of nr.toks) {
          if (layoutIsCode6(t.text)) continue;
          const v = layoutMoney(t.text);
          if (v !== null && v >= 10) return { value: v };
        }
      }
    }
  }
  return null;
}

// ===== mock words 生成器 =====
function W(text, left, top) {
  return { words: text, location: { left, top, width: String(text).length * 20, height: 30 } };
}

// 支付宝式：名称 + 金额 + 收益 同行（列对齐，无代码紧贴）
function alipayLayout() {
  const words = [];
  const y = 100;
  words.push(W("工银新兴制造混合A", 20, y));
  words.push(W("10000.00", 380, y));
  words.push(W("120.50", 700, y));
  words.push(W("华宝新兴成长混合C", 20, y + 80));
  words.push(W("5000.00", 380, y + 80));
  words.push(W("60.20", 700, y + 80));
  return words;
}

// 天天式：名称+代码同行，市值在下一行（资产标签行+数值行）
function tiantianLayout() {
  const words = [];
  const y = 100;
  // 名称行
  words.push(W("工银新兴制造混合A", 20, y));
  words.push(W("009707", 430, y));
  // 标签行
  words.push(W("资产", 20, y + 60));
  words.push(W("昨日收益", 380, y + 60));
  words.push(W("持仓收益/率", 700, y + 60));
  // 数值行
  words.push(W("10000.00", 20, y + 120));
  words.push(W("0.00", 380, y + 120));
  words.push(W("0.00", 700, y + 120));
  // 第二只
  words.push(W("华宝新兴成长混合C", 20, y + 200));
  words.push(W("017197", 430, y + 200));
  words.push(W("资产", 20, y + 260));
  words.push(W("昨日收益", 380, y + 260));
  words.push(W("持仓收益/率", 700, y + 260));
  words.push(W("5000.00", 20, y + 320));
  words.push(W("0.00", 380, y + 320));
  words.push(W("0.00", 700, y + 320));
  return words;
}

function test(title, words, parse) {
  const rows = layoutRows(words);
  const res = parse(rows);
  console.log(`\n=== ${title} ===`);
  res.forEach((h, i) => console.log(`  [${i}] ${h.fundName} | 市值=${h.marketValue} (期望市值, 不应是代码)`));
}

console.log("########## 现有逻辑 ##########");
test("支付宝式(名称+金额同行)", alipayLayout(), layoutParseListOld);
test("天天式(名称+代码同行+下一行数值)", tiantianLayout(), layoutParseListOld);

console.log("\n########## 改进逻辑 ##########");
test("支付宝式(名称+金额同行)", alipayLayout(), layoutParseListNew);
test("天天式(名称+代码同行+下一行数值)", tiantianLayout(), layoutParseListNew);

// ===== 交易解析复刻 =====
const TX_UI_WORDS = TX_UI_RE();
function TX_UI_RE(){ return /^(买入|卖出|赎回|基金|持有|代码|金额|收益|份额|净值|成本|我的|全部|自选|黄金|详情|名称|资产|截图|添加|更多|产品|去市场|客服|转换|定投|讨论|理财师|投资指南|投资计划|收益明细|交易记录|累计盈亏|业绩走势|返回|清仓|分析|复盘|历史|持仓|现金|红利|再投资|待确认|中高|风险|昨日|日涨幅|基金净值|持仓成本价|持有份额|持有金额|持有收益|累计收益|收益率|日涨|市场|解读|公司|电台|基金市场|机会|看|偏股|偏债|指数|全部持有|明细|搜索|持有收益率|金额\/昨日|单位|资产详情|交易进行中|确认中|已完成)$/; }
const TX_FUND_KW = /混合|股票|指数|债券|货币|ETF|LOF|QDII|FOF|联接|稳健|优选|精选|灵活|配置|成长|价值|蓝筹|红利|医疗|医药|消费|科技|资源|创新|前沿|多元|策略|增强|驱动|领航|纳斯达克|标普|恒生|全球|海外|黄金/;
const TX_MONEY_RE = /^[¥￥]?([\d,]+)(\.\d{1,2})?$/;
const TX_DATE_RE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/;
function txIsMoney(t) { const m = t.match(TX_MONEY_RE); if (!m) return null; return parseFloat(m[1].replace(/,/g,"")+(m[2]||"")); }
function txIsNameish(t) { if (!t||t.length<2) return false; if (TX_UI_WORDS.test(t)&&t.length<=8) return false; if (TX_FUND_KW.test(t)) return true; return /^[一-鿿]{3,}$/.test(t); }
function txIsNameTail(t) { return /^[一-鿿]{0,3}[ABC]$/.test(t) || /^[一-鿿（）()A-Za-z]{1,8}?(?:混合|股票|指数|债券|联接|ETF|LOF|货币|稳健)[AC]?$/.test(t); }

function txParseWords(words) {
  const rows = layoutRows(words); // 复用
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!/(买入|卖出|赎回)/.test(r.text) && !/基金[|｜]/.test(r.text)) continue;
    let name = "", amount = "";
    for (const t of r.toks) {
      const tx = t.text.replace(/^(买入|卖出|赎回)\s*/, "").replace(/^基金\s*[|｜]\s*/, "");
      if (!tx) continue;
      if (tx === t.text) {
        const v = txIsMoney(tx);
        if (v !== null && v >= 1) { amount = String(v); continue; }
        const am = tx.match(/^([\d,]+\.?\d{0,2})元$/);
        if (am) { amount = am[1].replace(/,/g, ""); continue; }
      }
      if (txIsNameish(tx) && !amount) name += tx;
    }
    const type = /卖出|赎回/.test(r.text) ? "sell" : "buy";
    if (name) {
      const nx = rows[i + 1];
      if (nx && nx.y - r.y < 200 && !TX_DATE_RE.test(nx.text) && nx.toks.length && txIsNameTail(nx.toks[0].text)) {
        name += nx.toks[0].text;
      }
    }
    let date = "", time = "";
    for (const nx of rows.slice(i + 1, i + 4)) {
      if (nx.y - r.y > 300) break;
      const m = nx.text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
      if (m) { date = m[1].replace(/[./]/g, "-"); time = m[2] || ""; break; }
    }
    if (name && !out.some((t) => t.fundName === name && t.amount === amount && t.date === date)) {
      out.push({ type, fundName: name, amount, date, time });
    }
  }
  return out;
}

// 天天交易布局 mock：每条 = 买入(左) 名称(中) 金额(右) 一行, 下一行日期
function tiantianTx() {
  const words = [];
  let y = 100;
  const items = [
    ["工银新兴制造混合A", "10000.00元"],
    ["华宝新兴成长混合C", "5000.00元"],
    ["组合买入易方达蓝筹精选混合", "100.00元"],
    ["易方达蓝筹精选混合", "1000.00元"],
  ];
  for (const [name, amt] of items) {
    words.push(W("买入", 30, y));
    words.push(W(name, 280, y));
    words.push(W(amt, 700, y));
    words.push(W("2026-09-05 14:55:00", 280, y + 60));
    y += 140;
  }
  return words;
}

console.log("\n########## 交易解析 ##########");
(function () {
  const rows = layoutRows(tiantianTx());
  const res = txParseWords(tiantianTx());
  console.log("天天交易布局 识别到交易数:", res.length);
  res.forEach((t, i) => console.log(`  [${i}] ${t.fundName} | ${t.amount} | ${t.date}`));
})();

// ===== 修正版 txParseWords：名称/金额互相独立，顺序无关；清洗交易动作前缀 =====
function txNormalize(txt) {
  // 去交易动作前缀：买入/卖出/赎回/组合买入/定投买入/定投卖出 等
  return txt.replace(/^(组合|定投|分批|部分)?\s*(买入|卖出|赎回)\s*/, "");
}
function txParseWordsNew(words) {
  const rows = layoutRows(words);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!/(买入|卖出|赎回)/.test(r.text)) continue;
    let name = "", amount = "";
    for (const t of r.toks) {
      let txt = t.text;
      // 先清洗交易动作前缀（组合买入/定投买入等）
      const norm = txNormalize(txt);
      if (norm === "") continue; // 纯动作词
      const v = txIsMoney(norm) !== null ? txIsMoney(norm) : (/^([\d,]+\.?\d{0,2})元$/.test(norm) ? parseFloat(norm.replace(/元$/,"").replace(/,/g,"")) : null);
      if (v !== null && v >= 1) { if (!amount) amount = String(v); continue; }
      // 名称词
      if (txIsNameish(norm) || /^[一-鿿]{3,}$/.test(norm)) { name += norm; }
    }
    // 名称结尾不完整 → 拼下一行首词
    const nameEndsWell = /[ABC]$/.test(name) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(name);
    if (name && !nameEndsWell) {
      const nx = rows[i + 1];
      if (nx && nx.y - r.y < 200 && !TX_DATE_RE.test(nx.text) && nx.toks.length && txIsNameTail(nx.toks[0].text)) {
        name += nx.toks[0].text;
      }
    }
    let date = "", time = "";
    for (const nx of rows.slice(i + 1, i + 4)) {
      if (nx.y - r.y > 300) break;
      const m = nx.text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
      if (m) { date = m[1].replace(/[./]/g, "-"); time = m[2] || ""; break; }
    }
    const type = /卖出|赎回/.test(r.text) ? "sell" : "buy";
    if (name && amount && !out.some((t) => t.fundName === name && t.amount === amount && t.date === date)) {
      out.push({ type, fundName: name, amount, date, time });
    }
  }
  return out;
}

// 真实天天布局 mock：买入(左) 金额(中) 名称(右)，金额在名称左边
function tiantianTxReal() {
  const words = [];
  let y = 100;
  const items = [
    ["工银新兴制造混合A", "10000.00元", "买入"],
    ["华宝新兴成长混合C", "5000.00元", "买入"],
    ["易方达蓝筹精选混合", "100.00元", "组合买入"],
    ["易方达蓝筹精选混合", "1000.00元", "买入"],
  ];
  for (const [name, amt, act] of items) {
    words.push(W("买", 20, y));
    words.push(W(act, 60, y));
    words.push(W(amt, 500, y));
    words.push(W(name, 300, y));
    words.push(W("2026-09-05 14:55:00", 300, y + 60));
    y += 140;
  }
  return words;
}
(function () {
  console.log("\n########## 交易解析(修正版) ##########");
  console.log("--- 金额在名称左(真实天天) ---");
  let res = txParseWordsNew(tiantianTxReal());
  res.forEach((t, i) => console.log(`  [${i}] ${t.fundName} | ${t.amount} | ${t.date} | ${t.type}`));
  console.log("--- 金额在名称右(支付宝/常见) ---");
  res = txParseWordsNew(tiantianTx());
  res.forEach((t, i) => console.log(`  [${i}] ${t.fundName} | ${t.amount} | ${t.date}`));
})();

// 完全按真实 raw 词序：买(图标) 买入 10000.00元 工银新兴制造混合A
function tiantianTxRawLike() {
  const words = [];
  let y = 100;
  const items = [
    ["10000.00元", "工银新兴制造混合A", "买入"],
    ["5000.00元", "华宝新兴成长混合C", "买入"],
    ["100.00元", "易方达蓝筹精选混合", "组合买入"],
    ["1000.00元", "易方达蓝筹精选混合", "买入"],
  ];
  for (const [amt, name, act] of items) {
    words.push(W("买", 20, y));       // 圆形图标
    words.push(W(act, 60, y));        // 买入 / 组合买入
    words.push(W(amt, 500, y));       // 10000.00元
    words.push(W(name, 200, y));      // 名称
    words.push(W("2026-09-05 14:55:00", 200, y + 60));
    y += 140;
  }
  return words;
}
(function () {
  console.log("\n########## 交易解析(真实词序修复验证) ##########");
  const res = txParseWordsNew(tiantianTxRawLike());
  console.log("识别:", res.length, "条");
  res.forEach((t, i) => console.log(`  [${i}] "${t.fundName}" | ${t.amount} | ${t.date}`));
})();

// 模拟"买入"被 OCR 分到独立行（买+买入 一行，金额名称在下一行）→ 复现云端 0 条
function tiantianTxSplitRows() {
  const words = [];
  let y = 100;
  const items = [
    ["10000.00元", "工银新兴制造混合A"],
    ["5000.00元", "华宝新兴成长混合C"],
    ["100.00元", "易方达蓝筹精选混合"],
    ["1000.00元", "易方达蓝筹精选混合"],
  ];
  for (const [amt, name] of items) {
    words.push(W("买", 20, y));        // 动作图标 行
    words.push(W("买入", 60, y));      // 动作文字 行(同y)
    y += 30;                            // 动作行
    words.push(W(amt, 500, y));       // 金额 行
    words.push(W(name, 200, y));      // 名称 行
    words.push(W("2026-09-05 14:55:00", 200, y + 60));
    y += 160;
  }
  return words;
}
(function () {
  console.log("\n########## 交易解析(动作独立行) ##########");
  const rows = layoutRows(tiantianTxSplitRows());
  console.log("行数:", rows.length, "各行:", rows.map(r=>r.text).join(" | "));
  const res = txParseWordsNew(tiantianTxSplitRows());
  console.log("识别:", res.length, "条");
  res.forEach((t, i) => console.log(`  [${i}] "${t.fundName}" | ${t.amount} | ${t.date}`));
})();

// debug：逐词打印 txParseWordsNew 对合并行的处理
function dbgTxParse(words) {
  const rows = layoutRows(words);
  console.log("\n--- 逐词 debug (txParseWordsNew) ---");
  for (const r of rows) {
    console.log(`行: "${r.text}"`);
    for (const t of r.toks) {
      const norm = txNormalize(t.text);
      const am = norm.match(/^([\d,]+\.?\d{0,2})元$/);
      const v = am ? parseFloat(am[1].replace(/,/g,"")) : txIsMoney(norm);
      const isName = txIsNameish(norm) || /^[一-鿿]{3,}$/.test(norm);
      console.log(`  tok="${t.text}" norm="${norm}" am=${am?am[1]:null} money=${v} isName=${isName}`);
    }
  }
}
dbgTxParse(tiantianTxSplitRows());

// 最新版 txParseWordsNew（两遍扫描：含名称+金额的行为交易主体）
function resolveTx(words) {
  const rows = layoutRows(words);
  const filled = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let name = "", amount = "";
    for (const t of r.toks) {
      const norm = txNormalize(t.text);
      if (norm === "") continue;
      const am = norm.match(/^([\d,]+\.?\d{0,2})元$/);
      if (am) { if (!amount) amount = am[1].replace(/,/g, ""); continue; }
      const v = txIsMoney(norm);
      if (v !== null && v >= 1) { if (!amount) amount = String(v); continue; }
      if (txIsNameish(norm) || /^[一-鿿]{3,}$/.test(norm)) name += norm;
    }
    filled.push({ i, r, name, amount });
  }
  const out = [];
  for (let idx = 0; idx < filled.length; idx++) {
    const { r, name, amount } = filled[idx];
    if (!name || !amount) continue;
    let fullName = name;
    const ok = /[ABC]$/.test(fullName) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(fullName);
    if (!ok) {
      const nx = rows[idx + 1];
      if (nx && nx.y - r.y < 200 && !TX_DATE_RE.test(nx.text) && nx.toks.length && txIsNameTail(nx.toks[0].text)) fullName += nx.toks[0].text;
    }
    let type = "buy";
    for (const cand of [r.text, (rows[idx-1]||{}).text||"", (rows[idx+1]||{}).text||""]) { if (/(卖出|赎回)/.test(cand)) { type="sell"; break; } }
    let date="", time="";
    for (const nx of rows.slice(idx+1, idx+4)) { if (nx.y-r.y>300) break; const m=nx.text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/); if (m){date=m[1].replace(/[./]/g,"-"); time=m[2]||""; break;} }
    if (!out.some(t=>t.fundName===fullName&&t.amount===amount&&t.date===date)) out.push({type, fundName:fullName, amount, date, time});
  }
  return out;
}
(function () {
  console.log("\n########## 交易解析(两遍扫描版) ##########");
  const cases = [["动作独立行(天天真实)", tiantianTxSplitRows()], ["金额左(天天)", tiantianTxReal()], ["金额右(支付宝)", tiantianTx()]];
  for (const [title, words] of cases) {
    const res = resolveTx(words);
    console.log(`--- ${title}: ${res.length} 条 ---`);
    res.forEach((t,i)=>console.log(`  [${i}] "${t.fundName}" | ${t.amount} | ${t.date} | ${t.type}`));
  }
})();

// 用真实 words 坐标复现：买 买入 10000.00元 (y=465上行 含金额), 名称下一行 (y=548)
function realTiantianWords() {
  const words = [];
  let y = 465;
  const items = [
    ["工银新兴制造混合A", "10000.00元"],
    ["华宝新兴成长混合C", "5000.00元"],
    ["易方达蓝筹精选混合", "100.00元"],
    ["易方达蓝筹精选混合", "1000.00元"],
  ];
  for (const [name, amt] of items) {
    words.push(W("买", 70, y));       // 动作
    words.push(W("买入", 182, y));    // 动作
    words.push(W(amt, 782, y));       // 金额（同动作行）
    words.push(W(name, 182, y + 83)); // 名称（下一行！）
    words.push(W("2026-09-05", 183, y + 178)); // 日期行
    words.push(W("14:55:00", 425, y + 178));
    y += 353;
  }
  return words;
}
(function () {
  console.log("\n########## 交易解析(跨行配对真实坐标) ##########");
  const res = resolveTx(realTiantianWords());
  console.log("识别:", res.length, "条");
  res.forEach((t,i)=>console.log(`  [${i}] "${t.fundName}" | ${t.amount} | ${t.date} | ${t.type}`));
})();

// 最新跨行配对版（与云端 txParseWords 一致）
function resolveTxFinal(words) {
  const rows = layoutRows(words);
  const filled = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let name = "", amount = "";
    for (const t of r.toks) {
      const norm = txNormalize(t.text);
      if (norm === "") continue;
      const am = norm.match(/^([\d,]+\.?\d{0,2})元$/);
      if (am) { if (!amount) amount = am[1].replace(/,/g,""); continue; }
      const v = txIsMoney(norm);
      if (v !== null && v >= 1) { if (!amount) amount = String(v); continue; }
      if (txIsNameish(norm) || /^[一-鿿]{3,}$/.test(norm)) name += norm;
    }
    filled.push({ i, r, name, amount });
  }
  const out = [];
  for (let idx = 0; idx < filled.length; idx++) {
    const { r, name, amount } = filled[idx];
    if (!amount) continue;
    let fullName = name;
    if (!fullName) {
      for (const cand of [filled[idx+1], filled[idx-1]]) {
        if (!cand) continue;
        const cn = cand.name;
        if (cn && Math.abs(cand.r.y - r.y) < 160 && !TX_DATE_RE.test(cand.r.text)) {
          if (/[ABC]$/.test(cn) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(cn)) { fullName = cn; break; }
        }
      }
    }
    if (!fullName) continue;
    const ok = /[ABC]$/.test(fullName) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(fullName);
    if (!ok) {
      const nx = rows[idx+1];
      if (nx && nx.y - r.y < 160 && !TX_DATE_RE.test(nx.text) && nx.toks.length && txIsNameTail(nx.toks[0].text)) fullName += nx.toks[0].text;
    }
    let type = "buy";
    for (const ct of [r.text, (rows[idx-1]||{}).text||"", (rows[idx+1]||{}).text||""]) { if (/(卖出|赎回)/.test(ct)) { type="sell"; break; } }
    let date="", time="";
    for (const nx of rows.slice(idx+1, idx+4)) { if (nx.y-r.y>300) break; const m=nx.text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/); if (m){date=m[1].replace(/[./]/g,"-");time=m[2]||"";break;} }
    if (!out.some(t=>t.fundName===fullName&&t.amount===amount&&t.date===date)) out.push({type, fundName:fullName, amount, date, time});
  }
  return out;
}
(function () {
  console.log("\n########## 跨行配对版(对齐云端) ##########");
  const cases = [["真实坐标(名称在下一行)", realTiantianWords()], ["动作独立行(金额名称分开)", tiantianTxSplitRows()], ["金额右(支付宝)", tiantianTx()]];
  for (const [t, w] of cases) {
    const res = resolveTxFinal(w);
    console.log(`--- ${t}: ${res.length} 条 ---`);
    res.forEach((x,i)=>console.log(`  [${i}] "${x.fundName}" | ${x.amount} | ${x.date} | ${x.type}`));
  }
})();

// 审查边界测试
function runEdgeCases() {
  console.log("\n########## 审查边界案例 ##########");
  // 案例A：名称后跟代码，但市值也同行且在代码后（天天真实）→ 名称应不含代码，mv=后值
  let w = [];
  w.push(W("易方达蓝筹精选混合", 20, 100));
  w.push(W("005827", 430, 100));
  w.push(W("1100.00", 760, 100));  // 同行市值
  w.push(W("资产", 20, 160));
  w.push(W("1100.00", 20, 220));
  let r = layoutParseListNew(layoutRows(w));
  console.log("案例A(名+代码+同行市值):", JSON.stringify(r));
  // 案例B：名称+收益带符号+市值同行（支付宝式）
  w = [];
  w.push(W("工银新兴制造混合A", 20, 100));
  w.push(W("10000.00", 380, 100));
  w.push(W("+120.50", 700, 100));
  r = layoutParseListNew(layoutRows(w));
  console.log("案例B(名+市值+带符号收益):", JSON.stringify(r));
}
runEdgeCases();

// 去重边界：同一基金两条不同金额（应保留两条）；无日期行
function dedupCase() {
  console.log("\n########## 去重边界 ##########");
  const w = [];
  w.push(W("买", 20, 100)); w.push(W("买入", 60, 100)); w.push(W("100.00元", 500, 100)); w.push(W("易方达蓝筹精选混合", 200, 183));
  w.push(W("买", 20, 453)); w.push(W("买入", 60, 453)); w.push(W("1000.00元", 500, 453)); w.push(W("易方达蓝筹精选混合", 200, 536));
  const res = resolveTxFinal(w);
  console.log("同名不同金额(无日期):", res.length, "条");
  res.forEach((x,i)=>console.log(`  [${i}] "${x.fundName}" | ${x.amount}`));
}
dedupCase();

// 验证 hr 恢复：layoutParseListNew 含 hr 提取（对齐云函数最新版）
function layoutParseListHr(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const toks = r.toks;
    if (toks.length < 2) continue;
    const j0 = toks.findIndex((t) => layoutMoney(t.text) === null && layoutSigned(t.text) === null && !layoutIsCode6(t.text));
    if (j0 < 0 || !layoutIsNameish(toks[j0].text)) continue;
    let nEnd = toks.length;
    for (let k = j0; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text) || layoutMoney(toks[k].text) !== null || layoutSigned(toks[k].text) !== null) { nEnd = k; break; }
    }
    let name = toks.slice(j0, nEnd).map((t) => t.text).join("");
    let mv = null, mi = -1, hr = "";
    for (let k = j0 + 1; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text)) continue;
      if (!hr) { const s = layoutSigned(toks[k].text); if (s !== null && s !== undefined) hr = toks[k].text; }
      const v = layoutMoney(toks[k].text);
      if (v !== null && v >= 10) { mv = v; mi = k; break; }
    }
    if (mv === null) continue;
    if (out.some((h) => h.fundName === name)) continue;
    out.push({ fundName: name, marketValue: String(mv), holdingReturn: hr ? hr.replace(/,/g, "") : "" });
  }
  return out;
}
(function () {
  const w = [];
  w.push(W("工银新兴制造混合A", 20, 100));
  w.push(W("10000.00", 380, 100));
  w.push(W("+120.50", 700, 100));  // 带符号收益
  const r = layoutParseListHr(layoutRows(w));
  console.log("\n########## hr 恢复验证 ##########");
  console.log("名+市值+带符号收益:", JSON.stringify(r));
})();

// v2: hr 独立扫描（与云函数最新一致）
function layoutParseListHr2(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const toks = r.toks;
    if (toks.length < 2) continue;
    const j0 = toks.findIndex((t) => layoutMoney(t.text)===null && layoutSigned(t.text)===null && !layoutIsCode6(t.text));
    if (j0 < 0 || !layoutIsNameish(toks[j0].text)) continue;
    let nEnd = toks.length;
    for (let k=j0;k<toks.length;k++){ if(layoutIsCode6(toks[k].text)||layoutMoney(toks[k].text)!==null||layoutSigned(toks[k].text)!==null){nEnd=k;break;} }
    let name = toks.slice(j0,nEnd).map(t=>t.text).join("");
    let hr="";
    for (let k=j0+1;k<toks.length;k++){ if(layoutIsCode6(toks[k].text))continue; const s=layoutSigned(toks[k].text); if(s!==null&&s!==undefined){hr=toks[k].text;break;} }
    let mv=null, mi=-1;
    for (let k=j0+1;k<toks.length;k++){ if(layoutIsCode6(toks[k].text))continue; const v=layoutMoney(toks[k].text); if(v!==null&&v>=10){mv=v;mi=k;break;} }
    if(mv===null)continue;
    if(out.some(h=>h.fundName===name))continue;
    out.push({fundName:name, marketValue:String(mv), holdingReturn: hr?hr.replace(/,/g,""):""});
  }
  return out;
}
(function () {
  const cases = [];
  let w=[]; w.push(W("工银新兴制造混合A",20,100));w.push(W("10000.00",380,100));w.push(W("+120.50",700,100)); cases.push(["名+市值+带符号收益",w]);
  w=[]; w.push(W("华宝新兴成长混合C",20,100));w.push(W("5000.00",380,100));w.push(W("-15.00",700,100)); cases.push(["名+市值+负收益",w]);
  w=[]; w.push(W("易方达蓝筹精选混合",20,100));w.push(W("009707",430,100));w.push(W("资产",20,160));w.push(W("1100.00",20,220)); cases.push(["名+代码+跨行市值(天天)",w]);
  console.log("\n########## hr 恢复 v2 验证 ##########");
  for (const [t, ww] of cases) console.log(t+":", JSON.stringify(layoutParseListHr2(layoutRows(ww))));
})();

// 复现手机端可能的漏识别：金额行和名称行之间被日期行/状态行隔开
function gapBetweenRows() {
  console.log("\n########## 复现漏识别：金额与名称间隔行 ##########");
  // 买 买入 500.00元 (金额行) | 交易进行中(中间行) | 嘉实新消费股票A(名称行, 隔一行)
  const w = [];
  w.push(W("买", 20, 100)); w.push(W("买入", 60, 100)); w.push(W("500.00元", 500, 100));
  w.push(W("交易进行中", 500, 180));      // 中间行
  w.push(W("基金", 200, 100));            // "基金 |"格式？
  w.push(W("嘉实新消费股票A", 200, 260)); // 名称行 y差160
  const res = resolveTxFinal(w);
  console.log("金额与名称隔一行:", res.length, "条", JSON.stringify(res));
}
gapBetweenRows();

// v3: 向下多行配对（对齐云端最新）
function resolveTxFinal2(words) {
  const rows = layoutRows(words);
  const filled = [];
  for (let i=0;i<rows.length;i++){ const r=rows[i]; let name="",amount=""; for(const t of r.toks){ const norm=txNormalize(t.text); if(norm==="")continue; const am=norm.match(/^([\d,]+\.?\d{0,2})元$/); if(am){if(!amount)amount=am[1].replace(/,/g,"");continue;} const v=txIsMoney(norm); if(v!==null&&v>=1){if(!amount)amount=String(v);continue;} if(txIsNameish(norm)||/^[一-鿿]{3,}$/.test(norm))name+=norm; } filled.push({i,r,name,amount}); }
  const out=[];
  for(let idx=0;idx<filled.length;idx++){
    const {r,name,amount}=filled[idx]; if(!amount)continue;
    let fullName=name;
    if(!fullName){
      for(let j=idx+1;j<filled.length&&j<idx+5;j++){ const cand=filled[j]; if(!cand)continue; const cn=cand.name; if(!cn)continue; if(Math.abs(cand.r.y-r.y)>300)break; if(/[ABC]$/.test(cn)||/(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(cn)){fullName=cn;break;} }
      if(!fullName){ const up=filled[idx-1]; if(up&&up.name&&Math.abs(up.r.y-r.y)<160&&!TX_DATE_RE.test(up.r.text)){ if(/[ABC]$/.test(up.name)||/(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(up.name))fullName=up.name; } }
    }
    if(!fullName)continue;
    const ok=/[ABC]$/.test(fullName)||/(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(fullName);
    if(!ok){ const nx=rows[idx+1]; if(nx&&nx.y-r.y<160&&!TX_DATE_RE.test(nx.text)&&nx.toks.length&&txIsNameTail(nx.toks[0].text))fullName+=nx.toks[0].text; }
    let type="buy"; for(const ct of [r.text,(rows[idx-1]||{}).text||"",(rows[idx+1]||{}).text||""]){ if(/(卖出|赎回)/.test(ct)){type="sell";break;} }
    let date="",time=""; for(const nx of rows.slice(idx+1,idx+4)){ if(nx.y-r.y>300)break; const m=nx.text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/); if(m){date=m[1].replace(/[./]/g,"-");time=m[2]||"";break;} }
    if(!out.some(t=>t.fundName===fullName&&t.amount===amount&&t.date===date))out.push({type,fundName:fullName,amount,date,time});
  }
  return out;
}
(function () {
  console.log("\n########## 向下多行配对 v3 ##########");
  const cases = [
    ["金额隔状态行(漏识别复现)", gapBetweenRows2()],
    ["真实坐标(名称下一行)", realTiantianWords()],
    ["动作独立行", tiantianTxSplitRows()],
    ["金额右(支付宝)", tiantianTx()],
    ["金额左(天天)", tiantianTxReal()],
  ];
  for (const [t,w] of cases){ const res=resolveTxFinal2(w); console.log(`--- ${t}: ${res.length} 条 ---`); res.forEach((x,i)=>console.log(`  [${i}] "${x.fundName}" | ${x.amount} | ${x.date} | ${x.type}`)); }
})();
function gapBetweenRows2(){
  const w=[]; w.push(W("买",20,100));w.push(W("买入",60,100));w.push(W("500.00元",500,100));w.push(W("基金",200,100));w.push(W("交易进行中",500,180));w.push(W("嘉实新消费股票A",200,260)); return w;
}
