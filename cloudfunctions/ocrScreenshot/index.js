const cloud = require("wx-server-sdk");
const crypto = require("crypto");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const TC_SECRET_ID = process.env.TC_SECRET_ID || "your-tencent-secret-id";
const TC_SECRET_KEY = process.env.TC_SECRET_KEY || "your-tencent-secret-key";

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  const engines = [wxOcr(fileID)];
  if (TC_SECRET_ID && TC_SECRET_KEY) engines.push(tencentOcr(fileID));
  engines.push(spaceOcr(fileID));

  const results = await Promise.allSettled(engines);
  const texts = [];
  for (const r of results) { if (r.status === 'fulfilled' && r.value) texts.push(r.value); }
  if (texts.length === 0) return { code: 500, msg: "OCR识别失败" };

  let best = [];
  for (const t of texts) {
    const h = parseTencentFormat(t);
    if (h.length > 0) { best = h; break; }
  }
  if (best.length === 0) {
    for (const t of texts) {
      const h = parseGeneric(t);
      if (h.length > best.length) best = h;
    }
  }

  const lookupDebug = [];
  for (const h of best) {
    if (!h.fundCode && h.fundName) {
      const r = await lookupFundCodeWithDebug(h.fundName);
      h.fundCode = r.code || undefined;
      lookupDebug.push(r);
    }
  }
  await crossValidate(best);

  return { code: 0, data: { raw: texts.join('\n---\n'), method: 'multi_ocr', holdings: best, lookupDebug } };
};

async function wxOcr(fileID) {
  try { const r = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" }); if (r.items && r.items.length) return r.items.map(i => i.text).join("\n"); } catch (e) {}
  return null;
}

async function spaceOcr(fileID) {
  try { const r = await cloud.getTempFileURL({ fileList: [fileID] }); const u = r.fileList[0] && r.fileList[0].tempFileURL; if (u) return await ocrSpaceAPI(u); } catch (e) {}
  return null;
}

function ocrSpaceAPI(url) {
  const http = require("http"), https = require("https"), qs = require("querystring");
  const body = qs.stringify({ url, language: "chs", isOverlayRequired: "false", detectOrientation: "true", OCREngine: "2" });
  const req = (m) => new Promise((resolve, reject) => {
    const r = m.request({ hostname: "api.ocr.space", path: "/parse/image", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apikey: "helloworld", "Content-Length": Buffer.byteLength(body) } },
    (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => {
      try { const j = JSON.parse(d); const p = j.ParsedResults || []; p.length && p[0].ParsedText ? resolve(p[0].ParsedText) : reject(new Error("empty")); }
      catch (e) { reject(e); }
    });});
    r.setTimeout(15000, () => { r.destroy(); reject(new Error("timeout")); });
    r.on("error", reject); r.write(body); r.end();
  });
  return req(http).catch(() => req(https));
}

async function tencentOcr(fileID) {
  try {
    const r = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = r.fileList[0] && r.fileList[0].tempFileURL;
    if (!url) return null;
    const imgBase64 = await downloadAsBase64(url);
    if (!imgBase64) return null;
    return await tencentGeneralOCR(imgBase64);
  } catch (e) { return null; }
}

