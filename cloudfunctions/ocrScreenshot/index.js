const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

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

// ========== 解析器 ==========
// 名称驱动解析：先识别所有基金名称（不依赖 OCR 读取顺序），
// 再以名称为边界在每只基金的区块内找市值和持有收益

const UI_CHROME_RE = /^(?:名称|代码|金额|收益|份额|净值|成本|持有|基金|买入|¥|累计|昨日|详情|资产|日涨|待确认|讨论|理财|投资|收益明|交易记|业绩走|黄金|全部|我的|截图|添加|偏股|偏债|实时|更新|成立|日涨跌|七日年化|万份收益|基金吧|在售|热销|推荐|持有金额|持有收益|累计收益|昨日收益|金额[/·]|持有收益排序|持有收益率排序|搜索|客服|定投|转换|卖出|买入|赎回|分红|公告|评级|基金经理|规模|成立日|跟踪标的|运作费|托管费|管理费)/;
const TAG_RE = /^(?:金选|金送|指数基金|超额收益|明星基金|爆款|热门|新发|定投首选|金牛|晨星)/;
const FUND_KW_RE = /混合|股票|指数|债券|货币|ETF|LOF|QDII|FOF|联接/;
const STANDALONE_RE = /^(?:偏股|偏债|指数|黄金|全部|混合|股票|债券|货币|名称|基金|持有|我的|截图添加持仓|我的持有|持有收益排序|吕|AI|全球|基金市场|机会|自选)$/;

function parseText(text) {
  const rawLines = text.split("\n").map(l => l.trim()).filter(l => l);
  const lines = [];
  for (const line of rawLines) {
    if (/^[+-]?\d+\.?\d*%$/.test(line)) continue;
    if (/^\d{1,2}:\d{2}/.test(line) && line.length <= 8) continue;
    if (/^[•◎©xX]{1,3}$/.test(line)) continue;
    if (/^[<>←↑↓→⑧⑦⑥⑤④③②①⓪]$/.test(line)) continue;
    if (/^\.{2,}$/.test(line)) continue;
    if (/^\d{1,3}$/.test(line)) continue;
    lines.push(line);
  }

  // 策略1：名称驱动解析（适配大多数格式）
  let result = parseNameFirst(lines);
  if (result.length > 0) return result;
  // 策略2：4 行模式解析（适配百度 OCR 名称被数字隔开的格式）
  result = parsePatternFirst(lines);
  if (result.length > 0) return result;
  // 策略3：传统关键词兜底
  return parseLegacy(lines);
}

// ========== 名称驱动解析 ==========

