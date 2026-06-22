const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fundCode } = event;
  if (!fundCode) return { code: 400, msg: "请提供基金代码" };

  try {
    const [estimate, actual, peTemp] = await Promise.all([
      fetchTiantian(fundCode),
      fetchEastMoney(fundCode),
      fetchTemperature(fundCode),
    ]);
    return {
      code: 0, msg: "success",
      data: { ...estimate, ...actual, peTemp },
    };
  } catch (e) {
    console.error("获取估值失败:", e.message);
    return { code: 500, msg: "获取估值失败" };
  }
};

function fetchTiantian(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, ""));
          resolve({
            fundCode: json.fundcode,
            fundName: json.name,
            nav: parseFloat(json.dwjz) || null,
            estimatedNav: parseFloat(json.gsz) || null,
            estimatedChangeRate: parseFloat(json.gszzl) || null,
            estimateTime: json.gztime || "",
          });
        } catch (e) {
          resolve({});
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", (e) => {
      console.error("天天基金请求失败:", e.message);
      resolve({});
    });
  });
}

function fetchEastMoney(fundCode) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: "api.fund.eastmoney.com",
        path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`,
        headers: { "Referer": "https://fundf10.eastmoney.com/" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(body.replace(/^jQuery\(/, "").replace(/\)$/, ""));
            const list = (json.Data && json.Data.LSJZList) || [];
            const today = list[0] || {};
            resolve({
              actualNav: parseFloat(today.DWJZ) || null,
              actualDate: today.FSRQ || "",
              actualChangeRate: parseFloat(today.JZZZL) || null,
            });
          } catch (e) {
            console.error("东方财富解析失败:", e.message, body.substring(0, 200));
            resolve({});
          }
        });
      }
    );
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", (e) => {
      console.error("东方财富请求失败:", e.message);
      resolve({});
    });
  });
};

async function fetchTemperature(fundCode) {
  try {
    const db = cloud.database();
    const res = await db.collection("fund_temperatures")
      .where({ fundCode })
      .orderBy("createTime", "desc")
      .limit(1)
      .get();
    if (res.data && res.data.length > 0) {
      const t = res.data[0];
      return {
        signal: t.signal,
        label: t.label,
        normPE: t.normPE,
        weightedPE: t.weightedPE,
        coverage: t.coverage,
        stocksWithData: t.stocksWithData,
        totalStocks: t.totalStocks,
        detailPEs: t.detailPEs || [],
        warnings: t.warnings || [],
        isETF: t.isETF || false,
      };
    }
  } catch (e) { /* ignore */ }

  // 数据库中无记录，按需计算
  try {
    return await computeTempOnDemand(fundCode);
  } catch (e) { console.error("按需计算温度失败:", e.message); }
  return null;
}

async function computeTempOnDemand(fundCode) {
  // 1. 拉取持仓股
  const { holdings, fundName } = await fetchOneFundHoldings(fundCode);
  if (!holdings || holdings.length === 0) return null;
  const isETF = /ETF|交易型开放式|指数/.test(fundName || "");

  // 2. 收集股票代码
  const stockCodes = [...new Set(holdings.map(h => h.stockCode).filter(c => c && (c.length === 6 || c.length === 5)))];
  if (stockCodes.length === 0) return null;

  // 3. 拉取实时 PE/PB + 历史 PE
  const [liveMap, histMap] = await Promise.all([
    fetchStockLiveBatch(stockCodes),
    fetchStockHistBatch(stockCodes),
  ]);

  // 4. 逐股打分
  let totalScore = 0, totalRatio = 0, stocksWithData = 0;
  const detailPEs = [];
  holdings.forEach(h => {
    const live = liveMap[h.stockCode] || {};
    const hist = histMap[h.stockCode] || {};
    const pe = live.pe || null;
    const pb = live.pb || null;
    const pePct = pe && pe > 0 ? _calcPEPct(pe, hist.peYears || []) : null;
    const pbPct = pb && pb > 0 ? _calcPEPct(pb, hist.pbYears || []) : null;
    const iType = _classify(live.industry || "其他");
    const score = _scoreStock(pe, pePct, pb, pbPct, iType);
    totalScore += score.val * h.navRatio;
    totalRatio += h.navRatio;
    stocksWithData++;
    detailPEs.push({
      code: h.stockCode, name: h.stockName,
      pe: pe ? +pe.toFixed(2) : null,
      pb: pb ? +pb.toFixed(2) : null,
      industry: live.industry || "其他",
      normPE: score.val, ratio: h.navRatio, note: score.note,
    });
  });

  if (totalRatio < 20) return null;
  const avgScore = +(totalScore / totalRatio).toFixed(3);
  const normPE = +(2.0 - avgScore).toFixed(3);
  let signal = "mid", label = "正常";
  if (normPE < 0.75) { signal = "low"; label = "低估"; }
  else if (normPE > 1.25) { signal = "high"; label = "高估"; }

  // 计算加权PE
  let totalWPE = 0;
  holdings.forEach(h => {
    const live = liveMap[h.stockCode] || {};
    if (live.pe && live.pe > 0) totalWPE += live.pe * h.navRatio;
  });
  const weightedPE = totalRatio > 0 ? +(totalWPE / totalRatio).toFixed(2) : 0;

  const result = {
    signal, label, normPE, weightedPE,
    coverage: +totalRatio.toFixed(1),
    stocksWithData, totalStocks: holdings.length,
    detailPEs, warnings: [], isETF,
  };

  // 写入 DB 缓存
  try {
    const today = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-${String(new Date().getDate()).padStart(2,"0")}`;
    await db.collection("fund_temperatures").add({
      data: { fundCode, date: today, ...result, createTime: new Date() },
    }).catch(() => {});
  } catch (e) { /* ignore */ }

  return result;
}

