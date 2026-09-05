const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const ft = require("./_shared/fund-temperature");

// 行情中心 V1 数据源（云函数无域名白名单限制）：
// - 概览：东财 push2 行情字段，沪综指(1.000001/全沪) + 深综指(0.399106/全深)：
//   f6=成交额(元)，f104/f105/f106=成分内上涨/下跌/平盘家数，两市合计 ≈ 全市场
// - 行业板块：东财 push2 clist 行业板块（fs=m:90+t:2），f14=名称 f3=涨跌幅 f128=领涨股 f136=领涨股涨跌幅
// - 持仓行业置顶：holdings 市值 × fund_temperatures.detailPEs 重仓股行业占比
//   （分类口径 ft.classifyIndustryLabel 与 getPortfolio 资产配置一致，东财 f100 行业名与板块名同源可精确匹配）

exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext();
    const [overview, sectors, mine, flows] = await Promise.all([
      fetchOverview(),
      fetchSectors(),
      OPENID ? fetchUserIndustries(OPENID) : Promise.resolve([]),
      fetchIndexFlows(),
    ]);
    if (!overview && sectors.length === 0) {
      // 双源均失败（东财偶发限流）：返回空标记由客户端兜底展示缓存，而非硬错误
      return { code: 0, data: { overview: null, sectors: [], mineCount: 0, flows: {}, empty: true } };
    }
    // 持仓行业置顶（带权重标记），其余板块按涨跌幅降序
    const norm = (s) => String(s || "").replace(/\s+/g, "").replace(/[ⅠⅡⅢ]+$/, "");
    const byNorm = {};
    sectors.forEach((s) => { const k = norm(s.name); if (byNorm[k] == null) byNorm[k] = s; });
    const mineCards = [];
    mine.forEach((m) => {
      const key = norm(m.industry);
      // 行业名容错匹配（东财 2025 行业分类细化为带 Ⅱ 后缀的二级名，板块名与股票 f100 需归一对齐）
      const s = byNorm[key]
        || sectors.find((x) => key.length >= 2 && norm(x.name).indexOf(key) === 0)
        || sectors.find((x) => norm(x.name).length >= 2 && key.indexOf(norm(x.name)) === 0);
      if (s) mineCards.push({ ...s, name: m.industry, mine: true, weight: m.percent });
    });
    const usedCodes = new Set(mineCards.map((m) => m.code));
    const others = sectors
      .filter((s) => !usedCodes.has(s.code))
      .sort((a, b) => (b.changeRate != null ? b.changeRate : -999) - (a.changeRate != null ? a.changeRate : -999));
    return { code: 0, data: { overview, sectors: mineCards.concat(others), mineCount: mineCards.length, flows } };
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

// 行业板块行情：领涨 30 + 领跌 15（板块库已细化至 ~496 个，全量拉取过重且无展示必要）。
// ⚠️ clist 必须带 ut 令牌（东财 web 公开 token），否则返回空
async function fetchSectors() {
  const base = "https://push2.eastmoney.com/api/qt/clist/get?np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f128,f136&ut=bd1d9ddb04089700cf9c27f6f7426281";
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
  const tryUrl = async (url) => {
    try {
      const body = await httpGet(url);
      return parse(body);
    } catch (e) {
      return [];
    }
  };
  const suffix = "&pn=1&pz=30&po=1";
  const suffixAsc = "&pn=1&pz=15&po=0";
  // 云函数出口对 clist 偶发限流：主站 → delay 镜像 依次尝试
  let desc = await tryUrl("https://push2.eastmoney.com/api/qt/clist/get?np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f128,f136&ut=bd1d9ddb04089700cf9c27f6f7426281" + suffix);
  let asc = await tryUrl("https://push2.eastmoney.com/api/qt/clist/get?np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f128,f136&ut=bd1d9ddb04089700cf9c27f6f7426281" + suffixAsc);
  if (!desc.length && !asc.length) {
    desc = await tryUrl("https://push2delay.eastmoney.com/api/qt/clist/get?np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f128,f136&ut=bd1d9ddb04089700cf9c27f6f7426281" + suffix);
    asc = await tryUrl("https://push2delay.eastmoney.com/api/qt/clist/get?np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14,f128,f136&ut=bd1d9ddb04089700cf9c27f6f7426281" + suffixAsc);
  }
  const seen = new Set();
  const out = [];
  for (const s of [...desc, ...asc]) {
    if (!seen.has(s.code)) { seen.add(s.code); out.push(s); }
  }
  return out;
}

// 用户持仓行业权重（市值加权，口径同 getPortfolio 资产配置）
async function fetchUserIndustries(openid) {
  try {
    const hRes = await db.collection("holdings").where({ _openid: openid })
      .field({ fundCode: true, marketValue: true, shares: true, nav: true })
      .limit(200).get();
    const holdings = hRes.data || [];
    if (!holdings.length) return [];
    const codes = [...new Set(holdings.map((h) => h.fundCode).filter(Boolean))];
    if (!codes.length) return [];

    // 各基金最新一次温度明细（detailPEs 含重仓股行业/占比），date 降序分页后取每基金首条
    const temps = [];
    {
      const PAGE = 100;
      let skip = 0;
      while (skip < 5000) {
        const res = await db.collection("fund_temperatures")
          .where({ fundCode: _.in(codes) })
          .field({ fundCode: true, date: true, detailPEs: true })
          .orderBy("date", "desc").skip(skip).limit(PAGE).get();
        temps.push(...(res.data || []));
        if ((res.data || []).length < PAGE) break;
        skip += PAGE;
      }
    }
    const latest = {};
    for (const t of temps) {
      if (!latest[t.fundCode]) latest[t.fundCode] = t;
    }

    const industryMap = {};
    let totalWeight = 0;
    for (const h of holdings) {
      const t = latest[h.fundCode];
      if (!t || !t.detailPEs || !t.detailPEs.length) continue;
      const fundValue = +(h.marketValue != null ? h.marketValue : (parseFloat(h.shares) || 0) * (parseFloat(h.nav) || 0)) || 0;
      if (fundValue <= 0) continue;
      for (const pe of t.detailPEs) {
        const w = fundValue * ((parseFloat(pe.ratio)) || 0) / 100;
        const cat = ft.classifyIndustryLabel(pe.industry, pe.name);
        industryMap[cat] = (industryMap[cat] || 0) + w;
        totalWeight += w;
      }
    }
    if (totalWeight <= 0) return [];
    return Object.entries(industryMap)
      .filter(([k]) => k !== "其他")
      .map(([industry, w]) => ({ industry, percent: +((w / totalWeight) * 100).toFixed(1) }))
      .sort((a, b) => b.percent - a.percent);
  } catch (e) {
    console.error("[fetchMarketOverview] 持仓行业失败:", e.message);
    return [];
  }
}
