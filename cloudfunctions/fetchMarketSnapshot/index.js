const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 海外市场快照（合规口径：只做港股/美股/海外标的，不含 A 股个股与指数）
// 数据源：新浪外盘 hf_（期货/商品）、新浪外汇 fx_、新浪美股 gb_、东财全球 100.*（欧洲指数）
const FUTURES = [
  { key: "NQ", name: "纳指100期货", sina: "hf_NQ" },
  { key: "ES", name: "标普500期货", sina: "hf_ES" },
  { key: "YM", name: "道指期货", sina: "hf_YM" },
];
const COMMODITIES = [
  { key: "XAU", name: "伦敦金", sina: "hf_XAU" },
  { key: "CL", name: "纽约原油", sina: "hf_CL" },
  { key: "HG", name: "纽约铜", sina: "hf_HG" },
];
const FX = [
  { key: "USDCNY", name: "美元/人民币", sina: "fx_susdcny" },
  { key: "HKDCNY", name: "港元/人民币", sina: "fx_shkdcny" },
];
// 东财国际指数代码：DAX30=GDAXI、法国CAC40=FCHI（100.DAX/100.CAC 不存在）
const EU_INDICES = [
  { key: "DAX", name: "德国DAX30", secid: "100.GDAXI" },
  { key: "FTSE", name: "英国富时100", secid: "100.FTSE" },
  { key: "CAC", name: "法国CAC40", secid: "100.FCHI" },
];

exports.main = async (event = {}) => {
  // usCodes：持仓里出现的美股代码（大写 ticker），用于判定"盘前/盘后"
  const usCodes = Array.isArray(event.usCodes) ? event.usCodes.filter((c) => /^[A-Z.]{1,8}$/.test(c)).slice(0, 20) : [];
  try {
    const [futures, commodities, fx, eu, us] = await Promise.all([
      fetchSinaQuotes(FUTURES.map((x) => x.sina), "hf"),
      fetchSinaQuotes(COMMODITIES.map((x) => x.sina), "hf"),
      fetchSinaQuotes(FX.map((x) => x.sina), "fx"),
      fetchEuIndices(),
      usCodes.length ? fetchSinaQuotes(usCodes.map((c) => "gb_" + c.toLowerCase()), "gb") : Promise.resolve([]),
    ]);
    // 名称一律用本地定义（新浪是 GBK，latin1 解出来是乱码），数值用数据源的
    const byKey = (list, defs) => defs.map((d, i) => Object.assign({}, list[i] || null, { key: d.key, name: d.name }));
    // 美股：名称由客户端用自己的持仓名，不取新浪 GBK 名称（latin1 解码是乱码）
    const usOut = usCodes.map((code, i) => {
      const q = us[i];
      return q ? { code, price: q.price, changeRate: q.changeRate, prevClose: q.prevClose, time: q.time, tickTime: q.tickTime, session: q.session } : null;
    }).filter(Boolean);
    return {
      code: 0,
      msg: "success",
      data: {
        futures: byKey(futures, FUTURES),
        commodities: byKey(commodities, COMMODITIES),
        fx: byKey(fx, FX),
        eu: byKey(eu, EU_INDICES),
        us: usOut,
        updatedAt: bjNow(),
      },
    };
  } catch (e) {
    console.error("海外市场快照失败:", e.message || e);
    return { code: 500, msg: "获取行情失败" };
  }
};

// ========== 新浪批量（hq.sinajs.cn，GBK，需 Referer） ==========

function fetchSinaQuotes(symbols, kind) {
  if (!symbols.length) return Promise.resolve([]);
  const url = `https://hq.sinajs.cn/list=${symbols.join(",")}`;
  return httpGet(url, { Referer: "https://finance.sina.com.cn/" }).then((body) => {
    // 逐行 var hq_str_xxx="..."; —— 按请求顺序对齐（缺失的给 null）
    const out = [];
    for (const sym of symbols) {
      const m = body.match(new RegExp('hq_str_' + sym.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&") + '="([^"]*)"'));
      const parts = m && m[1] ? m[1].split(",") : null;
      out.push(parts ? parseSina(parts, kind) : null);
    }
    return out;
  });
}

function parseSina(p, kind) {
  const num = (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  if (kind === "hf") {
    // 外盘期货/商品：0 最新价 4 最高 5 最低 6 时间 7 昨收 8 今开 13 名称
    const price = num(p[0]), prevClose = num(p[7]);
    if (price == null || price <= 0) return null;
    return {
      name: p[13] || "",
      price,
      prevClose,
      high: num(p[4]),
      low: num(p[5]),
      time: p[6] || "",
      changeRate: prevClose > 0 ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null,
    };
  }
  if (kind === "fx") {
    // 外汇：0 时间 3 昨收 8 最新价 9 名称 10 涨跌幅% 11 涨跌额
    const price = num(p[8]);
    if (price == null || price <= 0) return null;
    return {
      name: p[9] || "",
      price,
      prevClose: num(p[3]),
      time: p[0] || "",
      changeRate: num(p[10]),
    };
  }
  // 美股 gb_：1 最新价 2 涨跌幅% 3 北京时间 4 涨跌额 24 最新成交时间(ET) 25 常规收盘时间(ET) 26 昨收 0 名称
  const price = num(p[1]);
  if (price == null || price <= 0) return null;
  const tickTime = p[24] || "";
  return {
    name: p[0] || "",
    price,
    prevClose: num(p[26]),
    time: p[3] || "",
    tickTime,
    changeRate: num(p[2]),
    session: usSession(p[3] || "", tickTime),
  };
}

// 美股当前价处于哪个时段：盘前(<09:30 ET)/盘中/盘后(>=16:00 ET)。
// freshness 用北京时间的日期判定（新浪 gb_ 的字段 3 就是北京时间），避开夏令时换算
function usSession(bjTime, tickTime) {
  const now = new Date();
  const bjToday = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const fresh = (bjTime || "").slice(0, 10) === bjToday;
  const m = (tickTime || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return { state: fresh ? "regular" : "", fresh };
  let h = +m[1] % 12;
  if ((m[3] || "").toUpperCase() === "PM") h += 12;
  const min = h * 60 + (+m[2]);
  const state = min < 570 ? "pre" : min < 960 ? "regular" : "post";
  return { state, fresh, etTime: m[1] + ":" + m[2] + (m[3] || "") };
}

// ========== 欧洲指数（东财全球，行情中心 100.* 前缀，两位小数 scale=100） ==========

function fetchEuIndices() {
  // fltt=2：返回的 f2/f3 已是原始价格与涨跌幅百分数，不用再猜缩放
  const secids = EU_INDICES.map((d) => d.secid).join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f13,f14,f2,f3&secids=${secids}`;
  return httpGet(url, { Referer: "https://quote.eastmoney.com/" }).then(async (body) => {
    if (!body || body === "null") {
      body = await httpGet(url.replace("push2.eastmoney.com", "push2delay.eastmoney.com"), { Referer: "https://quote.eastmoney.com/" });
    }
    try {
      const diff = (JSON.parse(body).data || {}).diff || [];
      return EU_INDICES.map((d) => {
        const hit = diff.find((x) => x.f13 + "." + x.f12 === d.secid);
        return hit && hit.f2 != null ? { price: +hit.f2, changeRate: hit.f3 != null ? +hit.f3 : null } : null;
      });
    } catch (e) { return EU_INDICES.map(() => null); }
  });
}

// ========== 通用 HTTP ==========

function bjNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
}

function httpGet(url, headers, timeoutMs = 8000) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(url, { headers: Object.assign({ "User-Agent": "Mozilla/5.0" }, headers || {}) }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
}