function parseNameFirst(lines) {
  const nameEntries = findAllFundNames(lines);
  if (nameEntries.length === 0) return [];

  const holdings = [];
  for (let idx = 0; idx < nameEntries.length; idx++) {
    const { name, endLine } = nameEntries[idx];
    const blockEnd = idx + 1 < nameEntries.length ? nameEntries[idx + 1].startLine : lines.length;

    let mv = null, hr = null;
    for (let j = endLine + 1; j < blockEnd; j++) {
      const line = lines[j];
      if (UI_CHROME_RE.test(line) || TAG_RE.test(line) || STANDALONE_RE.test(line)) continue;

      if (!mv) {
        const m = parsePositiveAmount(line);
        if (m && parseFloat(m) >= 10) { mv = m; continue; }
      }
      if (mv) {
        const s = parseSignedAmount(line);
        if (s) {
          if (!hr || Math.abs(parseFloat(s)) > Math.abs(parseFloat(hr))) hr = s;
        }
      }
    }

    if (mv) {
      holdings.push({
        fundCode: undefined,
        fundName: name,
        marketValue: mv,
        holdingReturn: hr || undefined
      });
    }
  }

  // 去重
  const seen = new Set();
  return holdings.filter(h => { const k = h.fundName + h.marketValue; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ========== 4 行模式解析（百度 OCR 名称被数字隔开时兜底） ==========

function parsePatternFirst(lines) {
  const holdings = [];
  for (let i = 0; i < lines.length - 3; i++) {
    const name1 = lines[i];
    if (!name1 || name1.length < 3 || name1.length > 20) continue;
    if (!/^[一-鿿]{3,}$/.test(name1)) continue;
    if (isNoise(name1)) continue;

    const mv = parsePositiveAmount(lines[i + 1]);
    if (!mv || parseFloat(mv) < 1) continue;

    const hr = parseSignedAmount(lines[i + 2]);
    if (!hr) continue;

    const name2 = lines[i + 3];
    if (!isSuffixOnly(name2)) continue;

    const name = name1 + name2;
    if (holdings.some(h => h.fundName === name && h.marketValue === mv)) continue;

    holdings.push({ fundCode: undefined, fundName: name, marketValue: mv, holdingReturn: hr });
  }
  return holdings;
}

function findAllFundNames(lines) {
  const names = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isNoise(line)) { i++; continue; }

    // 判断是否为名称前缀或完整名称
    const isPrefix = /^[一-鿿]{3,}$/.test(line) && line.length <= 20;
    const chineseCount = (line.match(/[一-鿿]/g) || []).length;
    const hasFundKW = FUND_KW_RE.test(line);
    const isComplete = line.length >= 5 && line.length <= 30 && chineseCount >= 6 && hasFundKW;

    if (!isPrefix && !isComplete) { i++; continue; }

    // 向后找后缀（最多 5 行，可跨越 MV/HR 等数字行）
    // 适配百度 OCR 中"名称 → 市值 → 持有收益 → 后缀"的格式
    var suffixIdx = -1;
    for (var s = 1; s <= 5 && i + s < lines.length; s++) {
      var next = lines[i + s];
      if (isNoise(next) && !/^[AC]$/.test(next)) continue;
      if (isSuffixOnly(next)) {
        // 验证中间有数字（确保后缀属于这只基金）
        var between = lines.slice(i + 1, i + s);
        var hasNum = false;
        for (var b = 0; b < between.length; b++) {
          if (parsePositiveAmount(between[b]) || parseSignedAmount(between[b]) || /^0\.00$/.test(between[b])) {
            hasNum = true; break;
          }
        }
        if (hasNum || s === 1) { suffixIdx = s; break; }
      }
      // 遇到非数字非后缀的文本就停止
      if (!parsePositiveAmount(next) && !parseSignedAmount(next) && !/^0\.00$/.test(next)) break;
    }

    if (suffixIdx > 0) {
      names.push({ name: line + lines[i + suffixIdx], startLine: i, endLine: i });
      i++;
    } else if (isComplete) {
      names.push({ name: line, startLine: i, endLine: i });
    }
    i++;
  }

  return names;
}

function isSuffixOnly(line) {
  if (!line || line.length > 20) return false;
  // 单独的 A / C 后缀
  if (/^[AC]$/.test(line)) return true;
  // 短中文 + [AC]（如 OCR 截断的"数C" = "指数C"的尾部）
  if (/^[一-鿿]{1,2}[AC]$/.test(line)) return true;
  // 含基金类型关键词但中文字符<5（非完整名称，如"消费ETF联接C"）
  var ch = (line.match(/[一-鿿]/g) || []).length;
  if (ch < 7 && /ETF|LOF|QDII|FOF|联接|股票|混合|指数|债券|货币/.test(line)) return true;
  return false;
}

function isNoise(line) {
  if (!line) return true;
  if (TAG_RE.test(line)) return true;
  if (UI_CHROME_RE.test(line)) return true;
  if (STANDALONE_RE.test(line)) return true;
  if (parsePositiveAmount(line)) return true;
  if (parseSignedAmount(line)) return true;
  return false;
}

function parsePositiveAmount(line) {
  const m = line.match(/^[¥￥]?([\d,]+\.?\d{0,2})\.?$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  if (v < 0.01 || v > 1e10) return null;
  return m[1].replace(/,/g, "");
}

function parseSignedAmount(line) {
  const m = line.match(/^([+-][\d,]+\.?\d{0,2})\.?$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  if (Math.abs(v) < 0.01 || Math.abs(v) > 1e10) return null;
  return m[1].replace(/,/g, "");
}

// ========== 传统关键词驱动解析（兜底） ==========

const LEGACY_FUND_KW = /混合|股票|债券|指数|ETF|联接|LOF|QDII|FOF|货币|增强|稳健|成长|价值|蓝筹|灵活|驱动|领先|优势|质量|红利|量化|策略|全球|海外|港股|消费|医疗|医药|科技|新能源|制造|创新|国防|军工|资源|信息|高端|沪港深|环保|健康|文体|娱乐|安全|主题|龙头|机遇|周期|改革|升级|新经济|新动力|新机遇|新蓝筹|产业|精选|优选|配置|动力/;
const LEGACY_FULL_RE = new RegExp("^(?:[一-鿿A-Za-z（）()／&·\\s]{3,}(?:" + LEGACY_FUND_KW.source + ")[AC]?[A-Z]?)$");

function parseLegacy(lines) {
  const holdings = [];
  const SKIP_RE = /^(?:持有|基金|代码|金额|收益|份额|净值|成本|买入|¥|累计|昨日|中高|详情|资产|日涨|待确认|讨论|理财|投资|收益明|交易记|业绩走|黄金|名称|全部|我的|截图|添加|金选|金送|偏股|偏债|实时|更新|成立|日涨跌|七日年化|万份收益|基金吧|在售|热销|推荐)/;

  // 策略1：基金名 + 持有金额 xxx + 持有收益 xxx
  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i];
    if (!name || SKIP_RE.test(name) || /\d{4,}/.test(name) || name.length > 40) continue;
    const isFund = LEGACY_FULL_RE.test(name) || LEGACY_FUND_KW.test(name);
    if (!isFund || /^[\d.,+\-% ¥]+$/.test(name)) continue;
    const next1 = lines[i + 1] || "", next2 = lines[i + 2] || "";
    const amtMatch = next1.match(/(?:持有金额|金额|市值)?\s*[¥￥]?([\d,]+\.?\d{0,2})/);
    const retMatch = next2.match(/(?:持有收益|收益|累计收益)?\s*([+-][\d,]+\.?\d{0,2})/) ||
                     next1.match(/(?:持有收益|收益)\s*([+-][\d,]+\.?\d{0,2})/);
    if (amtMatch) {
      const amount = amtMatch[1].replace(/,/g, "");
      if (parseFloat(amount) >= 100) {
        const hr = retMatch ? retMatch[1].replace(/,/g, "") : null;
        holdings.push({ fundCode: undefined, fundName: name, marketValue: amount, holdingReturn: hr || undefined });
        i += 2;
      }
    }
  }

  if (holdings.length > 0) {
    const seen = new Set();
    return holdings.filter(h => { const k = h.marketValue; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // 策略2：完整基金名称行 + 后续数字
  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i];
    if (!name || SKIP_RE.test(name)) continue;
    if (!LEGACY_FULL_RE.test(name)) continue;
    let amount = null, holdingReturn = null;
    for (let j = 1; j <= 4 && i + j < lines.length; j++) {
      const line = lines[i + j];
      if (!line || SKIP_RE.test(line) || line.length > 30) continue;
      if (!amount) {
        const m = line.match(/^[\d,]+\.?\d{0,2}$/);
        if (m && parseFloat(m[0].replace(/,/g, "")) >= 100) { amount = m[0].replace(/,/g, ""); continue; }
      }
      if (amount) {
        const m = line.match(/^[+-][\d,]+\.?\d{0,2}$/);
        if (m) { holdingReturn = m[0].replace(/,/g, ""); break; }
      }
    }
    if (amount) {
      holdings.push({ fundCode: undefined, fundName: name, marketValue: amount, holdingReturn: holdingReturn || undefined });
      i += 2;
    }
  }

  // 策略3：拆分名称格式
  if (holdings.length === 0) {
    for (let i = 2; i < lines.length - 2; i++) {
      const cur = lines[i];
      if (SKIP_RE.test(cur)) continue;
      const isSuffix = (LEGACY_FUND_KW.test(cur) && cur.length >= 2) || /^[一-鿿A-Za-z]{0,2}[AC]$/.test(cur);
      if (!isSuffix || /^[\d.,+\-%]+$/.test(cur)) continue;
      const hr = lines[i - 1], hrMatch = hr ? hr.match(/^([+-][\d,]+\.?\d{0,2})$/) : null;
      if (!hrMatch) continue;
      const amt = lines[i - 2], amtMatch = amt ? amt.match(/^([\d,]+\.?\d{0,2})$/) : null;
      if (!amtMatch || parseFloat(amtMatch[1].replace(/,/g, "")) < 100) continue;
      const prefix = lines[i - 3] || "";
      let fundName = cur;
      if (/^[一-鿿A-Za-z（）()／&]{2,}$/.test(prefix) && !SKIP_RE.test(prefix)) fundName = prefix + cur;
      else if (LEGACY_FUND_KW.test(prefix) && /^[AC]$/.test(cur)) fundName = prefix + cur;
      holdings.push({ fundCode: undefined, fundName, marketValue: amtMatch[1].replace(/,/g, ""), holdingReturn: hrMatch[1].replace(/,/g, "") });
    }
  }

  const seen = new Set();
  return holdings.filter(h => { const k = h.marketValue; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ========== OCR 引擎 ==========

async function doWechatOCR(fileID) {
  try {
    // 先获取临时 URL，再传给微信 OCR（部分环境下 cloud fileID 不被识别）
    const urlRes = await cloud.getTempFileURL({ fileList: [fileID] });
    const imgUrl = (urlRes.fileList && urlRes.fileList[0]) ? urlRes.fileList[0].tempFileURL : fileID;
    console.log("[ocrScreenshot] wechat ocr imgUrl:", imgUrl ? imgUrl.substring(0, 80) : "none");
    const r = await cloud.openapi.ocr.printedText({ imgUrl, type: "photo" });
    console.log("[ocrScreenshot] wechat ocr items:", r.items ? r.items.length : 0);
    if (r.items && r.items.length) return r.items.map(i => i.text).join("\n");
  } catch (e) {
    console.error("[ocrScreenshot] wechat ocr error:", e.message || e);
  }
  return null;
}

async function doOcrspaceOCR(fileID) {
  if (!OCRSPACE_API_KEY) {
    console.log("[ocrScreenshot] ocrspace skipped: no API key");
    return null;
  }
  try {
    const urlRes = await cloud.getTempFileURL({ fileList: [fileID] });
    const imgUrl = (urlRes.fileList && urlRes.fileList[0]) ? urlRes.fileList[0].tempFileURL : null;
    if (!imgUrl) return null;
    console.log("[ocrScreenshot] ocrspace downloading image...");
    const https = require("https"), http = require("http");
    const imgBuffer = await new Promise((resolve) => {
      const mod = imgUrl.startsWith("https") ? https : http;
      const chunks = [];
      mod.get(imgUrl, (res) => { res.setEncoding("utf8"); res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks))); }).on("error", () => resolve(null));
    });
    if (!imgBuffer) {
      console.log("[ocrScreenshot] ocrspace download failed");
      return null;
    }
    console.log("[ocrScreenshot] ocrspace image size:", imgBuffer.length, "bytes");
    // 用 multipart/form-data 上传（JSON base64 已被 OCR.space 拒绝）
    const boundary = "----OCRSPACE" + Date.now();
    const CRLF = "\r\n";
    const parts = [
      CRLF + "--" + boundary + CRLF + 'Content-Disposition: form-data; name="apikey"' + CRLF + CRLF + OCRSPACE_API_KEY,
      CRLF + "--" + boundary + CRLF + 'Content-Disposition: form-data; name="language"' + CRLF + CRLF + "chs",
      CRLF + "--" + boundary + CRLF + 'Content-Disposition: form-data; name="isOverlayRequired"' + CRLF + CRLF + "false",
      CRLF + "--" + boundary + CRLF + 'Content-Disposition: form-data; name="OCREngine"' + CRLF + CRLF + "2",
      CRLF + "--" + boundary + CRLF + 'Content-Disposition: form-data; name="file"; filename="screenshot.jpg"' + CRLF + "Content-Type: image/jpeg" + CRLF + CRLF,
    ];
    const body = Buffer.concat([
      Buffer.from(parts.join("")),
      imgBuffer,
      Buffer.from(CRLF + "--" + boundary + "--" + CRLF),
    ]);
    console.log("[ocrScreenshot] ocrspace post size:", body.length, "bytes");
    const respBody = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.ocr.space",
        path: "/parse/image",
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length },
      }, (res) => { res.setEncoding("utf8");
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => resolve(d));
      });
      req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", e => reject(e));
      req.write(body);
      req.end();
    });
    console.log("[ocrScreenshot] ocrspace response:", respBody.substring(0, 400));
    const json = JSON.parse(respBody);
    if (json.ErrorMessage && json.ErrorMessage.length > 0) {
      console.log("[ocrScreenshot] ocrspace error:", json.ErrorMessage);
    }
    console.log("[ocrScreenshot] ocrspace ParsedResults:", json.ParsedResults ? json.ParsedResults.length : 0, "OCRExitCode:", json.OCRExitCode);
    const results = (json.ParsedResults || []);
    if (results.length > 0 && results[0].ParsedText) {
      const text = results[0].ParsedText;
      console.log("[ocrScreenshot] ocrspace text length:", text.length, "preview:", text.substring(0, 120));
      return text;
    }
    console.log("[ocrScreenshot] ocrspace no results");
  } catch (e) {
    console.error("[ocrScreenshot] ocrspace error:", e.message || e);
  }
  return null;
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
      mod.get(url, (res) => { res.setEncoding("utf8"); res.on("data", c => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks).toString("base64"))); }).on("error", () => resolve(null));
    });
    if (!imgBase64) return { text: null, words: null, err: "download fail" };
    const tokenRes = await new Promise((resolve) => {
      https.get(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_API_KEY}&client_secret=${BAIDU_SECRET_KEY}`, (res) => { res.setEncoding("utf8");
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d).access_token); } catch (e) { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    if (!tokenRes) return { text: null, words: null, err: "token fail" };
    const body = `image=${encodeURIComponent(imgBase64)}&language_type=CHN_ENG`;
    // accurate 接口返回每个词的坐标 location，供布局解析器使用
    const json = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "aip.baidubce.com", path: `/rest/2.0/ocr/v1/accurate?access_token=${tokenRes}`,
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }, (res) => { res.setEncoding("utf8"); let d = ""; res.on("data", c => d += c); res.on("end", () => { try { const j = JSON.parse(d); if (j.error_msg) reject(new Error(j.error_msg)); else resolve(j); } catch (e) { reject(e); } }); });
      req.write(body); req.end();
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", (e) => reject(e));
    });
    const words = json.words_result || [];
    const text = words.map(w => w.words).join("\n");
    return { text, words, err: null };
  } catch (e) {
    return { text: null, words: null, err: e.message };
  }
}

// ========== 坐标布局解析器（支付宝等主流截图：列表/详情/流水三格式） ==========

const LAYOUT_UI_WORDS = /^(买入|卖出|赎回|基金|持有|代码|金额|收益|份额|净值|成本|我的|全部|自选|黄金|详情|名称|资产|截图|添加|更多|产品|去市场|客服|转换|定投|讨论|理财师|投资指南|投资计划|收益明细|交易记录|累计盈亏|业绩走势|返回|清仓|分析|复盘|历史|持仓|现金|红利|再投资|待确认|中高|风险|昨日|日涨幅|基金净值|持仓成本价|持有份额|持有金额|持有收益|累计收益|收益率|日涨|市场|解读|公司|电台|基金市场|机会|看|偏股|偏债|指数|全部持有|明细|搜索|持有收益率|金额\/昨日|单位|资产详情)$/;
const LAYOUT_FUND_KW = /混合|股票|指数|债券|货币|ETF|LOF|QDII|FOF|联接|稳健|优选|精选|灵活|配置|成长|价值|蓝筹|红利|医疗|医药|消费|科技|资源|创新|前沿|多元|策略|增强|驱动|领航|纳斯达克|标普|恒生|全球|海外|黄金/;
const LAYOUT_MONEY_RE = /^[¥￥]?([\d,]+)(\.\d{1,2})?$/;
const LAYOUT_SIGNED_RE = /^[+-][\d,]+\.?\d{0,2}$/;
const LAYOUT_DATE_RE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/;

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
  // 跨行续名词："C" / "合C" / "票A" / "配置混合C" / "成长混合C"
  return /^[一-鿿]{0,3}[ABC]$/.test(t) || /^[一-鿿（）()A-Za-z]{1,8}?(?:混合|股票|指数|债券|联接|ETF|LOF|货币|稳健)[AC]?$/.test(t);
}

// 持仓列表页：主行 = 名称开头 + 行内金额；名称截断时拼下一行首词
// 通用化：市值是"名称后第一个 非6位代码 的金额"；6位纯数字视为基金代码而非市值；
//        行内无市值时向下跨行找"资产/金额"标签后的数值；不绑定平台布局。
function layoutParseList(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const toks = r.toks;
    if (toks.length < 2) continue;
    const j0 = toks.findIndex((t) => layoutMoney(t.text) === null && layoutSigned(t.text) === null && !layoutIsCode6(t.text));
    if (j0 < 0 || !layoutIsNameish(toks[j0].text)) continue;

    // 名称边界：从 j0 到第一个 6位代码 或 金额 为止（名称后可能紧跟代码，如天天）
    let nEnd = toks.length;
    for (let k = j0; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text) || layoutMoney(toks[k].text) !== null || layoutSigned(toks[k].text) !== null) { nEnd = k; break; }
    }
    let name = toks.slice(j0, nEnd).map((t) => t.text).join("");

    // 找持有收益（layoutSigned 带符号值，如 +120.50 / -15.00）——先独立扫整行
    let hr = "";
    for (let k = j0 + 1; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text)) continue;
      const s = layoutSigned(toks[k].text);
      if (s !== null && s !== undefined) { hr = toks[k].text; break; }
    }
    // 找市值：名称后第一个 非6位代码 的 >=10 金额（6位纯数字是代码，不是市值）
    let mv = null, mi = -1;
    for (let k = j0 + 1; k < toks.length; k++) {
      if (layoutIsCode6(toks[k].text)) continue;
      const v = layoutMoney(toks[k].text);
      if (v !== null && v >= 10) { mv = v; mi = k; break; }
    }
    // 跨行兜底：行内无市值（或名称后只有代码）→ 向下找"资产/金额"标签行下的数值
    if (mv === null) {
      const fb = findAssetBelow(rows, i, r);
      if (fb) { mv = fb.value; mi = -1; }
    }
    if (mv === null) continue;

    // 名称结尾不完整 → 拼下一行首词
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

// 向下跨行找资产标签行的数值：找到含"资产/金额/持有金额/市值"标签的行，取它下方最近一行的数值（跳过6位代码）
function findAssetBelow(rows, i, r) {
  for (let j = i + 1; j < rows.length && j < i + 4; j++) {
    const rr = rows[j];
    if (rr.y - r.y > 220) break;
    if (/资产|金额|持有金额|市值|持有市值/.test(rr.text)) {
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

// 单基金详情页：名称 + 代码 + "金额（元）/持有收益（元）" 标签-数值配对
function layoutParseDetail(rows) {
  let nameRow = null;
  for (const r of rows) {
    const t = r.text.trim();
    if (t.length >= 6 && t.length <= 24 && LAYOUT_FUND_KW.test(t) && !LAYOUT_UI_WORDS.test(t.split(" ")[0])) { nameRow = r; break; }
  }
  if (!nameRow) return [];
  let fundCode = "", marketValue = "", holdingReturn = "";
  for (const r of rows) {
    if (r.y <= nameRow.y || r.y - nameRow.y > 300) continue;
    const m = r.text.match(/(^|\s)(\d{6})(\s|$)/);
    if (m) { fundCode = m[2]; break; }
  }
  const center = (t) => t.x + t.w / 2;
  for (const r of rows) {
    const tagTok = r.toks.find((t) => /金额/.test(t.text) && /元/.test(t.text));
    if (!tagTok) continue;
    let best = null, bestDy = 1e9;
    for (const r2 of rows) {
      const dy = r2.y - tagTok.y;
      if (dy < 30 || dy > 400) continue;
      for (const t of r2.toks) {
        const v = layoutMoney(t.text);
        if (v !== null && v >= 100 && !layoutIsCode6(t.text) && dy < bestDy) { bestDy = dy; best = v; }
      }
    }
    if (best !== null) marketValue = String(best);
    break;
  }
  for (const r of rows) {
    const tagTok = r.toks.find((t) => /持有收益/.test(t.text) && /元/.test(t.text));
    if (!tagTok) continue;
    let bestTok = null, bestD = 1e9;
    for (const r2 of rows) {
      const dy = r2.y - tagTok.y;
      if (dy < 30 || dy > 400) continue;
      for (const t of r2.toks) {
        const v = layoutSigned(t.text);
        if (v === null) continue;
        const d = Math.abs(center(t) - center(tagTok));
        if (d < bestD) { bestD = d; bestTok = t; }
      }
    }
    if (bestTok) holdingReturn = bestTok.text.replace(/,/g, "");
    break;
  }
  return [{ fundName: nameRow.text.trim(), fundCode, marketValue, holdingReturn }];
}

// 布局解析统一入口：返回 { type: "list"|"detail"|"tx"|"other", holdings }
function layoutParseWords(words) {
  const rows = layoutRows(words);
  const has = (re) => rows.some((r) => re.test(r.text));
  if (has(/(买入|卖出|赎回)\s*(基金)?\s*[|｜]/) || has(/基金[|｜]/)) return { type: "tx", holdings: [] }; // 流水页（持仓导入场景无输出，由买卖记录入口处理）
  if (has(/金额（元）|昨日收益（元）|资产详情|持仓成本价/)) return { type: "detail", holdings: layoutParseDetail(rows) };
  const holdings = layoutParseList(rows);
  // 页面级信号：非持仓页（首页宫格/工具页）偶现"名称+数字"行，要求页面含持仓上下文才认定是持仓列表
  if (holdings.length > 0 && !has(/持有|持仓|市值|我的资产|资产总额|累计收益|昨日收益/)) return { type: "other", holdings: [] };
  return { type: holdings.length ? "list" : "other", holdings };
}

// ========== 主入口 ==========

// 文本兜底：微信 + OCR.space 并发，谁先返回用谁；再走正则解析（仅在百度识别不可用时）
async function runTextFallback(fileID) {
  const debug = {};
  const results = await Promise.all([
    doWechatOCR(fileID).then(r => { debug.wx = { ok: !!r, len: r ? r.length : 0 }; return { t: r, m: "wechat" }; }),
    doOcrspaceOCR(fileID).then(r => { debug.ocrspace = { ok: !!r, len: r ? r.length : 0 }; return { t: r, m: "ocrspace" }; }),
  ]);
  let text = null, method = "none";
  for (const r of results) {
    if (r.t && r.t.length > 10) { text = r.t; method = r.m; break; }
  }
  if (!text) return { code: 500, msg: "OCR识别失败", debug };
  console.log("[ocrScreenshot] fallback raw text (" + text.length + " chars):", text.slice(0, 300));
  const holdings = parseText(text);
  await enrichCodes(holdings);
  debug.holdings = holdings.length;
  return { code: 0, data: { raw: text, method, holdings, debug } };
}

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };
  const t0 = Date.now();

  // 主链路：百度 OCR（带词坐标）→ 布局解析
  const baidu = await doBaiduOCR(fileID);
  if (baidu.words && baidu.words.length >= 3) {
    const layout = layoutParseWords(baidu.words);
    console.log("[ocrScreenshot] layout type:", layout.type, "holdings:", layout.holdings.length, "ms:", Date.now() - t0);
    if (layout.type === "tx") {
      // 交易流水页：持仓导入场景无输出（由加减仓入口识别）
      return { code: 0, data: { raw: baidu.text, method: "baidu-layout", type: "tx", holdings: [], debug: { baidu: { ok: true } } } };
    }
    if (layout.holdings.length > 0) {
      await enrichCodes(layout.holdings);
      return {
        code: 0,
        data: { raw: baidu.text, method: "baidu-layout", type: layout.type, holdings: layout.holdings, debug: { baidu: { ok: true, ms: Date.now() - t0 } } },
      };
    }
    // 布局解析不出（无持仓页/未适配格式）→ 尝试文本兜底
    const fb = await runTextFallback(fileID);
    if (fb.code === 0) return fb;
  }

  // 百度不可用 → 文本兜底
  return runTextFallback(fileID);
};

async function enrichCodes(holdings) {
  const toSearch = holdings.filter((h) => !h.fundCode && h.fundName);
  if (toSearch.length === 0) return;
  const https = require("https");
  // 并发搜索（每只内部关键词降级串行，基金之间无依赖）
  await Promise.all(toSearch.map(async (h) => {
    try {
      const code = await searchFundCode(https, h.fundName);
      // 只接受 6 位数字代码，防搜索兜底写入假代码
      if (code && /^\d{6}$/.test(code)) h.fundCode = code;
    } catch (e) {
      // 搜索失败不阻塞
    }
  }));
}

function searchFundCode(https, name) {
  // 尝试不同长度的关键词
  const keywords = [name];
  // 去后缀：ETF联接C / 股票C / 指数C / 混合A 等
  const short = name.replace(/(?:ETF|LOF|QDII|FOF)?\s*联接\s*(?:\(QDII\))?\s*[AC]?\s*$/, "")
    .replace(/(?:混合|股票|指数|债券|货币)\s*[AC]\s*$/, "")
    .replace(/(?:混合|股票|指数|债券|货币)\s*$/, "").trim();
  if (short && short !== name && short.length >= 3) keywords.push(short);
  // 逐字缩短：广发创新药产业 → 广发创新药 → 广发创新
  if (short && short.length > 4) {
    for (let len = short.length - 1; len >= 4; len--) {
      keywords.push(short.slice(0, len));
    }
  }

  return tryKeywords(https, keywords, 0);
}

function tryKeywords(https, keywords, idx) {
  if (idx >= keywords.length) return null;
  const kw = keywords[idx];
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=DGCE23MHKBN23AKDN23&count=5`;

  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => { res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const datas = (json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];
          if (datas.length > 0) {
            // 优先精确匹配名称
            const clean = (s) => (s || "").replace(/\s/g, "").replace(/[（）()]/g, "");
            const ck = clean(kw);
            let best = datas.find((d) => clean(d.Name) === ck);
            if (!best) best = datas.find((d) => clean(d.Name).includes(ck) || ck.includes(clean(d.Name)));
            if (!best && ck.length >= 6) {
              const prefix = ck.slice(0, 6);
              best = datas.find((d) => clean(d.Name).startsWith(prefix));
            }
            if (!best) best = datas[0];
            resolve(best ? best.Code : null);
          } else {
            // 当前关键词没结果，试下一个
            resolve(tryKeywords(https, keywords, idx + 1));
          }
        } catch (e) {
          resolve(tryKeywords(https, keywords, idx + 1));
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(tryKeywords(https, keywords, idx + 1)); });
    req.on("error", () => resolve(tryKeywords(https, keywords, idx + 1)));
  });
}