function downloadAsBase64(url) {
  const https = require("https"), http = require("http");
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve) => {
    mod.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

function tencentGeneralOCR(imgBase64) {
  const https = require("https");
  const host = "ocr.tencentcloudapi.com", service = "ocr", action = "GeneralBasicOCR", version = "2018-11-19";
  const timestamp = Math.floor(Date.now() / 1000), date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({ ImageBase64: imgBase64, LanguageType: "zh" });
  const hashedPayload = crypto.createHash("sha256").update(payload).digest("hex");
  const canonicalHeaders = `content-type:application/json\nhost:${host}\n`, signedHeaders = "content-type;host";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = crypto.createHash("sha256").update(canonicalRequest).digest("hex");
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;
  const kDate = crypto.createHmac("sha256", `TC3${TC_SECRET_KEY}`).update(date).digest();
  const kService = crypto.createHmac("sha256", kDate).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("tc3_request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${TC_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Promise((resolve) => {
    const req = https.request({ hostname: host, path: "/", method: "POST",
      headers: { "Content-Type": "application/json", "Host": host, "X-TC-Action": action, "X-TC-Version": version, "X-TC-Timestamp": String(timestamp), "Authorization": authorization } },
    (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => {
      try { const j = JSON.parse(d); if (j.Response && j.Response.TextDetections) resolve(j.Response.TextDetections.map(t => t.DetectedText).join("\n")); else resolve(null); }
      catch (e) { resolve(null); }
    });});
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

const FUND_KW_RE = /混合|股票|债券|指数|ETF|联接|精选|优选|产业|制造|创新|成长|价值|蓝筹|配置|灵活|国防|军工|医疗|医药|科技|新能源|消费|资源|信息|高端|沪港深|环保|健康|文体|娱乐|安全|量化|策略|全球|海外|港股|LOF|QDII/;
const SKIP_RE = /^(?:持有|基金|代码|金额|收益|份额|净值|成本|买入|¥|累计|昨日|中高|详情|资产|日涨|待确认|讨论|理财|投资|收益明|交易记|业绩走|黄金|名称|全部|我的|截图|添加|金选|金送|偏股|偏债)/;

function parseTencentFormat(text) {
  const lines = text.split("\n").map(l => l.trim());
  const holdings = [];
  for (let i = 2; i < lines.length - 2; i++) {
    const name = lines[i];
    const isComplete = /(A|C|混合|股票|债券|ETF|LOF|联接)$/.test(name);
    if (isComplete && name.length >= 6 && !SKIP_RE.test(name)) {
      const amt = lines[i + 1], ret = lines[i + 2];
      const amtMatch = amt && amt.match(/^([\d,]+\.?\d{0,2})$/);
      const retMatch = ret && ret.match(/^([+-][\d,]+\.?\d{0,2})$/);
      if (amtMatch && parseFloat(amtMatch[1].replace(/,/g, "")) >= 100 && retMatch) {
        const suffix = lines[i + 3];
        const finalName = (suffix && /^[AC]$/.test(suffix)) ? name + suffix : name;
        holdings.push({ fundCode: undefined, fundName: finalName, marketValue: amtMatch[1].replace(/,/g, ""), holdingReturn: retMatch[1].replace(/,/g, "") });
        continue;
      }
    }
    const cur = lines[i];
    const isSuffix = (FUND_KW_RE.test(cur) && cur.length >= 2) || /^[一-鿿A-Za-z]{0,2}[AC]$/.test(cur);
    if (!isSuffix || /^[\d.,+\-%]+$/.test(cur)) continue;
    const hr = lines[i - 1], hrMatch = hr.match(/^([+-][\d,]+\.?\d{0,2})$/);
    if (!hrMatch) continue;
    const holdingReturn = hrMatch[1].replace(/,/g, "");
    const amt = lines[i - 2], amtMatch = amt.match(/^([\d,]+\.?\d{0,2})$/);
    if (!amtMatch || parseFloat(amtMatch[1].replace(/,/g, "")) < 100) continue;
    const amount = amtMatch[1].replace(/,/g, "");
    const prefix = lines[i - 3] || "";
    if (!/^[一-鿿A-Za-z（）()／&]{2,}$/.test(prefix) || SKIP_RE.test(prefix)) {
      if (FUND_KW_RE.test(prefix) && /^[AC]$/.test(cur)) {
        holdings.push({ fundCode: undefined, fundName: prefix + cur, marketValue: amount, holdingReturn });
      }
      continue;
    }
    holdings.push({ fundCode: undefined, fundName: prefix + cur, marketValue: amount, holdingReturn });
  }
  const seen = new Set();
  return holdings.filter(h => { if (seen.has(h.marketValue)) return false; seen.add(h.marketValue); return true; });
}

function parseGeneric(text) {
  text = text.replace(/(混合|股票|债券|指数|货币|联接|灵活)\n([AC])\b/g, "$1$2");
  const lines = text.split("\n").map(l => l.trim());
  const codeRe = /\b(\d{6})\b/g;
  const codes = []; let cm;
  while ((cm = codeRe.exec(text)) !== null) {
    if (parseInt(cm[1]) > 1000 && parseInt(cm[1]) < 600000) codes.push({ code: cm[1], index: cm.index });
  }
  const holdings = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i], next = lines[i + 1];
    const amtMatch = cur.match(/^([\d,]+\.?\d{0,2})$/);
    if (!amtMatch || parseFloat(amtMatch[1].replace(/,/g, "")) < 100) continue;
    if (!/^0\.?0*$/.test(next)) continue;
    const amount = amtMatch[1].replace(/,/g, "");
    let fundName = null;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const line = lines[j];
      if (!line || SKIP_RE.test(line) || /\d{6}/.test(line)) continue;
      if (FUND_KW_RE.test(line) && line.length >= 3 && !/^[\d.,+\-%]+$/.test(line)) {
        if (j > 0) {
          const prev = lines[j - 1];
          if (prev && /^[一-鿿A-Za-z（）()／]{2,}$/.test(prev) && !FUND_KW_RE.test(prev) && !SKIP_RE.test(prev) && !/\d/.test(prev)) {
            fundName = prev + line; break;
          }
        }
        fundName = line; break;
      }
    }
    if (!fundName) continue;
    let holdingReturn = null;
    for (let k = i + 2; k < Math.min(i + 6, lines.length); k++) {
      const m = lines[k].match(/^([+-][\d,]+\.?\d{0,2})/);
      if (m) { holdingReturn = m[1].replace(/,/g, ""); break; }
    }
    holdings.push({ fundCode: undefined, fundName, marketValue: amount, holdingReturn: holdingReturn || undefined });
    i += 4;
  }
  for (const h of holdings) {
    if (!h.fundCode) {
      for (const c of codes) {
        if (text.indexOf(c.code) >= Math.max(0, text.indexOf(h.fundName) - 100) && text.indexOf(c.code) < text.indexOf(h.fundName) + h.fundName.length + 200) {
          h.fundCode = c.code; break;
        }
      }
    }
  }
  const foundNames = new Set(holdings.map(h => h.fundName));
  for (let ci = 0; ci < codes.length; ci++) {
    const e = codes[ci], end = ci + 1 < codes.length ? codes[ci + 1].index : text.length;
    const win = text.substring(e.index, end), before = text.substring(Math.max(0, e.index - 80), e.index);
    const name = extractFundName(e.code, win, before);
    if (!name || foundNames.has(name)) continue;
    const mv = tryExtract(win, [/(?:持有金额|持仓金额|市值)[^\d]*[¥￥]?([\d,]+\.?\d{0,2})/]);
    const hr = tryExtract(win, [/(?:持有收益|累计收益|持仓收益)[^+\-\d]*([+-]?[\d,]+(?:\.\d{1,2})?)/]);
    holdings.push({ fundCode: e.code, fundName: name, marketValue: mv || undefined, holdingReturn: hr || undefined });
  }
  return holdings;
}

