const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require("https");

function fetchTiantian(fundCode) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://fundgz.1234567.com.cn/js/${fundCode}.js`,
      { headers: { Referer: "https://fund.eastmoney.com/" } },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            // 天天基金API异常时返回HTML而非JSONP
            if (!body.startsWith("jsonpgz(")) { console.warn("天天基金API异常:", fundCode, body.slice(0,80)); resolve({}); return; }
            const json = JSON.parse(body.replace(/^jsonpgz\(/, "").replace(/\)\;?$/, ""));
            resolve({
              fundCode: json.fundcode,
              fundName: json.name,
              nav: parseFloat(json.dwjz) || null,
              estimatedNav: parseFloat(json.gsz) || null,
              estimatedChangeRate: parseFloat(json.gszzl) || null,
              estimateTime: json.gztime || "",
            });
          } catch (e) { console.warn("天天基金解析失败:", fundCode, e.message); resolve({}); }
        });
      }
    );
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}

function fetchEastMoney(fundCode) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: "api.fund.eastmoney.com",
      path: `/f10/lsjz?callback=jQuery&fundCode=${fundCode}&pageIndex=1&pageSize=2`,
      headers: { "Referer": "https://fundf10.eastmoney.com/" },
    }, (res) => {
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
        } catch (e) { resolve({}); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    req.on("error", () => resolve({}));
  });
}

function selectChangeRate(nav, actualNav, estimatedChangeRate, actualChangeRate) {
  const n = parseFloat(nav);
  const a = parseFloat(actualNav);
  if (a && a !== n) return actualChangeRate != null ? actualChangeRate : (estimatedChangeRate || 0);
  return estimatedChangeRate != null ? estimatedChangeRate : (actualChangeRate || 0);
}

exports.main = async (event) => {
  const { codes = [] } = event;
  if (!codes.length) return { code: 400, msg: "缺少基金代码" };

  try {
    // 并行请求：每只基金同时查天天+东方财富
	    const results = await Promise.all(codes.map((code) =>
	      Promise.all([fetchTiantian(code), fetchEastMoney(code)]).then(([tt, em]) => {
	        // 天天基金挂了时兜底：至少返回东方财富数据
	        return {
	          fundCode: tt.fundCode || code,
	          fundName: tt.fundName || '',
	          nav: tt.nav || em.actualNav || null,
	          estimatedNav: tt.estimatedNav || null,
	          estimatedChangeRate: tt.estimatedChangeRate || null,
	          estimateTime: tt.estimateTime || '',
	          actualNav: em.actualNav || null,
	          actualDate: em.actualDate || '',
	          actualChangeRate: em.actualChangeRate || null,
	          displayChangeRate: selectChangeRate(tt.nav || em.actualNav, em.actualNav, tt.estimatedChangeRate, em.actualChangeRate),
	        };
	      })
	    ));
    const data = {};
    results.forEach((r, i) => {
      data[codes[i]] = r;
    });
    return { code: 0, data };
  } catch (e) {
    console.error("批量获取估值失败:", e);
    return { code: 500, msg: "获取失败" };
  }
};

