const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  let text = "";
  let method = "";

  try {
    const ocrRes = await cloud.openapi.ocr.printedText({ imgUrl: fileID, type: "photo" });
    if (ocrRes.items && ocrRes.items.length > 0) {
      text = ocrRes.items.map((item) => item.text).join("\n");
      method = "wechat_ocr";
    }
  } catch (e) {
    console.log("微信OCR不可用:", e.message);
  }

  if (!text) {
    try {
      const tempRes = await cloud.getTempFileURL({ fileList: [fileID] });
      const tempUrl = tempRes.fileList[0]?.tempFileURL;
      if (!tempUrl) throw new Error("获取临时链接失败");
      text = await ocrSpace(tempUrl);
      method = "ocrspace";
    } catch (e) {
      console.log("OCR.space不可用:", e.message);
    }
  }

  if (!text) {
    return { code: 500, msg: "OCR识别失败" };
  }

  const transactions = parseTransactions(text);

  return {
    code: 0,
    data: {
      raw: text,
      method,
      transactions,
      // 兼容旧格式
      ...(transactions[0] || {}),
    },
  };
};

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
          const parsed = json.ParsedResults || [];
          if (parsed.length > 0 && parsed[0].ParsedText) {
            resolve(parsed[0].ParsedText);
          } else {
            reject(new Error("无识别结果"));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("请求超时")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseTransactions(text) {
  const transactions = [];

  // 按"基金|"或"基金|"分割，每段是一个基金交易
  const blocks = text.split(/基金[|｜]/);
  // 第一段是表头等无用信息，跳过

  for (let i = 1; i < blocks.length; i++) {
    let block = blocks[i];
    const tx = {};

    // 基金名称（以类型关键词为特征）
    const typeKw = "混合|股票|债券|指数|货币|ETF|FOF|联接|灵活|优选|稳健|成长|价值|蓝筹|红利|消费|医疗|科技|新能源|半导体|军工|制造|印度|纳斯达克|标普|恒生|全球|海外|量化|策略|精选|前沿|多元|新消费|资源|通成|配置|蓝筹";
    const nameRe = new RegExp(
      "([一-鿿A-Za-z]{2,16}(?:" + typeKw + ")[一-鿿A-Za-z0-9（()LOF／QDII）]{0,12})"
    );
    const nm = block.match(nameRe);
    if (nm) {
      tx.fundName = nm[1];
      // 修复被 OCR 换行拆开的 A/C 后缀
      const after = block.substring(nm.index + nm[0].length);
      const suffixMatch = after.match(/^\s*([AC])\b/);
      if (suffixMatch && !tx.fundName.endsWith(suffixMatch[1])) {
        tx.fundName += suffixMatch[1];
      }
    }

    // 日期（只取前10位日期，去掉时间部分）
    const dm = block.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/);
    if (dm) tx.date = dm[1].replace(/[./]/g, "-").substring(0, 10);

    // 金额（提取含"元"的数字，注意负号表示卖出）
    const lines = block.split("\n");
    let rawAmount = "";
    for (let j = lines.length - 1; j >= 0; j--) {
      // 匹配带符号的金额：-500.00元 或 500.00元
      const am = lines[j].match(/([+-]?[\d,]+\.?\d{1,2})\s*(?:元|$)/);
      if (am) {
        const v = parseFloat(am[1].replace(/,/g, ""));
        if (Math.abs(v) >= 10 && Math.abs(v) < 1e10) {
          rawAmount = am[1].replace(/,/g, "");
          tx.amount = String(Math.abs(v));
          break;
        }
      }
    }
    if (!tx.amount) {
      const allNums = [];
      const nr = /([+-]?\d[\d,]*\.?\d{1,2})/g;
      let n;
      while ((n = nr.exec(block)) !== null) {
        const v = parseFloat(n[1].replace(/,/g, ""));
        if (Math.abs(v) >= 10 && Math.abs(v) < 1e10) allNums.push({ v: Math.abs(v), s: String(Math.abs(v)), sign: n[1].startsWith("-") });
      }
      if (allNums.length > 0) {
        tx.amount = allNums[allNums.length - 1].s;
        rawAmount = (allNums[allNums.length - 1].sign ? "-" : "") + allNums[allNums.length - 1].s;
      }
    }

    // 交易类型判断：金额有负号 = 卖出，否则按关键词
    if (rawAmount.startsWith("-")) {
      tx.type = "sell";
    } else if (/卖出|赎回|卖/.test(block)) {
      tx.type = "sell";
    } else {
      tx.type = "buy";
    }

    // 至少要有名称或金额才算有效
    if (tx.fundName || tx.amount) {
      transactions.push(tx);
    }
  }

  return transactions;
}
