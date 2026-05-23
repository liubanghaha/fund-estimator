const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) return { code: 400, msg: "请提供截图" };

  let text = "";
  let method = "";

  try {
    const ocrRes = await cloud.openapi.ocr.printedText({
      imgUrl: fileID,
      type: "photo",
    });
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
    return { code: 500, msg: "OCR识别失败，请对照截图手动输入" };
  }

  const holdings = parseFundInfo(text);
  if (holdings.length === 0) {
    return { code: 0, data: { raw: text, method }, msg: "未能识别出基金信息" };
  }

  // data 兼容旧格式（第一只基金平铺），holdings 含全部
  return {
    code: 0,
    data: {
      raw: text,
      method,
      fundCode: holdings[0].fundCode,
      fundName: holdings[0].fundName,
      buyPrice: holdings[0].buyPrice,
      shares: holdings[0].shares,
      buyAmount: holdings[0].buyAmount,
      holdings,
    },
  };
};

function ocrSpace(imageUrl) {
  const https = require("https");
  const querystring = require("querystring");
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      url: imageUrl,
      language: "chs",
      isOverlayRequired: "false",
      detectOrientation: "true",
      OCREngine: "2",
    });
    const req = https.request(
      {
        hostname: "api.ocr.space",
        path: "/parse/image",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          apikey: "helloworld",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
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
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("请求超时")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseFundInfo(text) {
  // 预处理：合并被换行拆开的基金名
  text = text.replace(/(混合|股票|债券|指数|货币|联接|灵活)\n([AC])\b/g, "$1$2");

  // 匹配所有基金名称及其位置
  const typeKw = "混合|股票|债券|指数|货币|ETF|FOF|联接|灵活|优选|稳健|成长|价值|蓝筹|红利|消费|医疗|科技|新能源|半导体|军工|制造";
  const fundNameRe = new RegExp(
    "([一-鿿]{2,12}(?:" + typeKw + ")[一-鿿A-Za-z（()LOF）]{0,10}[AC]?(?=$|[\\s，,。+\\-（(]))",
    "g"
  );
  const names = [];
  let nm;
  while ((nm = fundNameRe.exec(text)) !== null) {
    names.push({ fundName: nm[1], index: nm.index });
  }

  // 匹配所有大额数字
  const amounts = [];
  const amountRe = /(\d{1,3}(?:,\d{3})*(?:\.\d{2,4}))/g;
  let m;
  while ((m = amountRe.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ""));
    if (val >= 100 && val < 100000000) {
      amounts.push({ value: val, str: m[1].replace(/,/g, ""), index: m.index });
    }
  }

  // 6 位基金代码
  const codeMatch = text.match(/\b(\d{6})\b/g);
  const validCodes = codeMatch
    ? codeMatch.filter((c) => parseInt(c) > 1000 && parseInt(c) < 600000)
    : [];

  // 成本价/净值（详情页）
  let buyPrice = null;
  const priceMatch = text.match(/(?:成本价|净值|买入价|单位净值|持有成本)[:\s：]*(\d+\.\d{2,4})/);
  if (priceMatch) {
    const p = parseFloat(priceMatch[1]);
    if (p > 0.1 && p < 100) buyPrice = priceMatch[1];
  }

  // 持有份额（详情页）
  let shares = null;
  const sharesMatch = text.match(/(?:持有份额|份额|持仓份额)[:\s：]*([\d,]+\.?\d*)/);
  if (sharesMatch) shares = sharesMatch[1].replace(/,/g, "");

  // 配对：每个基金名配它后面第一个金额（且在下一个基金名之前）
  const holdings = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const nextNameIdx = i + 1 < names.length ? names[i + 1].index : text.length;
    const myAmounts = amounts.filter((a) => a.index > name.index && a.index < nextNameIdx);

    holdings.push({
      fundName: name.fundName,
      fundCode: i < validCodes.length ? validCodes[i] : (i === 0 && validCodes.length > 0 ? validCodes[0] : undefined),
      buyPrice: i === 0 ? buyPrice : undefined,
      shares: i === 0 ? shares : undefined,
      buyAmount: myAmounts.length > 0 ? myAmounts[0].str : undefined,
    });
  }

  return holdings;
}
