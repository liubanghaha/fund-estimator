const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  let text = "";
  let method = "";
  let errLog = [];

  try {
    const ocrRes = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" });
    if (ocrRes.items && ocrRes.items.length > 0) {
      text = ocrRes.items.map((item) => item.text).join("\n");
      method = "wechat_ocr";
    } else {
      errLog.push("wechat_ocr: items为空");
    }
  } catch (e) {
    errLog.push("wechat_ocr异常: " + e.message);
    console.log("微信OCR不可用:", e.message);
  }

  if (!text) {
    try {
      const tempRes = await cloud.getTempFileURL({ fileList: [fileID] });
      const tempUrl = tempRes.fileList[0] && tempRes.fileList[0].tempFileURL;
      if (tempUrl) {
        text = await ocrSpace(tempUrl);
        method = "ocrspace";
        if (!text) errLog.push("ocrspace: 返回空文本");
      } else {
        errLog.push("getTempFileURL: 未获取到临时链接");
      }
    } catch (e) {
      errLog.push("ocrspace异常: " + e.message);
      console.log("OCR.space不可用:", e.message);
    }
  }

  if (!text) {
    return { code: 500, msg: "OCR识别失败，请对照截图手动输入", debug: errLog };
  }

  const holdings = parseFundInfo(text);

  // 为缺失代码的基金搜索代码
  const lookupDebug = [];
  for (const h of holdings) {
    if (!h.fundCode && h.fundName) {
      const result = await lookupFundCodeWithDebug(h.fundName);
      h.fundCode = result.code;
      lookupDebug.push({ name: h.fundName, code: result.code, ...result.debug });
    }
  }

  if (holdings.length === 0) {
    return { code: 0, data: { raw: text, method }, msg: "未能识别出基金信息" };
  }

  return { code: 0, data: { raw: text, method, holdings, lookupDebug } };
};

// ========== OCR.space 兜底 ==========

function ocrSpace(imageUrl) {
  const http = require("http");
  const https = require("https");
  const querystring = require("querystring");
  const body = querystring.stringify({
    url: imageUrl, language: "chs", isOverlayRequired: "false",
    detectOrientation: "true", OCREngine: "2",
  });

  const doRequest = (mod) => new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: "api.ocr.space", path: "/parse/image", method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apikey: "helloworld",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.ErrorMessage) console.log("OCR.space错误:", json.ErrorMessage);
          const parsed = json.ParsedResults || [];
          if (parsed.length > 0 && parsed[0].ParsedText) {
            resolve(parsed[0].ParsedText);
          } else {
            reject(new Error("无识别结果"));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("请求超时")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  // 先试 HTTP，失败再试 HTTPS
  return doRequest(http).catch(() => doRequest(https));
}

// ========== 基金代码查询 v2 ==========

async function lookupFundCodeWithDebug(name) {
  const debug = { attempts: [] };
  const code = await findFundCode(name, debug);
  return { code, debug };
}

async function lookupFundCode(name) {
  return findFundCode(name, {});
}

