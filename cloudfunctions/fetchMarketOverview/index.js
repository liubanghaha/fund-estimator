const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const ft = require("./_shared/fund-temperature");
const fd = require("./_shared/fund-data");

// 非用户数据（概览/行业/资金流）30s 共享缓存：内存为主的快路径 + 云数据库跨实例共享——
// 全环境同一半分钟最多一轮东财外呼，把请求密度压到"正常网页浏览"量级，从源头避免东财限流窗口。
// 持仓行业随 OPENID 每次重算，不走共享缓存（跨用户复用会串数据）。
const SHARED_TTL = 30 * 1000;
const DB_CACHE_KEY = "market_overview_shared";
let _sharedCache = null;
let _sharedTs = 0;

async function loadDbShared() {
  try {
    const r = await db.collection("app_config").doc(DB_CACHE_KEY).get();
    if (r && r.data && r.data.ts && Date.now() - r.data.ts < SHARED_TTL) return r.data;
  } catch (e) { /* 文档不存在/读失败视为未命中 */ }
  return null;
}

async function saveDbShared(payload) {
  try {
    await db.collection("app_config").doc(DB_CACHE_KEY).set({ data: { ...payload, ts: Date.now() } });
  } catch (e) { /* 写失败不影响主流程 */ }
}

// 行情中心 V1 数据源（云函数无域名白名单限制）：
// - 概览：东财 push2 行情字段，沪综指(1.000001/全沪) + 深综指(0.399106/全深)：
//   f6=成交额(元)，f104/f105/f106=成分内上涨/下跌/平盘家数，两市合计 ≈ 全市场
// - 行业板块：东财 push2 clist 行业板块（fs=m:90+t:2），f14=名称 f3=涨跌幅
//   注：不取 f128/f136（领涨股名称/涨跌幅）——个股行情不在本小程序服务范围内
// - 持仓行业置顶：holdings 市值 × fund_temperatures.detailPEs 重仓股行业占比
//   （分类口径 ft.classifyIndustryLabel 与 getPortfolio 资产配置一致，东财 f100 行业名与板块名同源可精确匹配）

exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext();
    let overview, sectors, flows;
    if (_sharedCache && Date.now() - _sharedTs < SHARED_TTL) {
      ({ overview, sectors, flows } = _sharedCache);
    } else {
      const dbShared = await loadDbShared();
      if (dbShared) {
        ({ overview, sectors, flows } = dbShared);
        _sharedCache = dbShared;
        _sharedTs = Date.now();
      } else {
        [overview, sectors, flows] = await Promise.all([
        fetchOverview(),
        fetchSectors(),
        fetchIndexFlows(),
      ]);
      // 只缓存完整可用结果：概览或行业任一失败的混合结果不入缓存——
      // 否则行业（clist 稳定）总会把 overview=null 的坏窗口写进 60s 缓存，好窗口也一直被 null 命中
      if (overview && sectors.length > 0) {
        _sharedCache = { overview, sectors, flows };
        _sharedTs = Date.now();
        saveDbShared(_sharedCache); // 跨实例共享（异步不阻塞），写失败下次重拉
      }
      }
    }
    // 双源均失败：回退上次可用共享缓存（标 stale），无则空标记由客户端兜底展示
    if (!overview && sectors.length === 0) {
      const last = (_sharedCache && (_sharedCache.overview || _sharedCache.sectors.length)) ? _sharedCache : await loadDbShared();
      if (last && (last.overview || last.sectors.length)) {
        return { code: 0, data: { overview: last.overview, sectors: last.sectors, mineCount: 0, flows: last.flows, empty: false, stale: true } };
      }
      return { code: 0, data: { overview: null, sectors: [], mineCount: 0, flows: {}, empty: true } };
    }
    const mine = OPENID ? await fetchUserIndustries(OPENID) : [];
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
    // 展示封顶：领涨 30 + 领跌 15（全量列表仅作匹配池，全部展示要翻 80+ 页）
    const displayOthers = others.length > 45 ? others.slice(0, 30).concat(others.slice(-15)) : others;
    return { code: 0, data: { overview, sectors: mineCards.concat(displayOthers), mineCount: mineCards.length, flows } };
  } catch (e) {
    console.error("[fetchMarketOverview] 失败:", e.message || e);
    return { code: 500, msg: "行情数据获取失败" };
  }
};