// ---- 按需计算助手 ----

function fetchOneFundHoldings(fundCode) {
  const https = require("https");
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const pubMonths = [12, 3, 6, 9];
  let curM = 3, curY = year;
  for (let i = 3; i >= 0; i--) {
    if (month >= pubMonths[i] + 1) { curM = pubMonths[i]; break; }
    if (i === 0) { curY = year - 1; curM = 12; }
  }
  return new Promise((resolve) => {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=20&year=${curY}&month=${curM}&rt=${Math.random()}`;
    const req = https.get(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const match = body.match(/content:"([^"]+)"/);
          if (!match) { resolve({ holdings: [] }); return; }
          const html = match[1].replace(/\\"/g, '"');
          const nameMatch = html.match(/<a title='([^']*)'/);
          const fundName = nameMatch ? nameMatch[1] : "";
          const rows = [];
          const trRe = /<tr>([\s\S]*?)<\/tr>/g;
          let trM;
          while ((trM = trRe.exec(html)) !== null) {
            const tds = [];
            const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let tdM;
            while ((tdM = tdRe.exec(trM[1])) !== null) {
              tds.push(tdM[1].replace(/<[^>]+>/g, "").trim());
            }
            if (tds.length >= 7 && !tds[0].includes("*")) {
              const n = tds.length;
              rows.push({
                stockCode: tds[1], stockName: tds[2],
                navRatio: parseFloat(tds[n - 3]) || 0,
              });
            }
          }
          resolve({ holdings: rows, fundName });
        } catch (e) { resolve({ holdings: [] }); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ holdings: [] }); });
    req.on("error", () => resolve({ holdings: [] }));
  });
}

async function fetchStockLiveBatch(codes) {
  const https = require("https");
  const map = {};
  const BATCH = 40;
  const secid = (c) => { if (c.length === 5) return `116.${c}`; if (c.startsWith("6")) return `1.${c}`; return `0.${c}`; };
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f9,f12,f100,f164&secids=${batch.map(secid).join(",")}`;
    await new Promise((resolve) => {
      const req = https.get(url, { headers: { Referer: "https://quote.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = JSON.parse(body).data;
            if (d && d.diff) {
              d.diff.forEach(item => {
                const pe = item.f9;
                if (pe !== undefined && pe !== null) {
                  const ap = pe > 500 ? pe / 100 : pe;
                  const pb = item.f164 != null ? (+item.f164) : null;
                  map[item.f12] = { pe: ap, pb: pb && pb > 0 ? pb : null, price: item.f2 || null, industry: item.f100 || "其他" };
                }
              });
            }
          } catch (e) { /* ignore */ }
          resolve();
        });
      });
      req.setTimeout(12000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

async function fetchStockHistBatch(codes) {
  const https = require("https");
  const map = {};
  for (const code of codes) {
    await new Promise((resolve) => {
      const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_VALUE_ANALYSIS&columns=PEAVG,PEMAX,PEMIN,PBAVG,PBMAX,PBMIN&filter=(SECURITY_CODE=%22${code}%22)&pageSize=50&sortColumns=STARTDATE&sortTypes=1`;
      const req = https.get(url, { headers: { Referer: "https://data.eastmoney.com/" } }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            const data = (d.result && d.result.data) || [];
            map[code] = {
              peYears: data.map(r => ({ avg: +r.PEAVG, max: +r.PEMAX, min: +r.PEMIN })).filter(r => r.avg > 0 && r.avg < 10000),
              pbYears: data.map(r => ({ avg: +r.PBAVG, max: +r.PBMAX, min: +r.PBMIN })).filter(r => r.avg > 0 && r.avg < 1000),
            };
          } catch (e) { map[code] = { peYears: [], pbYears: [] }; }
          resolve();
        });
      });
      req.setTimeout(10000, () => { req.destroy(); resolve(); });
      req.on("error", () => resolve());
    });
  }
  return map;
}

function _calcPEPct(current, arr) {
  if (!arr || arr.length < 3) return null;
  const avgs = arr.map(y => y.avg).sort((a, b) => a - b);
  let below = 0;
  for (const a of avgs) { if (current > a) below++; }
  return Math.round((below / avgs.length) * 100);
}

function _classify(ind) {
  const cyc = ["煤炭","钢铁","有色","石油","化工","稀土","黄金","铜","铝","海运","造船","矿石","建材","水泥","玻璃"];
  const fin = ["银行","保险","证券","地产","房地产","多元金融"];
  for (const kw of cyc) if (ind.includes(kw)) return "cycle";
  for (const kw of fin) if (ind.includes(kw)) return "finance";
  return "other";
}

function _scoreStock(pe, pePct, pb, pbPct, iType) {
  if (!pe || pe <= 0 || pe > 500) {
    if (pb && pb > 0 && pbPct != null) return { val: pbPct < 25 ? 1.6 : pbPct < 65 ? 1.0 : 0.4, note: `PB${pbPct}%分位` };
    return { val: 1.0, note: "PE无效" };
  }
  if (pe > 80 && pePct != null) return { val: 0.5, note: `PE${pe}倍·${pePct}%分位` };
  if (pe > 50 && pePct != null && pePct < 40) return { val: 0.7, note: `PE${pe}倍偏高·${pePct}%分位` };
  if (iType === "finance" && pb && pb > 0 && pbPct != null) {
    const peS = pePct != null ? (pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5) : 1.0;
    const pbS = pbPct < 25 ? 1.5 : pbPct < 65 ? 1.0 : 0.5;
    return { val: +(peS * 0.5 + pbS * 0.5).toFixed(2), note: `PE${pePct}% PB${pbPct}%分位` };
  }
  if (iType === "cycle" && pePct != null && pePct < 40) return { val: pePct < 20 ? 1.4 : 1.0, note: `PE${pePct}%分位⚠️` };
  if (pePct != null) return { val: pePct < 30 ? 1.5 : pePct < 70 ? 1.0 : 0.5, note: `PE${pePct}%分位` };
  return { val: 1.0, note: "数据不足" };
}
