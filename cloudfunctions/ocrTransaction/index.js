const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const td = require("./_shared/trading-day");

// 从 env.json 读取密钥（不提交 Git），fallback 到环境变量
let BAIDU_API_KEY = process.env.BAIDU_API_KEY || "";
let BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || "";
let OCRSPACE_API_KEY = process.env.OCRSPACE_API_KEY || "";
try {
  const env = require("./env.json");
  BAIDU_API_KEY = env.BAIDU_API_KEY || BAIDU_API_KEY;
  BAIDU_SECRET_KEY = env.BAIDU_SECRET_KEY || BAIDU_SECRET_KEY;
  OCRSPACE_API_KEY = env.OCRSPACE_API_KEY || OCRSPACE_API_KEY;
} catch (e) { /* env.json 不存在则使用环境变量 */ }

const _run = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };
  const t0 = Date.now();
  const debug = {};

  // 主链路：腾讯云 OCR（主源，带词坐标）→ 流水布局解析；百度备源
  const tencent = await doTencentOCR(fileID);
  debug.tencent = { ok: !!tencent.text, err: tencent.err, len: tencent.text ? tencent.text.length : 0 };
  if (tencent.words && tencent.words.length >= 3) {
    const txs = txParseWords(tencent.words);
    for (const t of txs) applyConfirmRollover(t);
    console.log('[ocrTx] tencent layout transactions:', txs.length, 'ms:', Date.now() - t0);
    if (txs.length > 0) {
      debug.txCount = txs.length;
      return { code: 0, data: { raw: tencent.text, method: "tencent-layout", transactions: txs, debug, ...(txs[0] || {}) } };
    }
    // 坐标解析空：再试一次腾讯文本的旧口径解析（兼容未适配格式）
    const legacyTx = parseTransactions(tencent.text || "");
    if (legacyTx.length > 0) {
      console.log('[ocrTx] tencent legacy text parse:', legacyTx.length);
      debug.txCount = legacyTx.length;
      return { code: 0, data: { raw: tencent.text, method: "tencent", transactions: legacyTx, debug, ...(legacyTx[0] || {}) } };
    }
    // 腾讯读到了但解析不出 → 继续百度（分词/切行不同可能出结果）
  }

  // 备源：百度 OCR（带词坐标）→ 流水布局解析
  const baidu = await doBaiduOCR(fileID);
  debug.baidu = { ok: !!baidu.text, err: baidu.err, len: baidu.text ? baidu.text.length : 0 };
  if (baidu.words && baidu.words.length >= 3) {
    const txs = txParseWords(baidu.words);
    for (const t of txs) applyConfirmRollover(t);
    console.log('[ocrTx] layout transactions:', txs.length, 'ms:', Date.now() - t0);
    if (txs.length > 0) {
      debug.txCount = txs.length;
      return { code: 0, data: { raw: baidu.text, method: "baidu-layout", transactions: txs, debug, ...(txs[0] || {}) } };
    }
    // 坐标解析空：再试一次百度文本的旧口径解析（兼容未适配格式）
    const legacy = parseTransactions(baidu.text || "");
    if (legacy.length > 0) {
      console.log('[ocrTx] legacy text parse:', legacy.length);
      debug.txCount = legacy.length;
      return { code: 0, data: { raw: baidu.text, method: "baidu", transactions: legacy, debug, ...(legacy[0] || {}) } };
    }
    // 页面不含可识别交易（或非流水页）：返回空，不再用低质量文本瞎猜
    return { code: 0, data: { raw: baidu.text, method: "baidu-layout", transactions: [], debug, } };
  }

  // 百度不可用 → 微信/OCR.space 文本兜底
  let text = null, method = "none";
  if (!text) {
    console.log('[ocrTx] falling back to wechat...');
    const wxText = await withTimeout(doWechatOCR(fileID), 8000).catch(() => null);
    debug.wx = { ok: !!wxText, len: wxText ? wxText.length : 0 };
    if (wxText) { text = wxText; method = "wechat"; }
  }
  if (!text) {
    console.log('[ocrTx] falling back to ocr.space...');
    const sp = await doSpaceOCR(fileID);
    debug.space = { ok: !!sp, len: sp ? sp.length : 0 };
    if (sp) { text = sp; method = "space"; }
  }
  if (!text) { console.log('[ocrTx] all engines failed'); return { code: 500, msg: "OCR识别失败", reason: failReason(debug), debug }; }
  const transactions = parseTransactions(text);
  console.log('[ocrTx] parsed transactions:', transactions.length);
  debug.txCount = transactions.length;
  return { code: 0, data: { raw: text, method, transactions, debug, ...(transactions[0] || {}) } };
};