function httpGet(url, timeout = 8000) {
  const once = () => new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15" },
    }, (res) => { res.setEncoding("utf8");
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
// ulist.np 偶发限流/断连（实测云出站 IP 分钟级窗口，socket hang up 是抛错不是空响应）：
// 每一步都 catch 拉空后继续，链上任一源可用即出数据；涨跌家数仅东财有，缺失时客户端显示 "--"
async function fetchOverview() {
  try {
    const u1 = parseUlistOverview(await httpGet("https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f6,f12,f104,f105,f106&secids=1.000001,0.399106&ut=bd1d9ddb04089700cf9c27f6f7426281").catch(() => null));
    if (u1) return u1;
    const u2 = parseUlistOverview(await httpGet("https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f6,f12,f104,f105,f106&secids=1.000001,0.399106&ut=bd1d9ddb04089700cf9c27f6f7426281").catch(() => null));
    if (u2) return u2;
    const s1 = await fetchOverviewViaStockGet();
    if (s1) return s1;
    // 东财各变体均受限：腾讯/新浪兜底（只有成交额；涨跌家数公开源只有东财，缺失时客户端显示 "--"）
    const t = await fetchOverviewViaTencent();
    if (t) return t;
    return await fetchOverviewViaSina();
  } catch (e) {
    console.error("[fetchMarketOverview] 概览失败:", e.message);
    return null;
  }
}

function parseUlistOverview(body) {
  if (!body || body === "null") return null;
  try {
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
  } catch (e) { return null; }
}

async function fetchOverviewViaStockGet() {
  const q = "fltt=2&fields=f6,f104,f105,f106&ut=bd1d9ddb04089700cf9c27f6f7426281";
  const out = { shAmount: null, szAmount: null, up: 0, down: 0, flat: 0 };
  for (const secid of ["1.000001", "0.399106"]) {
    let body = await httpGet(`https://push2.eastmoney.com/api/qt/stock/get?${q}&secid=${secid}`);
    if (!body || body === "null") body = await httpGet(`https://push2delay.eastmoney.com/api/qt/stock/get?${q}&secid=${secid}`);
    if (!body || body === "null") continue;
    try {
      const d = JSON.parse(body).data || {};
      if (secid === "1.000001") out.shAmount = d.f6 != null ? +d.f6 : null;
      else out.szAmount = d.f6 != null ? +d.f6 : null;
      out.up += +d.f104 || 0;
      out.down += +d.f105 || 0;
      out.flat += +d.f106 || 0;
    } catch (e) { /* 单源失败继续下一源 */ }
  }
  if (out.shAmount == null && out.szAmount == null && !out.up && !out.down) return null;
  return out;
}

// 腾讯短格式指数行情：s_sh000001 ~ 分隔字段 idx6=成交量(手)，idx7=成交额(万元)（与东财 f6 同口径，万级取整）
// 返回不含涨跌家数的部分概览 {shAmount, szAmount}
async function fetchOverviewViaTencent() {
  try {
    const body = await httpGet("https://qt.gtimg.cn/q=s_sh000001,s_sz399106");
    const out = { shAmount: null, szAmount: null };
    (body || "").split(";").forEach((line) => {
      const m = line.trim().match(/^v_s_(\w+)="([^"]*)"$/);
      if (!m) return;
      const f = m[2].split("~");
      const amt = parseFloat(f[7]) > 0 ? parseFloat(f[7]) * 10000 : null;
      if (m[1] === "sh000001") out.shAmount = amt;
      else if (m[1] === "sz399106") out.szAmount = amt;
    });
    if (out.shAmount == null && out.szAmount == null) return null;
    return out;
  } catch (e) { return null; }
}

