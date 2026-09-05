const cloud = require("wx-server-sdk");
const https = require("https");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 资讯聚合：东财 7×24 快讯（主源，翻页游标 sortEnd）+ 金十快讯（宏观/国际补强，仅首页合并）
// + 东财要闻列表（标题+摘要+来源，无正文跳转：web-view 业务域名无法覆盖第三方站点）。
// 每条统一打标：source 来源 / category 分类（fund>stock>macro>mix 关键词判定）/ important 重要（em.titleColor、金十 important）

const KW_FUND = ["基金", "公募", "私募", "ETF", "申赎", "赎回", "基金经理", "净值", "份额", "发行"];
const KW_STOCK = ["A股", "沪指", "深证", "创业板", "港股", "美股", "纳指", "道指", "标普", "收盘", "开盘", "涨停", "跌停", "板块", "两市", "券商", "IPO", "个股", "股价", "市值", "股市", "上市"];
const KW_MACRO = ["央行", "美联储", "利率", "CPI", "PMI", "GDP", "汇率", "国债", "通胀", "降准", "降息", "LPR", "财政部", "统计局", "关税", "外汇", "人民币", "原油"];

function stripHtml(text) {
  return String(text || "").replace(/<[^>]+>/g, "").trim();
}

function classify(text) {
  const t = String(text || "");
  if (KW_FUND.some((k) => t.includes(k))) return "fund";
  if (KW_STOCK.some((k) => t.includes(k))) return "stock";
  if (KW_MACRO.some((k) => t.includes(k))) return "macro";
  return "mix";
}

function httpGet(url, headers = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ "User-Agent": "Mozilla/5.0" }, headers) }, (res) => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => resolve(b));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// 东财 7×24 快讯（fastColumn=102 全部；titleColor>0 为加红重要）
async function fetchEMFlash(sortEnd) {
  try {
    const url = `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=${encodeURIComponent(sortEnd)}&pageSize=50&req_trace=${Date.now()}`;
    const d = JSON.parse(await httpGet(url, { Referer: "https://kuaixun.eastmoney.com/" }));
    const data = d.data || {};
    const items = (data.fastNewsList || []).map((it) => ({
      id: "em_" + it.code,
      title: it.title || "",
      content: it.summary || it.title || "",
      time: it.showTime || "",
      important: (it.titleColor || 0) > 0,
      source: "em",
    })).filter((it) => it.content);
    return { items, sortEnd: data.sortEnd || "" };
  } catch (e) {
    console.error("[fetchNews] 东财快讯失败:", e.message);
    return { items: [], sortEnd: "" };
  }
}

// 金十快讯（宏观/国际/央行强项；important=1 为重要）
async function fetchJin10() {
  try {
    const d = JSON.parse(await httpGet("https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1", {
      "x-app-id": "bVBF4FyRTn5NJF5n",
      "x-version": "1.0.0",
      Origin: "https://www.jin10.com",
      Referer: "https://www.jin10.com/",
    }));
    const items = (d.data || []).map((it) => {
      const dd = it.data || {};
      return {
        id: "jin10_" + it.id,
        title: stripHtml(dd.title),
        content: stripHtml(dd.content || dd.title || ""),
        time: it.time || "",
        important: it.important == 1 || it.type == 2,
        source: "jin10",
      };
    }).filter((it) => it.content);
    return items;
  } catch (e) {
    console.error("[fetchNews] 金十快讯失败:", e.message);
    return [];
  }
}


exports.main = async (event = {}) => {
  try {
    const sortEnd = String(event.sortEnd || "");
    const [em, jin10] = await Promise.all([
      fetchEMFlash(sortEnd),
      sortEnd ? Promise.resolve([]) : fetchJin10(), // 翻页只走东财游标；金十仅首页补强
    ]);

    // 双源按时间归并 + 前 18 字指纹去重（同一事件两源都发）
    const seen = new Set();
    const flash = [];
    [...em.items, ...jin10]
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .forEach((it) => {
        const key = String(it.content || "").replace(/\s+/g, "").slice(0, 18);
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        flash.push(Object.assign({}, it, { category: classify((it.title || "") + " " + it.content) }));
      });

    return { code: 0, data: { flash: { items: flash, sortEnd: em.sortEnd } } };
  } catch (e) {
    console.error("[fetchNews] 失败:", e.message || e);
    return { code: 500, msg: "资讯获取失败" };
  }
};