exports.main = async (event) => {
  const result = await _run(event);
  // 截图含用户完整资产信息：OCR 结束即删（成功失败都删，失败重试由用户重新选图）
  if (event && event.fileID) {
    cloud.deleteFile({ fileList: [event.fileID] }).catch(() => {});
  }
  return result;
};

// tx.date 语义 = 确认净值日。场外基金确认规则：交易日 15:00 前提交按当日净值；15:00 后或
// 非交易日（节假日/周末）提交顺延到下一交易日。原实现只 +1 天跳周末、不查节假日表，也不处理
// "提交日本身是非交易日"——国庆期间识别的每笔确认日全错（9/30 15:30→10/1、10/5 买入原地不动），
// 2026-10-06 用户反馈重写。
function applyConfirmRollover(tx) {
  if (!tx.date) return;
  let d = tx.date;
  if (!td.isTradingDay(d)) {
    // 非交易日提交（节假日/周末）：不论几点都按下一交易日净值确认
    d = td.nextTradingDay(d);
  } else {
    // 交易日：15:00 及以后顺延；截图缺时间保守按 15:00 前处理（T 日）
    const hour = tx.time ? parseInt(tx.time.split(":")[0], 10) : NaN;
    if (hour >= 15) d = td.nextTradingDay(d);
  }
  if (d !== tx.date) {
    // 顺延时保留原始申请日与原因，客户端结果卡展示"3点前/后、非交易日"判断结论
    tx.applyDate = tx.date;
    tx.rollReason = td.isTradingDay(tx.date) ? "15点后提交" : "非交易日提交";
    tx.date = d;
  }
}

// ========== 腾讯云 OCR（主源，2026-10-05 接入）==========
// 密钥优先级：环境变量 → env.json（不提交 Git）→ app_config 集合 doc "tencent_ocr"（{secretId,secretKey}，
// 改库即生效、无需重新部署）。未配置或格式不对（SecretId 应以 AKID 开头）时静默跳过本源，
// 链路退回 百度 → 微信/OCR.space。占位串（如 your-tencent-secret-id）按未配置处理。
const db = cloud.database();
let _txKeysCache = null; // { ts, keys|null }：命中后进程内复用；miss 缓存 5 分钟，避免每次识别都查库
async function loadTencentKeys() {
  let id = process.env.TC_SECRET_ID || "", key = process.env.TC_SECRET_KEY || "";
  try {
    const env = require("./env.json");
    id = env.TC_SECRET_ID || id;
    key = env.TC_SECRET_KEY || key;
  } catch (e) { /* env.json 不存在则用环境变量 */ }
  if (/^AKID/.test(id) && key) return { id, key };
  const now = Date.now();
  if (_txKeysCache && now - _txKeysCache.ts < 300000) return _txKeysCache.keys;
  let keys = null;
  try {
    const r = await db.collection("app_config").doc("tencent_ocr").get();
    const d = (r && r.data) || {};
    if (/^AKID/.test(d.secretId || "") && d.secretKey) keys = { id: d.secretId, key: d.secretKey };
  } catch (e) { /* 文档不存在/无权限 */ }
  _txKeysCache = { ts: now, keys };
  return keys;
}