// 新浪指数行情：hq.sinajs.cn 逗号分隔 idx8=成交量(手)，idx9=成交额(元)（与东财 f6 同口径精确值）
async function fetchOverviewViaSina() {
  try {
    const body = await new Promise((resolve, reject) => {
      const req = https.get("https://hq.sinajs.cn/list=sh000001,sz399106", {
        headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)" },
      }, (res) => { res.setEncoding("utf8");
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
      req.setTimeout(8000, () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
    });
    const out = { shAmount: null, szAmount: null };
    (body || "").split("\n").forEach((line) => {
      const m = line.match(/var hq_str_(sh000001|sz399106)="([^"]*)"/);
      if (!m) return;
      const f = m[2].split(",");
      const amt = parseFloat(f[9]) > 0 ? parseFloat(f[9]) : null;
      if (m[1] === "sh000001") out.shAmount = amt;
      else out.szAmount = amt;
    });
    if (out.shAmount == null && out.szAmount == null) return null;
    return out;
  } catch (e) { return null; }
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
      })).filter((s) => s.name);
    } catch (e) { return []; } // 限流/空响应体容错
  };
  const tryPage = async (pn) => {
    const q = `pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14&ut=bd1d9ddb04089700cf9c27f6f7426281`;
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

// 用户持仓行业权重（市值加权，口径同 getPortfolio 资产配置）
async function fetchUserIndustries(openid) {
  try {
    const hRes = await db.collection("holdings").where({ _openid: openid })
      .field({ fundCode: true, marketValue: true, shares: true, nav: true, amount: true, buyPrice: true })
      .limit(200).get();
    const holdings = hRes.data || [];
    if (!holdings.length) return [];
    const codes = [...new Set(holdings.map((h) => h.fundCode).filter(Boolean))];
    if (!codes.length) return [];

    // 市值口径与 getPortfolio 对齐：按「最新净值 × 份额」重算，不用存储 marketValue——
    // 后者仅在建仓/编辑时写入不随净值更新，同一持仓在两页占比会不一致。拉取失败回退存储值不塌缩。
    const navMap = {};
    {
      const CONCURRENT = 8;
      for (let i = 0; i < codes.length; i += CONCURRENT) {
        const batch = codes.slice(i, i + CONCURRENT);
        const batchResults = await Promise.all(batch.map(async (code) => {
          try {
            const r = await fd.fetchLatestNavEastMoney(code);
            return [code, r && r.actualNav > 0 ? r.actualNav : null];
          } catch (e) { return [code, null]; }
        }));
        batchResults.forEach(([code, nav]) => { if (nav != null) navMap[code] = nav; });
        if (i + CONCURRENT < codes.length) await new Promise(r => setTimeout(r, 150));
      }
    }
    // 旧 schema（amount/nav）兼容：与 getPortfolio 同款 shares 反推，缺失份额的持仓整只跳过会塌缩覆盖
    const weightedHoldings = holdings.map((h) => {
      let shares = parseFloat(h.shares) || 0;
      const buyPrice = parseFloat(h.buyPrice) || parseFloat(h.nav) || 0;
      if (!shares && h.amount && buyPrice > 0) shares = parseFloat(h.amount) / buyPrice;
      if (!(shares > 0)) return null;
      const nav = navMap[h.fundCode];
      return { ...h, shares, marketValue: nav != null && nav > 0 ? String(nav * shares) : h.marketValue };
    }).filter(Boolean);

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

    // 聚合走 _shared 共享实现（与 getPortfolio 资产配置完全同口径），剔除「其他」后返回
    const agg = ft.aggregateUserIndustries(weightedHoldings, latest);
    return agg.list
      .filter((i) => i.industry !== "其他")
      .map((i) => ({ industry: i.industry, percent: +i.raw.toFixed(1) }));
  } catch (e) {
    console.error("[fetchMarketOverview] 持仓行业失败:", e.message);
    return [];
  }
}
