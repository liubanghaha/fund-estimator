const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 腾讯行情代码（web.ifzq.gtimg.cn 从云函数环境可达；东财 push2/push2his 分钟线对数据中心 IP 限流，弃用）
const TX_CODE = {
  "000001": "sh000001",
  "399001": "sz399001",
  "000300": "sh000300",
  "399006": "sz399006",
};

exports.main = async (event) => {
  const { indexCode } = event;
  const code = TX_CODE[indexCode] || "sh000001";

  try {
    const body = await httpGet(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
    const json = JSON.parse(body);
    const node = json.data && json.data[code];
    const rows = node && node.data && node.data.data;
    if (!Array.isArray(rows) || rows.length < 2) return { code: 500, msg: "今日分时数据不足" };

    const qt = (node.qt && node.qt[code]) || [];
    const prevClose = parseFloat(qt[4]) || 0;
    if (!prevClose) return { code: 500, msg: "昨收价缺失" };

    // 行格式：HHMM 价格 成交量 成交额
    const data = rows
      .map((row) => {
        const parts = String(row).split(/\s+/);
        const t = parts[0] || "";
        const price = parseFloat(parts[1]) || 0;
        if (t.length !== 4 || !price) return null;
        return {
          time: `${t.slice(0, 2)}:${t.slice(2, 4)}`,
          close: price,
          changeRate: +(((price - prevClose) / prevClose) * 100).toFixed(2),
        };
      })
      .filter((d) => d !== null);

    return { code: 0, msg: "success", data };
  } catch (e) {
    console.error("获取分时数据失败:", e.message || e);
    return { code: 500, msg: "获取分时数据失败" };
  }
};

function httpGet(url) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Referer: "https://gu.qq.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { res.statusCode === 200 ? resolve(body) : reject(new Error("http " + res.statusCode)); });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}