let _txClientKeys = "";
// TC3-HMAC-SHA256 签名直连 ocr.tencentcloudapi.com——**刻意不用 tencentcloud-sdk-nodejs-ocr**：
// 2026-10-05 给该函数改 package.json 时格式写坏（JSON 尾部粘了 EOF），云端依赖安装失败、
// 函数卡进 UpdateFailed，CLI 部署静默假成功（API 调用成功 ≠ 安装成功），旧代码一直在跑。
// 内置 crypto 自签零新依赖，避开这条坑。
const crypto = require("crypto");
function txRequest(keys, action, params, timeoutMs) {
  const service = "ocr", host = "ocr.tencentcloudapi.com", version = "2018-11-19";
  const payload = JSON.stringify(params || {});
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const hashedPayload = crypto.createHash("sha256").update(payload).digest("hex");
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${hashedPayload}`;
  const toSign = `TC3-HMAC-SHA256\n${ts}\n${date}/${service}/tc3_request\n${crypto.createHash("sha256").update(canonical).digest("hex")}`;
  const kDate = crypto.createHmac("sha256", "TC3" + keys.key).update(date).digest();
  const kService = crypto.createHmac("sha256", kDate).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("tc3_request").digest();
  const sig = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: "/", method: "POST",
      headers: {
        "Host": host,
        "Content-Type": "application/json; charset=utf-8",
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Region": "ap-shanghai",
        "X-TC-Timestamp": String(ts),
        "Authorization": `TC3-HMAC-SHA256 Credential=${keys.id}/${date}/${service}/tc3_request, SignedHeaders=content-type;host, Signature=${sig}`,
      },
    }, (res) => {
      res.setEncoding("utf8");
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.Response && j.Response.Error) reject(Object.assign(new Error(j.Response.Error.Message), { code: j.Response.Error.Code }));
          else if (j.Response) resolve(j.Response);
          else reject(new Error("bad response: " + d.slice(0, 120)));
        } catch (e) { reject(new Error("bad json: " + d.slice(0, 120))); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", (e) => reject(e));
    req.write(payload); req.end();
  });
}

// 与客户端 30s 超时对齐的总预算内分段限流：任何一段超时都不拖垮整链
function withTimeout(p, ms) {
  let t;
  const race = Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]);
  return race.finally(() => clearTimeout(t));
}

// 返回与 doBaiduOCR 同构的 { text, words, err }：words（词+坐标）供坐标布局解析器使用
async function doTencentOCR(fileID) {
  try {
    const keys = await loadTencentKeys();
    if (!keys) return { text: null, words: null, err: "no keys" };
    const tr = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = tr.fileList && tr.fileList[0] && tr.fileList[0].tempFileURL;
    if (!url) return { text: null, words: null, err: "no url" };
    const res = await withTimeout(txRequest(keys, "GeneralAccurateOCR", { ImageUrl: url }, 10000), 11000);
    const dets = (res && res.TextDetections) || [];
    if (!dets.length) return { text: "", words: [], err: "empty" };
    const words = dets
      .filter((d) => d.ItemPolygon)
      .map((d) => ({
        words: d.DetectedText,
        location: { left: d.ItemPolygon.X, top: d.ItemPolygon.Y, width: d.ItemPolygon.Width, height: d.ItemPolygon.Height },
      }));
    return { text: dets.map((d) => d.DetectedText).join("\n"), words, err: null };
  } catch (e) {
    return { text: null, words: null, err: (e && (e.code ? e.code + " " + e.message : e.message)) || "tencent fail" };
  }
}

// 最终失败的原因归类，客户端据此区分文案（quota=额度耗尽 / timeout=超时 / no_text=没读出内容）
function failReason(debug) {
  const s = JSON.stringify(debug || {});
  if (/101003|not enough market quota|limit reached|daily request limit|LimitExceeded|Arrears|UnauthorizedOperation/i.test(s)) return "quota";
  if (/timeout/i.test(s)) return "timeout";
  return "no_text";
}

// ========== OCR 引擎 ==========

async function doWechatOCR(fileID) {
  try {
    const r = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" });
    if (r.items && r.items.length) return r.items.map(i => i.text).join("\n");
  } catch (e) {}
  return null;
}

async function doSpaceOCR(fileID) {
  if (!OCRSPACE_API_KEY) {
    console.log("[ocrTx] ocr.space skipped: no API key");
    return null;
  }
  try {
    const tr = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = tr.fileList[0] && tr.fileList[0].tempFileURL;
    if (!url) return null;
    const https = require("https"), qs = require("querystring");
    const body = qs.stringify({ url, language: "chs", isOverlayRequired: "false", detectOrientation: "true", OCREngine: "2" });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: "api.ocr.space", path: "/parse/image", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", apikey: OCRSPACE_API_KEY, "Content-Length": Buffer.byteLength(body) },
      }, (res) => { res.setEncoding("utf8");
        let d = ""; res.on("data", c => d += c); res.on("end", () => {
          try {
            const j = JSON.parse(d);
            const results = (j.ParsedResults || [])[0];
            resolve((results && results.ParsedText) || null);
          } catch (e) { resolve(null); }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.write(body); req.end();
    });
  } catch(e) { return null; }
}

// 百度 access_token 有效期 30 天，进程内缓存复用（原来每次识别都现取，白等 300-800ms）
let _baiduToken = { token: null, ts: 0 };
function fetchBaiduToken(https) {
  const now = Date.now();
  if (_baiduToken.token && now - _baiduToken.ts < 25 * 24 * 3600 * 1000) return Promise.resolve(_baiduToken.token);
  return new Promise((resolve) => {
    https.get(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_API_KEY}&client_secret=${BAIDU_SECRET_KEY}`, (res) => { res.setEncoding("utf8");
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d).access_token); } catch (e) { resolve(null); } });
    }).on("error", () => resolve(null));
  }).then((token) => {
    if (token) _baiduToken = { token, ts: now };
    return token;
  });
}

