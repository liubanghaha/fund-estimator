const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = "events";
const RATE_WINDOW = 60000;  // 频控窗口 1 分钟
const RATE_LIMIT = 60;      // 单用户每窗口最多 60 条（正常使用远低于此）

// 内存频控（单实例足够：埋点流量低；防恶意刷量污染运营数据）
const _hits = new Map();
function rateLimited(openid) {
  // Map 防无限增长：超阈值时顺手清扫一遍过期 key
  if (_hits.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _hits) {
      if (!v.length || now - v[v.length - 1] >= RATE_WINDOW) _hits.delete(k);
    }
  }
  const now = Date.now();
  const arr = (_hits.get(openid) || []).filter((t) => now - t < RATE_WINDOW);
  const limited = arr.length >= RATE_LIMIT;
  arr.push(now);
  _hits.set(openid, arr);
  return limited;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };
  const list = Array.isArray(event && event.events) ? event.events : [];
  if (!list.length) return { code: 0 };
  if (rateLimited(OPENID)) return { code: 429, msg: "rate limited" };

  // 客户端已定格属性，这里只补 openid（对齐原直连写库时微信自动补 _openid 的口径）。
  // 服务端 SDK 的 add 支持自定义 _id，必须剔除，防调用方预占文档 _id
  // 字段卫生：字符串截断 + 非有限数置空 + 整体超限丢弃（事件属性由客户端 track.js 定格，
  // 这里只做防御性上限，防异常大 payload 入库——与 manageTransaction 白名单同类台账项）
  const MAX_STR = 500, MAX_JSON = 4096;
  const clean = list.slice(0, 50).map((e) => {
    const c = Object.assign({}, e, { _openid: OPENID });
    delete c._id;
    for (const k of Object.keys(c)) {
      if (typeof c[k] === "string") c[k] = c[k].slice(0, MAX_STR);
      else if (typeof c[k] === "number" && !isFinite(c[k])) c[k] = null;
    }
    return JSON.stringify(c).length > MAX_JSON ? null : c;
  }).filter(Boolean);
  if (!clean.length) return { code: 0 };
  await Promise.all(clean.map((e) =>
    db.collection(COLLECTION).add({ data: e }).catch(() => { /* 单条失败不阻塞整批 */ })
  ));
  return { code: 0 };
};