async function findFundCode(name, debug) {
  // 生成搜索关键词列表
  const keywords = [name];
  // 去掉括号及内容（LOF、QDII 等）
  let s = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  if (s && s !== name && !keywords.includes(s)) keywords.push(s);
  // 去类型后缀
  s = name.replace(/(?:混合|股票|债券|指数|联接|ETF联接|精选|优选|产业|制造|创新)[AC]?$/, "").trim();
  if (s && s !== name && !keywords.includes(s)) keywords.push(s);
  // 去 A/C
  s = name.replace(/[AC]$/, "").trim();
  if (s && s !== name && !keywords.includes(s)) keywords.push(s);
  // 去 OCR 误加词
  s = name.replace(/瑞信|瑞银/g, "").trim();
  if (s && s !== name && !keywords.includes(s)) keywords.push(s);
  // 公司名+首关键词
  const kwRe = /(?:多元|前沿|资源|消费|蓝筹|医疗|医药|科技|新能源|半导体|军工|全球|海外|港股|沪港深|量化|策略|灵活|配置|成长|价值|红利|信息|制造|高端|环保|健康|文体|娱乐|安全|合润)/g;
  const kws = name.match(kwRe);
  const company = name.match(/^[一-鿿]{2,4}/);
  if (kws && company) {
    s = company[0] + kws[0];
    if (!keywords.includes(s)) keywords.push(s);
    if (kws.length >= 2) {
      s = kws[0] + kws[1];
      if (!keywords.includes(s)) keywords.push(s);
    }
  }
  // 去公司前缀搜纯名
  s = name.replace(/^(?:前海开源|易方达|嘉实|工银瑞信|工银|华夏|南方|广发|富国|博时|华安|招商|天弘|景顺长城|兴全|中欧|交银|银华|万家|大成|鹏华|汇添富|国泰|建信|海富通|诺安|融通|长城|泰达|华宝|华泰柏瑞|上投)/, "").replace(/[（(][^）)]*[）)]/g, "").replace(/(?:混合|股票|债券|指数)[AC]?$/, "").trim();
  if (s && s.length >= 4 && !keywords.includes(s)) keywords.push(s);

  debug.keywords = keywords;

  for (const kw of keywords) {
    const datas = await searchFund(kw);
    if (!datas.length) continue;

    const match = pickBest(name, datas);
    if (match) {
      debug.matchedBy = kw;
      debug.code = match;
      return match;
    }
  }
  return null;
}