function tryExtract(text, regexes) { for (const re of regexes) { const m = text.match(re); if (m) return m[1].replace(/,/g, ""); } return null; }

function extractFundName(code, window, before) {
  const ci = window.indexOf(code);
  if (ci !== -1) {
    const ls = window.lastIndexOf("\n", ci), le = window.indexOf("\n", ci);
    const line = window.substring(ls + 1, le === -1 ? window.length : le);
    const bc = line.substring(0, line.indexOf(code)), m = bc.match(/[一-鿿A-Za-z（）()／]{3,}/);
    if (m) return m[0].trim();
    const ac = line.substring(line.indexOf(code) + 6), m2 = ac.match(/[一-鿿A-Za-z（）()／]{3,}/);
    if (m2) return m2[0].trim();
  }
  let t = before.replace(/\n$/, ""); const ln = t.lastIndexOf("\n");
  const pl = t.substring(ln + 1).trim();
  if (pl.length >= 3 && !SKIP_RE.test(pl)) return pl.replace(/^[#\s]+/, "").replace(/基金名称[:\s：]*/, "");
  return null;
}

async function lookupFundCodeWithDebug(name) {
  const kws = getKeywords(name);
  const result = { name, keywords: kws, attempts: [] };
  for (const kw of kws) {
    const ds = await searchFund(kw);
    if (!ds.length) { result.attempts.push({ kw, found: 0 }); continue; }
    result.attempts.push({ kw, found: ds.length, samples: ds.slice(0, 3).map(d => d.Name + '|' + d.Code) });
    const m = pickBest(name, ds);
    if (m) { result.code = m; result.matchedBy = kw; return result; }
  }
  return result;
}

function getKeywords(name) {
  const kws = [name];
  // 去括号
  let s = name.replace(/[（(][^）)]*[）)]/g, "").trim(); if (s !== name) kws.push(s);
  // 去类型后缀
  s = name.replace(/(?:混合|股票|债券|指数|联接|ETF联接|精选|优选|产业|制造|创新)[AC]?$/g, "").trim(); if (s !== name) kws.push(s);
  // 去A/C后缀
  s = name.replace(/[AC]$/, "").trim(); if (s !== name) kws.push(s);
  // 公司名(2-4字)+核心关键词
  const company = (name.match(/^[一-鿿]{2,4}/) || [])[0] || "";
  const kwMatch = name.match(/(?:ETF|联接|混合|股票|债券|指数|LOF|QDII|医药|军工|新能源|半导体|互联网|白酒|蓝筹|消费|科技|产业|信息|港股|全球)/g);
  if (company && kwMatch) {
    for (const kw of kwMatch) { s = company + kw; if (!kws.includes(s)) kws.push(s); }
  }
  // 公司名+ETF联接兜底
  if (company) { s = company + 'ETF联接'; if (!kws.includes(s)) kws.push(s); }
  return kws;
}

function searchFund(kw) {
  const https = require("https");
  return new Promise(r => {
    const req = https.get(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=DGCE23MHKBN23AKDN23&count=5`, res => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => {
        try { r((JSON.parse(b).QuotationCodeTable && JSON.parse(b).QuotationCodeTable.Data) || []); } catch (e) { r([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); r([]); }); req.on("error", () => r([]));
  });
}

function pickBest(ocrName, datas) {
  // 先过滤：基金名必须包含类型关键词（排除股票、公司名）
  const TYPE_KW = /混合|股票|债券|指数|ETF|联接|货币|FOF|LOF|QDII|债/;
  const fundDatas = datas.filter(d => TYPE_KW.test(d.Name || ""));
  if (fundDatas.length === 0) fundDatas.push(...datas);
  const sfx = (ocrName.endsWith("C") || ocrName.endsWith("A")) ? ocrName.slice(-1) : "";
  const clean = ocrName.replace(/[（(][^）)]*[）)]/g, "").replace(/[AC]$/, "").replace(/瑞信|瑞银/g, "");
  const matched = [];
  for (const d of fundDatas) {
    const apiClean = (d.Name || "").replace(/[（(][^）)]*[）)]/g, "").replace(/[AC]$/, "");
    let pos = 0, ok = true;
    for (const ch of apiClean) { pos = clean.indexOf(ch, pos); if (pos === -1) { ok = false; break; } pos++; }
    if (ok) matched.push({ code: d.Code, sameSuffix: sfx && (d.Name || "").slice(-1) === sfx });
  }
  if (!matched.length) {
    for (const d of datas) {
      const apiClean = (d.Name || "").replace(/[（(][^）)]*[）)]/g, "").replace(/[AC]$/, "");
      const s = new Set(clean); let c = 0;
      for (const ch of apiClean) { if (s.has(ch)) c++; }
      if (c / Math.max(clean.length, apiClean.length) > 0.7) return d.Code;
    }
    return null;
  }
  const p = matched.find(m => m.sameSuffix);
  return p ? p.code : matched[0].code;
}

async function crossValidate(hs) {
  for (const h of hs) {
    if (h.fundCode && h.marketValue) {
      try {
        const nav = await fetchNAV(h.fundCode);
        if (nav > 0) h._estShares = +(parseFloat(h.marketValue) / nav).toFixed(2);
      } catch (e) {}
    }
  }
}

function fetchNAV(code) {
  const https = require("https");
  return new Promise(r => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${code}.js`, res => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => {
        try { r(parseFloat(JSON.parse(b.replace(/^jsonpgz\(/, "").replace(/\);?$/, "")).gsz) || 0); } catch (e) { r(0); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); r(0); }); req.on("error", () => r(0));
  });
}
