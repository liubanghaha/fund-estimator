const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { funds } = event;
  const { OPENID } = cloud.getWXContext();
  const uid = event.testOpenid || OPENID;
  if (!uid) return { code: 401, msg: "请先登录" };
  if (!Array.isArray(funds) || funds.length === 0) return { code: 400, msg: "无持仓数据" };

  try {
    // 1. 提取有效基金代码
    const validFunds = funds.filter(f => f.fundCode && f.fundCode.trim());
    if (validFunds.length === 0) return { code: 400, msg: "无有效基金代码" };

    const codes = validFunds.map(f => f.fundCode.trim());
    const codeSet = new Set(codes);

    // 2. 批量获取净值估算（一次 HTTP 调用）
    const navMap = await batchFetchNav(codes);

    // 3. 批量检查已存在的持仓
    const existCodes = new Set();
    const existRes = await db.collection("holdings")
      .where({ _openid: OPENID, fundCode: _.in(codes) })
      .field({ fundCode: true })
      .get();
    existRes.data.forEach(h => existCodes.add(h.fundCode));

    // 4. 计算并准备写入数据
    const toInsert = [];
    const skipped = [];
    for (const f of validFunds) {
      const code = f.fundCode.trim();
      const name = f.fundName || "";

      if (existCodes.has(code)) {
        skipped.push({ code, name, reason: "已存在" });
        continue;
      }

      const mv = parseFloat(f.marketValue) || 0;
      const hr = parseFloat(f.holdingReturn) || 0;
      let shares = parseFloat(f.shares) || 0;
      let buyPrice = parseFloat(f.buyPrice) || 0;

      // 优先使用客户端传入的 shares/buyPrice（手动录入），否则根据 NAV 计算
      if (mv > 0 && (shares <= 0 || buyPrice <= 0)) {
        const nav = navMap[code];
        if (nav && nav > 0) {
          shares = parseFloat((mv / nav).toFixed(2));
          buyPrice = shares > 0 ? parseFloat((nav - hr / shares).toFixed(4)) : 0;
        }
      }

      if (mv <= 0 && shares <= 0) {
        skipped.push({ code, name, reason: "无市值数据" });
        continue;
      }

      toInsert.push({
        fundCode: code,
        fundName: name,
        buyPrice: buyPrice || 0,
        shares: shares || 0,
        marketValue: mv,
        holdingReturn: hr,
        buyAmount: shares > 0 && buyPrice > 0 ? parseFloat((shares * buyPrice).toFixed(2)) : 0,
        buyDate: f.buyDate || "",
        _openid: OPENID,
        createTime: new Date(),
      });
    }

    // 5. 批量写入
    let added = 0;
    if (toInsert.length > 0) {
      // 逐条写入（云开发不支持 bulk insert），但服务端无网络往返延迟
      const insertTasks = toInsert.map(data =>
        db.collection("holdings").add({ data }).catch(() => null)
      );
      const results = await Promise.all(insertTasks);
      added = results.filter(r => r !== null).length;
    }

    return {
      code: 0,
      data: { added, skipped: skipped.length, skippedList: skipped },
    };
  } catch (e) {
    console.error("批量添加持仓失败:", e);
    return { code: 500, msg: "保存失败" };
  }
};

/**
 * 批量获取天天基金净值估算（单次 HTTP 请求）
 */
async function batchFetchNav(codes) {
  const https = require("https");
  const map = {};
  const batchCode = codes.join(",");

  try {
    const body = await new Promise((resolve) => {
      const req = https.get(
        `https://fundgz.1234567.com.cn/js/${batchCode}.js`,
        { headers: { Referer: "https://fundgz.1234567.com.cn/" } },
        (res) => {
          let data = "";
          res.on("data", c => data += c);
          res.on("end", () => resolve(data));
        }
      );
      req.setTimeout(8000, () => { req.destroy(); resolve(""); });
      req.on("error", () => resolve(""));
    });

    // 解析 jsonpgz({...}) 格式
    const jsonStr = body.replace(/^jsonpgz\(/, "").replace(/\);?\s*$/, "");
    if (!jsonStr) return map;
    const data = JSON.parse(jsonStr);
    // 批量返回格式：{ fundcode1: {...}, fundcode2: {...} }，也可能是数组
    const entries = Array.isArray(data) ? data : [data];
    for (const item of entries) {
      if (item && item.fundcode) {
        // gsz: 估算净值, dwjz: 单位净值
        const nav = parseFloat(item.gsz) || parseFloat(item.dwjz) || 0;
        if (nav > 0) map[item.fundcode] = nav;
      }
    }
  } catch (e) {
    console.error("批量获取净值失败:", e.message);
  }

  // 批量接口失败的基金，逐个 fallback
  const missingCodes = codes.filter(c => !map[c]);
  if (missingCodes.length > 0) {
    await Promise.all(missingCodes.map(code =>
      fetchSingleNav(code).then(nav => { if (nav) map[code] = nav; }).catch(() => {})
    ));
  }

  return map;
}

async function fetchSingleNav(code) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(
      `https://fundgz.1234567.com.cn/js/${code}.js`,
      { headers: { Referer: "https://fundgz.1234567.com.cn/" } },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            const json = data.replace(/^jsonpgz\(/, "").replace(/\);?\s*$/, "");
            const item = JSON.parse(json);
            const nav = parseFloat(item.gsz) || parseFloat(item.dwjz) || 0;
            resolve(nav > 0 ? nav : null);
          } catch (e) { resolve(null); }
        });
      }
    );
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}
