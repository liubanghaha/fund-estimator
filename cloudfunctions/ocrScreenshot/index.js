const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const BAIDU_API_KEY = "G5gi89TGUmVjNYRFdfQIri43";
const BAIDU_SECRET_KEY = "jaWrRLTqCv1UMALH8sRPJLk8pdUAVBpf";

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
    const r = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" });
    if (r.items && r.items.length) return r.items.map(i => i.text).join("\n");
  } catch (e) {}
  return null;
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
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d).access_token); } catch (e) { resolve(null); } });
      }).on("error", () => resolve(null));
    });
    if (!tokenRes) return { text: null, err: "token fail" };
    const body = `image=${encodeURIComponent(imgBase64)}&language_type=CHN_ENG`;
    const text = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "aip.baidubce.com", path: `/rest/2.0/ocr/v1/accurate_basic?access_token=${tokenRes}`,
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { const j = JSON.parse(d); if (j.error_msg) reject(new Error(j.error_msg)); else resolve((j.words_result || []).map(w => w.words).join("\n")); } catch (e) { reject(e); } }); });
      req.write(body); req.end();
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", (e) => reject(e));
    });
    return { text, err: null };
  } catch (e) {
    return { text: null, err: e.message };
  }
}

// ========== 主入口 ==========

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  const debug = {};
  let text = null, method = "none";

  // 1. 百度 OCR
  const baidu = await doBaiduOCR(fileID);
  debug.baidu = { ok: !!baidu.text, err: baidu.err, len: baidu.text ? baidu.text.length : 0 };
  if (baidu.text && baidu.text.length > 10) { text = baidu.text; method = "baidu"; }

  // 2. 微信兜底
  if (!text) {
    const wxText = await doWechatOCR(fileID);
    debug.wx = { ok: !!wxText, len: wxText ? wxText.length : 0 };
    if (wxText && wxText.length > 10) { text = wxText; method = "wechat"; }
  }

  if (!text) return { code: 500, msg: "OCR识别失败", debug };

  console.log("[ocrScreenshot] raw text (" + text.length + " chars):", text.slice(0, 800));
  const holdings = parseText(text);
  console.log("[ocrScreenshot] parsed holdings:", holdings.length);
  // 自动按名称匹配基金代码
  await enrichCodes(holdings);
  debug.holdings = holdings.length;
  return { code: 0, data: { raw: text, method, holdings, debug } };
};

async function enrichCodes(holdings) {
  const toSearch = holdings.filter((h) => !h.fundCode && h.fundName);
  if (toSearch.length === 0) return;
  const https = require("https");
  for (const h of toSearch) {
    try {
      const code = await searchFundCode(https, h.fundName);
      if (code) h.fundCode = code;
    } catch (e) {
      // 搜索失败不阻塞
    }
  }
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
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
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
