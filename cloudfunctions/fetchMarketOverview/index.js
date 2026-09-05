const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 行情中心 V1 数据源（云函数无域名白名单限制）：
// - 概览：东财 push2 行情字段，沪综指(1.000001/全沪) + 深综指(0.399106/全深)：
//   f6=成交额(元)，f104/f105/f106=成分内上涨/下跌/平盘家数，两市合计 ≈ 全市场
// - 行业板块：东财 push2 clist 行业板块（fs=m:90+t:2），f14=名称 f3=涨跌幅 f128=领涨股 f136=领涨股涨跌幅
// 持仓行业聚合的唯一数据源是 getPortfolio 的 assetAllocation（资产分析页同源），
// 本函数只负责公开行情：两市概览 / 行业板块全量池（供客户端匹配）/ 指数资金流。

exports.main = async (event = {}) => {
  try {
    const [overview, sectors, flows] = await Promise.all([
      fetchOverview(),
      fetchSectors(),
      fetchIndexFlows(),
    ]);
    if (!overview && sectors.length === 0) {
      // 双源均失败（东财偶发限流）：返回空标记由客户端兜底展示缓存，而非硬错误
      return { code: 0, data: { overview: null, sectors: [], flows: {}, empty: true } };
    }
    // 展示封顶：领涨 30 + 领跌 15（全量列表供行情页与 assetAllocation 客户端匹配，不必全展示）
    const display = sectors.length > 45 ? sectors.slice(0, 30).concat(sectors.slice(-15)) : sectors;
    return { code: 0, data: { overview, sectors: display, flows } };
  } catch (e) {
    console.error("[fetchMarketOverview] 失败:", e.message || e);
    return { code: 500, msg: "行情数据获取失败" };
  }
};

function httpGet(url, timeout = 8000) {
  const once = () => new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
  // 东财对高频 IP 偶发限流：失败/空响应 600ms 后重试一次
  return once().then((body) => (body ? body : new Promise((r) => setTimeout(r, 600)).then(once))).catch(() => new Promise((r) => setTimeout(r, 600)).then(once));
}

// 核心指数主力资金流（A股指数才有此数据）：f62=主力净流入额(元) f184=主力净占比(%)
// 合规红线 #5：仅做"主力净流入/流出 N 亿"数据陈述，不带任何引导性表述
async function fetchIndexFlows() {
  const url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f62,f184&secids=1.000001,0.399001,1.000300,0.399006&ut=bd1d9ddb04089700cf9c27f6f7426281";
  try {
    let body = await httpGet(url);
    if (!body || body === "null") {
      body = await httpGet("https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f62,f184&secids=1.000001,0.399001,1.000300,0.399006&ut=bd1d9ddb04089700cf9c27f6f7426281");
    }
    const root = JSON.parse(body);
    const d = (root && root.data) || {};
    const arr = Array.isArray(d.diff) ? d.diff : Object.values(d.diff || {});
    const flows = {};
    arr.forEach((r) => {
      if (r.f12 && r.f62 != null && r.f62 !== "-") {
        flows[r.f12] = { main: +r.f62, pct: r.f184 === "-" || r.f184 == null ? null : +r.f184 };
      }
    });
    return flows;
  } catch (e) {
    console.error("[fetchMarketOverview] 指数资金流失败:", e.message);
    return {};
  }
}

// 两市概览：成交额 + 涨跌家数（任一子项失败以 null 呈现，不互相拖垮）
async function fetchOverview() {
  try {
    let body = await httpGet("https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f6,f12,f104,f105,f106&secids=1.000001,0.399106");
    if (!body || body === "null") {
      body = await httpGet("https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f6,f12,f104,f105,f106&secids=1.000001,0.399106");
    }
    const root = JSON.parse(body);
    const d = (root && root.data) || {};
    const arr = Array.isArray(d.diff) ? d.diff : Object.values(d.diff || {});
    let shAmount = null, szAmount = null, up = 0, down = 0, flat = 0;
    arr.forEach((r) => {
      if (r.f12 === "000001") shAmount = r.f6 != null ? +r.f6 : null;
      if (r.f12 === "399106") szAmount = r.f6 != null ? +r.f6 : null;
      up += +r.f104 || 0;
      down += +r.f105 || 0;
      flat += +r.f106 || 0;
    });
    if (shAmount == null && szAmount == null && !up && !down) return null;
    return { shAmount, szAmount, up, down, flat };
  } catch (e) {
    console.error("[fetchMarketOverview] 概览失败:", e.message);
    return null;
  }
}

// 行业板块全量列表（~496 个，分页 5×100）：作为持仓行业匹配池必须拉全，
// 只取领涨/领跌榜会导致用户行业多数不在榜内而匹配失败。展示端另行封顶。
// ⚠️ clist 必须带 ut 令牌（东财 web 公开 token），否则返回空
async function fetchSectors() {
  const parse = (body) => {
    try {
      const root = JSON.parse(body);
      const d = (root && root.data) || {};
      const arr = Array.isArray(d.diff) ? d.diff : Object.values(d.diff || {});
      return arr.map((r) => ({
        code: r.f12 || "",
        name: r.f14 || "",
        changeRate: r.f3 === "-" || r.f3 == null ? null : +r.f3,
        leader: r.f128 && r.f128 !== "-" ? r.f128 : "",
        leaderRate: r.f136 === "-" || r.f136 == null ? null : +r.f136,
      })).filter((s) => s.name);
    } catch (e) { return []; } // 限流/空响应体容错
  };
  const tryPage = async (pn) => {
    const q = `pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f128,f136&ut=bd1d9ddb04089700cf9c27f6f7426281`;
    let body = await httpGet("https://push2.eastmoney.com/api/qt/clist/get?" + q).catch(() => "");
    if (!body || body === "null") {
      body = await httpGet("https://push2delay.eastmoney.com/api/qt/clist/get?" + q).catch(() => "");
    }
    return parse(body);
  };
  const seen = new Set();
  const out = [];
  for (let pn = 1; pn <= 5; pn++) {
    const rows = await tryPage(pn);
    rows.forEach((s) => { if (!seen.has(s.code)) { seen.add(s.code); out.push(s); } });
    if (rows.length < 100) break;
  }
  // clist 按 f3 降序返回，out 已有序
  return out;
}

