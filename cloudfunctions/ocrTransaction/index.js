const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  const results = await Promise.allSettled([
    wxOcr(fileID),
    spaceOcr(fileID),
  ]);

  const texts = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) texts.push(r.value);
  }

  if (texts.length === 0) return { code: 500, msg: "OCR识别失败" };

  // 合并去重：各引擎结果拼在一起跑（更全）
  const merged = texts.join('\n');
  const transactions = parseTransactions(merged);

  return {
    code: 0,
    data: { raw: merged, method: 'dual_ocr', transactions, ...(transactions[0] || {}) },
  };
};

// ========== 并行 OCR ==========

async function wxOcr(fileID) {
  try {
    const res = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" });
    if (res.items && res.items.length > 0) {
      return res.items.map(item => item.text).join("\n");
    }
  } catch (e) { console.log("微信OCR:", e.message); }
  return null;
}

async function spaceOcr(fileID) {
  try {
    const tempRes = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = tempRes.fileList[0] && tempRes.fileList[0].tempFileURL;
    if (!url) return null;
    return await ocrSpace(url);
  } catch (e) { console.log("OCR.space:", e.message); }
  return null;
}

function ocrSpace(imageUrl) {
  const https = require("https");
  const querystring = require("querystring");
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      url: imageUrl, language: "chs", isOverlayRequired: "false",
      detectOrientation: "true", OCREngine: "2",
    });
    const req = https.request({
      hostname: "api.ocr.space", path: "/parse/image", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apikey: "helloworld", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const parsed = json.ParsedResults || [];
          if (parsed.length > 0 && parsed[0].ParsedText) resolve(parsed[0].ParsedText);
          else reject(new Error("无识别结果"));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("超时")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
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

function parseBlock(block) {
  const tx = {};

  // 基金名：逐行拼接直到遇到日期/金额
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

  // 日期+时间
  const dtm = block.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (dtm) {
    const rawDate = dtm[1].replace(/[./]/g, "-").substring(0, 10);
    const hour = parseInt(dtm[2].split(":")[0], 10);
    if (hour >= 15) {
      const d = new Date(rawDate);
      d.setDate(d.getDate() + 1);
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

  // 金额：多版本匹配
  const am1 = block.match(/([\d,]+\.?\d{1,2})\s*元/);
  if (am1) {
    const v = parseFloat(am1[1].replace(/,/g, ""));
    if (v >= 1) tx.amount = String(v);
  }
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

// ========== 基金名称提取 ==========

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
