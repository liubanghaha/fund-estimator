/**
 * 10 月公众号文章配图截图
 * 用法：NODE_PATH=$PWD/node_modules node scripts/capture-article.js
 * 输出：articles/screenshots/2026-10/*.png
 */
const automator = require("miniprogram-automator");
const path = require("path");
const fs = require("fs");

const PROJECT = path.resolve(__dirname, "..");
const OUT = path.join(PROJECT, "articles", "screenshots", "2026-10");
const CLI = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, port: 9435 });
  console.log("已连接\n");

  const shot = async (name) => {
    const f = path.join(OUT, `${name}.png`);
    await mp.screenshot({ path: f });
    console.log("  ✅", name, (fs.statSync(f).size / 1024).toFixed(0) + "KB");
  };

  // 1) 首页 + 今日归因（展开）
  let page = await mp.reLaunch("/pages/index/index");
  await sleep(6000);
  try {
    const hasAttr = await page.data("attrCard");
    console.log("归因卡片数据:", hasAttr ? "有" : "无");
    if (hasAttr) {
      await page.setData({ attrExpanded: true });
      await sleep(1200);
    }
  } catch (e) { console.log("  归因读取失败:", e.message); }
  await shot("01-归因");

  // 2) 自选页
  page = await mp.switchTab("/pages/watchlist/index");
  await sleep(5000);
  await shot("02-自选表格");

  // 3) 基金详情（风险指标 + 关注按钮）
  page = await mp.navigateTo(
    "/subpackages/analysis/pages/fund-detail/index?fundCode=011329&fundName=" +
      encodeURIComponent("景顺长城新能源产业股票C")
  );
  await sleep(7000);
  await shot("03-详情首屏");
  await mp.pageScrollTo(900, 400);
  await sleep(1800);
  await shot("04-风险指标");

  // 4) 回本中心（代码 + 详情入口）
  await mp.navigateTo("/subpackages/analysis/pages/review/index");
  await sleep(5000);
  await shot("05-回本中心");

  // 5) 我的 → 意见反馈（联系客服）
  page = await mp.switchTab("/pages/user-center/index");
  await sleep(3000);
  await mp.pageScrollTo(1200, 400);
  await sleep(1200);
  try {
    await page.callMethod("onFeedback");
    await sleep(1500);
  } catch (e) { console.log("  展开反馈失败:", e.message); }
  await mp.pageScrollTo(1600, 400);
  await sleep(1500);
  await shot("06-联系客服");

  console.log("\n完成 →", OUT);
  mp.disconnect();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
