const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 从 env.json 读取密钥（不提交 Git），fallback 到环境变量
let BAIDU_API_KEY = process.env.BAIDU_API_KEY || "";
let BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY || "";
try {
  const env = require("./env.json");
  BAIDU_API_KEY = env.BAIDU_API_KEY || BAIDU_API_KEY;
  BAIDU_SECRET_KEY = env.BAIDU_SECRET_KEY || BAIDU_SECRET_KEY;
} catch (e) { /* env.json 不存在则使用环境变量 */ }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: "请先登录" };
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  const debug = {};
  let text = null, method = "none";

  // 1. 百度 OCR
  console.log('[ocrTx] trying baidu...');
  const baidu = await doBaiduOCR(fileID);
  debug.baidu = { ok: !!baidu.text, err: baidu.err, len: baidu.text ? baidu.text.length : 0 };
  console.log('[ocrTx] baidu result:', JSON.stringify(debug.baidu));
  if (baidu.text && baidu.text.length > 10) { text = baidu.text; method = "baidu"; }

  // 2. 微信兜底
  if (!text) {
    console.log('[ocrTx] falling back to wechat...');
    const wxText = await doWechatOCR(fileID);
    debug.wx = { ok: !!wxText, len: wxText ? wxText.length : 0 };
    console.log('[ocrTx] wechat result:', JSON.stringify(debug.wx));
    if (wxText) { text = wxText; method = "wechat"; }
  }

  // 3. OCR.space 兜底
  if (!text) {
    console.log('[ocrTx] falling back to ocr.space...');
    const sp = await doSpaceOCR(fileID);
    debug.space = { ok: !!sp, len: sp ? sp.length : 0 };
    console.log('[ocrTx] space result:', JSON.stringify(debug.space));
    if (sp) { text = sp; method = "space"; }
  }

  if (!text) { console.log('[ocrTx] all engines failed'); return { code: 500, msg: "OCR识别失败", debug }; }

  console.log('[ocrTx] raw text (' + text.length + ' chars):', text.slice(0, 500));
  const transactions = parseTransactions(text);
  console.log('[ocrTx] parsed transactions:', transactions.length);
  debug.txCount = transactions.length;
  return { code: 0, data: { raw: text, method, transactions, debug, ...(transactions[0] || {}) } };
};

// ========== OCR 引擎 ==========

async function doWechatOCR(fileID) {
  try {
    const r = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" });
    if (r.items && r.items.length) return r.items.map(i => i.text).join("\n");
  } catch (e) {}
  return null;
}

async function doSpaceOCR(fileID) {
  try {
    const tr = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = tr.fileList[0] && tr.fileList[0].tempFileURL;
    if (!url) return null;
    const https = require("https"), qs = require("querystring");
    const body = qs.stringify({ url, language: "chs", isOverlayRequired: "false", detectOrientation: "true", OCREngine: "2" });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: "api.ocr.space", path: "/parse/image", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", apikey: "helloworld", "Content-Length": Buffer.byteLength(body) },
      }, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => {
          try { const j = JSON.parse(d); resolve((j.ParsedResults||[])[0]?.ParsedText||null); } catch(e) { resolve(null); }
        });
      });
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.write(body); req.end();
    });
  } catch(e) { return null; }
}

async function doBaiduOCR(fileID) {
  try {
    const r = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = r.fileList[0] && r.fileList[0].tempFileURL;
    if (!url) return { text: null, err: "no url" };
    const https = require("https"), http = require("http");
    const imgBase64 = await new Promise((resolve) => {
      const mod = url.startsWith("https") ? https : http;
      const chunks = [];
      mod.get(url, (res) => { res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks).toString("base64"))); }).on("error", () => resolve(null));
    });
    if (!imgBase64) return { text: null, err: "download fail" };
    const tokenRes = await new Promise((resolve) => {
      https.get(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_API_KEY}&client_secret=${BAIDU_SECRET_KEY}`, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d).access_token); } catch(e) { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    if (!tokenRes) return { text: null, err: "token fail" };
    const body = `image=${encodeURIComponent(imgBase64)}&language_type=CHN_ENG`;
    const text = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "aip.baidubce.com", path: `/rest/2.0/ocr/v1/accurate_basic?access_token=${tokenRes}`,
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { const j = JSON.parse(d); if (j.error_msg) reject(new Error(j.error_msg)); else resolve((j.words_result || []).map(w => w.words).join("\n")); } catch(e) { reject(e); } }); });
      req.write(body); req.end();
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", (e) => reject(e));
    });
    return { text, err: null };
  } catch(e) { return { text: null, err: e.message }; }
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
    const rawDate = dtm[1].replace(/[./]/g, "-").substring(0, 10);
    const hour = parseInt(dtm[2].split(":")[0], 10);
    if (hour >= 15) {
      const d = new Date(rawDate);
      d.setDate(d.getDate() + 1);
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      const pad = (n) => String(n).padStart(2, "0");
      tx.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    } else {
      tx.date = rawDate;
    }
    tx.time = dtm[2];
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
