/**
 * 端到端验证脚本：连接微信开发者工具自动化端口，
 * 在真实小程序环境里调用云函数并打印结果。
 * 使用前先执行：
 *   cli auto --project /Users/liubangwe/WeChatProjects/fund-estimator
 */
const automator = require("miniprogram-automator");

const PROJECT_PATH = "/Users/liubangwe/WeChatProjects/fund-estimator";
const WS_ENDPOINT = "ws://127.0.0.1:9420";

function callFunction(mp, name, data) {
  return mp.evaluate((fnName, fnData) => new Promise((resolve) => {
    wx.cloud.callFunction({
      name: fnName,
      data: fnData || {},
      success: (r) => resolve({ ok: true, result: r.result }),
      fail: (e) => resolve({ ok: false, err: (e && e.errMsg) || "call failed" }),
    });
  }), name, data || {});
}

async function main() {
  console.log("connecting to devtools automation...");
  const miniProgram = await automator.connect({ wsEndpoint: WS_ENDPOINT, projectPath: PROJECT_PATH });
  console.log("connected, relaunch to index...");
  await miniProgram.reLaunch("/pages/index/index");
  await new Promise((r) => setTimeout(r, 3000));

  const cases = [
    ["userLogin", {}],
    ["fetchFundEstimate", { fundCode: "110022" }],
    ["fetchFundNAVHistory", { fundCode: "110022", days: 5 }],
    ["fetchFundOverview", { fundCode: "110022" }],
    ["fetchFundProfile", { fundCode: "110022" }],
    ["searchFund", { keyword: "110022" }],
    ["batchFetchEstimate", { codes: ["110022", "161725"] }],
    ["getPortfolio", {}],
    ["portfolioLight", {}],
    ["manageHolding", { action: "list" }],
    ["manageWatchlist", { action: "list" }],
    ["computeCorrelation", { fundCodes: ["110022", "161725"] }],
    ["dcaBacktest", { fundCode: "110022", monthlyAmount: 1000, startYear: "2023", startMonth: "1", monthlyDay: 1 }],
  ];

  for (const [name, data] of cases) {
    try {
      const r = await callFunction(miniProgram, name, data);
      const out = JSON.stringify(r);
      console.log(`\n===== ${name} =====`);
      console.log(out.length > 600 ? out.slice(0, 600) + "..." : out);
    } catch (e) {
      console.log(`\n===== ${name} =====`);
      console.log("CALL ERROR:", e.message);
    }
  }

  await miniProgram.close();
  console.log("\ndone");
}

main().catch((e) => {
  console.error("verify failed:", e.message);
  process.exit(1);
});