async function doBaiduOCR(fileID) {
  try {
    const r = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = r.fileList[0] && r.fileList[0].tempFileURL;
    if (!url) return { text: null, words: null, err: "no url" };
    const https = require("https"), http = require("http");
    const imgBase64 = await new Promise((resolve) => {
      const mod = url.startsWith("https") ? https : http;
      const chunks = [];
      mod.get(url, (res) => { res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks).toString("base64"))); }).on("error", () => resolve(null));
    });
    if (!imgBase64) return { text: null, words: null, err: "download fail" };
    const tokenRes = await fetchBaiduToken(https);
    if (!tokenRes) return { text: null, words: null, err: "token fail" };
    const body = `image=${encodeURIComponent(imgBase64)}&language_type=CHN_ENG`;
    // accurate 接口返回每个词的坐标 location，供布局解析器使用
    const json = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "aip.baidubce.com", path: `/rest/2.0/ocr/v1/accurate?access_token=${tokenRes}`,
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }, (res) => { res.setEncoding("utf8"); let d = ""; res.on("data", c => d += c); res.on("end", () => { try { const j = JSON.parse(d); if (j.error_msg) reject(new Error(j.error_msg)); else resolve(j); } catch (e) { reject(e); } }); });
      req.write(body); req.end();
      req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", (e) => reject(e));
    });
    const words = json.words_result || [];
    const text = words.map(w => w.words).join("\n");
    return { text, words, err: null };
  } catch (e) {
    return { text: null, words: null, err: e.message };
  }
}

// ========== 坐标布局解析器（交易流水格式） ==========

const TX_UI_WORDS = /^(买入|卖出|赎回|基金|持有|代码|金额|收益|份额|净值|成本|我的|全部|自选|黄金|详情|名称|资产|截图|添加|更多|产品|去市场|客服|转换|定投|讨论|理财师|投资指南|投资计划|收益明细|交易记录|累计盈亏|业绩走势|返回|清仓|分析|复盘|历史|持仓|现金|红利|再投资|待确认|中高|风险|昨日|日涨幅|基金净值|持仓成本价|持有份额|持有金额|持有收益|累计收益|收益率|日涨|市场|解读|公司|电台|基金市场|机会|看|偏股|偏债|指数|全部持有|明细|搜索|持有收益率|金额\/昨日|单位|资产详情|交易进行中|确认中|已完成)$/;
const TX_FUND_KW = /混合|股票|指数|债券|货币|ETF|LOF|QDII|FOF|联接|稳健|优选|精选|灵活|配置|成长|价值|蓝筹|红利|医疗|医药|消费|科技|资源|创新|前沿|多元|策略|增强|驱动|领航|纳斯达克|标普|恒生|全球|海外|黄金/;
const TX_MONEY_RE = /^[¥￥]?([\d,]+)(\.\d{1,2})?$/;
const TX_DATE_RE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/;

function txRows(words) {
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

function txIsMoney(t) {
  const m = t.match(TX_MONEY_RE);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, "") + (m[2] || ""));
}
function txIsNameish(t) {
  if (!t || t.length < 2) return false;
  if (TX_UI_WORDS.test(t) && t.length <= 8) return false;
  if (TX_FUND_KW.test(t)) return true;
  return /^[一-鿿]{3,}$/.test(t);
}
function txIsNameTail(t) {
  return /^[一-鿿]{0,3}[ABC]$/.test(t) || /^[一-鿿（）()A-Za-z]{1,8}?(?:混合|股票|指数|债券|联接|ETF|LOF|货币|稳健)[AC]?$/.test(t);
}