function searchFund(keyword) {
  const https = require("https");
  return new Promise((resolve) => {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=DGCE23MHKBN23AKDN23&count=5`;
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve((json.QuotationCodeTable && json.QuotationCodeTable.Data) || []);
        } catch (e) { resolve([]); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function pickBest(ocrName, datas) {
  const ocrSuffix = (ocrName.endsWith("C") || ocrName.endsWith("A")) ? ocrName.slice(-1) : "";
  const cleanOcr = ocrName.replace(/[AC]$/, "").replace(/瑞信|瑞银/g, "");

  // 检查 apiName 的字符是否按顺序出现在 ocrName 中
  const charsMatch = (apiName) => {
    const clean = apiName.replace(/[AC]$/, "");
    let pos = 0;
    for (const ch of clean) {
      pos = cleanOcr.indexOf(ch, pos);
      if (pos === -1) return false;
      pos++;
    }
    return true;
  };

  // 收集匹配项
  const matched = [];
  for (const d of datas) {
    if (charsMatch(d.Name || "")) {
      const dSuffix = (d.Name || "").slice(-1);
      matched.push({ code: d.Code, sameSuffix: ocrSuffix && dSuffix === ocrSuffix });
    }
  }

  if (matched.length === 0) {
    // 模糊匹配
    for (const d of datas) {
      const cleanName = (d.Name || "").replace(/[AC]$/, "");
      const set = new Set(cleanOcr);
      let common = 0;
      for (const c of cleanName) { if (set.has(c)) common++; }
      if (common / Math.max(cleanOcr.length, cleanName.length) > 0.7) {
        return d.Code;
      }
    }
    return null;
  }

  // 优先同后缀
  const preferred = matched.find(m => m.sameSuffix);
  return preferred ? preferred.code : matched[0].code;
}

// ========== 持仓解析 ==========

function extractAmount(text, regex) {
  const match = text.match(regex);
  if (match) return match[1].replace(/,/g, "");
  return null;
}

function parseFundInfo(text) {
  // 预处理：合并被换行拆开的基金名
  text = text.replace(/(混合|股票|债券|指数|货币|联接|灵活)\n([AC])\b/g, "$1$2");

  // 1. 以 6 位基金代码为锚点
  const codeRe = /\b(\d{6})\b/g;
  const codes = [];
  let cm;
  while ((cm = codeRe.exec(text)) !== null) {
    const code = cm[1];
    if (parseInt(code) > 1000 && parseInt(code) < 600000) {
      codes.push({ code, index: cm.index });
    }
  }

  // 无代码：走基金名锚点解析（投资组合列表截图）
  if (codes.length === 0) return parseByNameAnchor(text);

  // 2. 每个代码切窗口，窗口内提取基金名和金额
  const holdings = [];
  for (let i = 0; i < codes.length; i++) {
    const entry = codes[i];
    const nextIdx = i + 1 < codes.length ? codes[i + 1].index : text.length;
    const window = text.substring(entry.index, nextIdx);
    // 往前取一行（基金名可能在代码上方）
    const before = text.substring(Math.max(0, entry.index - 60), entry.index);

    // 提取基金名
    let fundName = extractFundName(entry.code, window, before);

    // 窗口内提取金额
    console.log("=== code window ===", entry.code, JSON.stringify(window));
    const marketValue = extractAmount(window, /(?:持有金额|持仓金额|市值|持仓市值|金额(?!\/))[^\d]*[¥￥]?([\d,]+\.?\d{0,2})/);
    const holdingReturn = extractAmount(window, /(?:持有收益|累计收益|持仓收益)[^+\-\d]*([+-]?[\d,]+(?:\.\d{1,2})?)/);
    const shares = extractAmount(window, /(?:持有份额|份额|持仓份额)[^\d]*([\d,]+\.?\d*)/);
    const buyAmount = extractAmount(window, /(?:买入金额|投入金额|投入成本)[^\d]*[¥￥]?([\d,]+\.?\d{0,2})/);
    const buyPrice = extractAmount(window, /(?:成本价|净值|买入价|单位净值|持有成本)[^\d]*(\d+\.\d{2,4})/);
    console.log("=== extracted ===", { marketValue, holdingReturn, shares });

    holdings.push({
      fundCode: entry.code,
      fundName: fundName || undefined,
      buyPrice: buyPrice || undefined,
      shares: shares || undefined,
      marketValue: marketValue || undefined,
      holdingReturn: holdingReturn || undefined,
      buyAmount: buyAmount || undefined,
    });
  }

  return holdings;
}

function extractFundName(code, window, before) {
  const codeInWindow = window.indexOf(code);

  // A: 基金代码所在行前面或后面的中文文本
  if (codeInWindow !== -1) {
    const lineStart = window.lastIndexOf("\n", codeInWindow);
    const lineEnd = window.indexOf("\n", codeInWindow);
    const line = window.substring(lineStart + 1, lineEnd === -1 ? window.length : lineEnd);

    // 代码前面的中文
    const beforeCode = line.substring(0, line.indexOf(code));
    const cnBefore = beforeCode.match(/[一-鿿A-Za-z（）()／]{3,}/);
    if (cnBefore) return cnBefore[0].trim();

    // 代码后面的中文
    const afterCode = line.substring(line.indexOf(code) + 6);
    const cnAfter = afterCode.match(/[一-鿿A-Za-z（）()／]{3,}/);
    if (cnAfter) return cnAfter[0].trim();
  }

  // B: 上一行（去末尾换行符后再取最后一行）
  let temp = before.replace(/\n$/, "");
  const lastNewline = temp.lastIndexOf("\n");
  const prevLine = temp.substring(lastNewline + 1).trim();
  // 过滤已知 UI 标签
  const skipRe = /^(持有|基金|代码|金额|收益|份额|净值|成本|买入|¥|累计|昨日|中高|详情|资产|日涨|待确认|讨论|理财|投资|收益明|交易记|业绩走)/;
  if (prevLine.length >= 3 && !skipRe.test(prevLine)) {
    return prevLine.replace(/^[#\s]+/, "").replace(/基金名称[:\s：]*/, "");
  }

  return null;
}

// 投资组合列表截图：无基金代码，以基金名称为锚点
function parseByNameAnchor(text) {
  let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 合并被 OCR 拆行的基金名
  const fundKW = /混合|股票|债券|指数|ETF|联接|精选|优选|产业|制造|创新|成长|价值|蓝筹|配置|灵活|国防|军工|医疗|医药|科技|新能源|消费|资源|信息|高端|沪港深|环保|健康|文体|娱乐|安全|量化|策略|全球|海外|港股|LOF|QDII/;
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const prev = merged.length > 0 ? merged[merged.length - 1] : "";
    const hasDigits = /\d/.test(cur);
    const prevHasDigits = /\d/.test(prev);
    // prev 必须像基金名：6-25字中文 或 含基金关键词
    const prevLikeFund = (/[一-鿿]{6,}/.test(prev) && prev.length <= 25) || fundKW.test(prev);
    const curLikeSuffix = cur.length <= 3 || fundKW.test(cur);
    if (!hasDigits && !prevHasDigits && prevLikeFund && curLikeSuffix) {
      merged[merged.length - 1] = prev + cur;
    } else {
      merged.push(cur);
    }
  }

  console.log("=== merged lines ===", JSON.stringify(merged));

  // 基金类型关键词（用于识别基金名）
  const TYPE_KEYWORDS = "混合|股票|债券|指数|ETF|联接|货币|FOF|精选|优选|产业|制造|创新|成长|价值|蓝筹|红利|消费|医疗|医药|科技|新能源|半导体|军工|全球|海外|港股|沪港深|量化|策略|LOF|QDII";
  const typeRe = new RegExp(TYPE_KEYWORDS);
  // 基金名特征：以中文/A-Z开头，包含类型关键词，可能以A/C结尾，允许括号
  const nameRe = new RegExp(`^[一-鿿A-Z]{2,30}(?:${TYPE_KEYWORDS})[一-鿿A-Za-z（）()LOF／QDII]*[AC]?$`);

  // 找到所有基金名位置
  const namePositions = [];
  for (let i = 0; i < merged.length; i++) {
    const line = merged[i];
    if (nameRe.test(line) && typeRe.test(line)) {
      console.log("=== found fund name ===", line, "at index", i);
      namePositions.push({ name: line, lineIdx: i });
    }
  }
  console.log("=== namePositions count ===", namePositions.length);

  if (namePositions.length === 0) return [];

  // 为每个基金名提取随后的金额数据
  const holdings = [];
  for (let pi = 0; pi < namePositions.length; pi++) {
    const { name, lineIdx } = namePositions[pi];
    const nextNameIdx = pi + 1 < namePositions.length
      ? namePositions[pi + 1].lineIdx
      : merged.length;

    let marketValue = null;
    let holdingReturn = null;
    const signedNums = []; // 收集所有带符号数，取绝对值最大的

    for (let j = lineIdx + 1; j < nextNameIdx && j < merged.length; j++) {
      const line = merged[j];
      const nums = line.match(/[+-]?[\d,]+\.?\d{0,2}(?![%\d])/g);
      if (!nums) continue;

      for (const n of nums) {
        const val = parseFloat(n.replace(/[,+]/g, ""));
        if (isNaN(val)) continue;

        if (!marketValue && val >= 100) {
          marketValue = n.replace(/,/g, "");
          continue;
        }
        if (marketValue && (n.startsWith("+") || n.startsWith("-"))) {
          signedNums.push({ val: Math.abs(val), raw: n.replace(/,/g, "") });
        }
      }
    }

    if (signedNums.length > 0) {
      signedNums.sort((a, b) => b.val - a.val);
      holdingReturn = signedNums[0].raw;
    }

    console.log("=== fund ===", name, "mv:", marketValue, "hr:", holdingReturn);
    holdings.push({
      fundCode: null,
      fundName: name,
      marketValue: marketValue || undefined,
      holdingReturn: holdingReturn || undefined,
      buyPrice: undefined,
      shares: undefined,
      buyAmount: undefined,
    });
  }

  return holdings;
}