// 流水页布局解析：以"金额"为交易锚点，名称/动作在同行或相邻行（跨行配对）。
// 兼容多种布局：动作+名称+金额同行 / 动作+金额在上、名称在下 / 名称+金额同行 等（支付宝/天天/理财通通用）。
// 通用化：名称与金额互相独立、与左右顺序无关；清洗交易动作前缀（组合买入/定投买入等），避免污染基金名。
function txNormalize(txt) {
  // 去交易动作前缀：组合买入/定投买入/分批买入/部分卖出 等
  return txt.replace(/^(组合|定投|分批|部分)?\s*(买入|卖出|赎回)\s*/, "");
}
function txParseWords(words) {
  const rows = txRows(words);
  // 第一遍：每行提取 name / amount（任一可独立存在；金额为交易锚点）
  const filled = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let name = "", amount = "";
    for (const t of r.toks) {
      const norm = txNormalize(t.text);
      if (norm === "") continue; // 纯动作词
      const am = norm.match(/^([\d,]+\.?\d{0,2})元$/);
      if (am) { if (!amount) amount = am[1].replace(/,/g, ""); continue; }
      const v = txIsMoney(norm);
      if (v !== null && v >= 1) { if (!amount) amount = String(v); continue; }
      if (txIsNameish(norm) || /^[一-鿿]{3,}$/.test(norm)) name += norm;
    }
    filled.push({ i, r, name, amount });
  }
  const out = [];
  // 第二遍：以含金额的行为交易锚点；名称从本行或相邻行补全（跨行配对）
  for (let idx = 0; idx < filled.length; idx++) {
    const { r, name, amount } = filled[idx];
    if (!amount) continue; // 必须有金额（交易锚点）
    // 名称：本行优先；否则向下/向上找最近的非日期名行。
    // 兼容"状态行(交易进行中)插入金额与名称之间"的布局：向下多扫几行，跳过日期/状态/标签行，
    // 取第一个"完整基金名"作为名称；向上只配紧邻行，避免跨交易误配。
    let fullName = name;
    if (!fullName) {
      // 向下扫描多行（y 差 <300，覆盖一行状态行+名称行）
      for (let j = idx + 1; j < filled.length && j < idx + 5; j++) {
        const cand = filled[j];
        if (!cand) continue;
        const candName = cand.name;
        if (!candName) continue; // 该行无名称（日期/状态/标签行）
        if (Math.abs(cand.r.y - r.y) > 300) break; // 太远，不再找
        // 名称应为完整基金名（避免误配到日期/标签行）
        if (/[ABC]$/.test(candName) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(candName)) {
          fullName = candName; break;
        }
      }
      // 向下找不到 → 向上找紧邻行（名称可能在金额上方一行）
      if (!fullName) {
        const up = filled[idx - 1];
        if (up && up.name && Math.abs(up.r.y - r.y) < 160 && !TX_DATE_RE.test(up.r.text)) {
          if (/[ABC]$/.test(up.name) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(up.name)) {
            fullName = up.name;
          }
        }
      }
    }
    if (!fullName) continue; // 有金额但找不到名称，跳过
    // 名称结尾不完整 → 拼相邻行首词
    const nameEndsWell = /[ABC]$/.test(fullName) || /(?:混合|股票|指数|债券|货币|联接|ETF|LOF|QDII|FOF|稳健)$/.test(fullName);
    if (!nameEndsWell) {
      const nx = rows[idx + 1];
      if (nx && nx.y - r.y < 160 && !TX_DATE_RE.test(nx.text) && nx.toks.length && txIsNameTail(nx.toks[0].text)) {
        fullName += nx.toks[0].text;
      }
    }
    // 方向：本行或相邻行找动作词
    let type = "buy";
    for (const candText of [r.text, (rows[idx - 1] || {}).text || "", (rows[idx + 1] || {}).text || ""]) {
      if (/(卖出|赎回)/.test(candText)) { type = "sell"; break; }
    }
    // 日期：金额行后 1~3 行内
    let date = "", time = "";
    for (const nx of rows.slice(idx + 1, idx + 4)) {
      if (nx.y - r.y > 300) break;
      const m = nx.text.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
      if (m) { date = m[1].replace(/[./]/g, "-"); time = m[2] || ""; break; }
    }
    if (!out.some((t) => t.fundName === fullName && t.amount === amount && t.date === date)) {
      out.push({ type, fundName: fullName, amount, date, time });
    }
  }
  return out;
}

// ========== 交易解析 ==========

function parseTransactions(text) {
  text = text.replace(/基金\s+[|｜]/g, "基金|");
  const blocks = text.split(/基金[|｜]/);
  if (blocks.length <= 1) return [];
  const transactions = [];
  for (let i = 1; i < blocks.length; i++) {
    const tx = parseBlock(blocks[i]);
    if (tx.fundName) transactions.push(tx);
  }
  return transactions;
}

const FUND_TYPE_KW = "混合|股票|债券|指数|货币|ETF|FOF|联接|灵活|优选|稳健|成长|价值|蓝筹|红利|消费|医疗|医药|科技|新能源|半导体|军工|制造|印度|纳斯达克|标普|恒生|全球|海外|量化|策略|精选|前沿|多元|资源|配置|增强|行业|主题|轮动|升级|机遇|趋势|领航|智选|动力|改革|创新|优势|龙头|核心|品质|健康|养老|环保|高端|智能|互联|国企|央企|大盘|中小盘|创业|平衡|积极|安心|安享|定开|定投|纯债|信用|利率|短债|中短|可转债|固收|收益|添利|增利|双利|丰禄|季季|双月|月月|年年|稳利|鑫享|添益";

function extractFundName(text) {
  const patterns = [
    new RegExp("([一-鿿A-Z0-9]{2,24}(?:" + FUND_TYPE_KW + ")[一-鿿A-Za-z0-9（()LOF／QDII）]{0,16}[AC]?)"),
    new RegExp("([一-鿿0-9]{2,24}(?:" + FUND_TYPE_KW + "))"),
    /\d{6}\s*[-\s]?\s*([一-鿿A-Z0-9]{3,36})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      let name = m[1];
      const after = text.substring(m.index + m[0].length);
      const suffix = after.match(/^\s*([AC])\b/);
      if (suffix && !name.endsWith(suffix[1])) name += suffix[1];
      return name;
    }
  }
  return null;
}

function parseBlock(block) {
  const tx = {};
  const lines = block.split("\n");
  let nameStr = "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(t)) break;
    if (/^\d[\d,]*\.?\d{1,2}\s*(?:元|$)/.test(t)) break;
    if (/交易进行中|确认中|已完成/.test(t)) break;
    nameStr += t;
  }
  tx.fundName = extractFundName(nameStr) || extractFundName(block.replace(/\n/g, ""));
  if (!tx.fundName) return tx;

  const dtm = block.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (dtm) {
    tx.date = dtm[1].replace(/[./]/g, "-").substring(0, 10);
    tx.time = dtm[2];
    applyConfirmRollover(tx);
  } else {
    const dm = block.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
    if (dm) tx.date = dm[1].replace(/[./]/g, "-").substring(0, 10);
  }

  const am1 = block.match(/([\d,]+\.?\d{1,2})\s*元/);
  if (am1) { const v = parseFloat(am1[1].replace(/,/g, "")); if (v >= 1) tx.amount = String(v); }
  if (!tx.amount) {
    const am2 = block.match(/(?:金额|买入|卖出|成交)[^\d]*[¥￥]?([\d,]+\.?\d{0,2})/);
    if (am2) tx.amount = String(parseFloat(am2[1].replace(/,/g, "")));
  }
  if (!tx.amount) {
    const nums = block.match(/\d[\d,]*\.\d{1,2}/g);
    if (nums) {
      for (let j = nums.length - 1; j >= 0; j--) {
        const v = parseFloat(nums[j].replace(/,/g, ""));
        if (v >= 5 && v < 1e10) { tx.amount = String(v); break; }
      }
    }
  }

  tx.type = /卖出|赎回|减仓|转出/.test(block) ? "sell" : "buy";
  return tx;
}

// 仅供本地单测（/tmp 桩）直接调确认日换算用，不是云函数入口（入口恒为 main）
exports.__test = { applyConfirmRollover };
