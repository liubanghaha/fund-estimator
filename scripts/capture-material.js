/**
 * 运营物料截图：连接微信开发者工具，把核心页面按真实数据截下来。
 *
 * 用法：
 *   NODE_PATH=$PWD/node_modules node scripts/capture-material.js
 *
 * 输出：pic/material-raw/*.png
 * 前置：微信开发者工具已登录，且当前模拟器账号有真实持仓数据。
 * 注意：脚本会自己拉起 cli auto（后台子进程），结束时 disconnect 关闭。
 */
const automator = require("miniprogram-automator");
const path = require("path");
const fs = require("fs");

const PROJECT_PATH = path.resolve(__dirname, "..");
const CLI_PATH = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const OUT_DIR = path.join(PROJECT_PATH, "pic", "material-raw");
const PORT = 9421;

fs.mkdirSync(OUT_DIR, { recursive: true });

// 页面清单：name 是文件名，nav 是打开方式
const SHOTS = [
  { name: "01-home", type: "reLaunch", url: "/pages/index/index", wait: 5000 },
  { name: "02-watchlist", type: "switchTab", url: "/pages/watchlist/index", wait: 4000 },
  { name: "03-market", type: "switchTab", url: "/pages/market/index", wait: 4000 },
  {
    name: "04-fund-detail",
    type: "navigateTo",
    url: "/subpackages/analysis/pages/fund-detail/index?fundCode=011329&fundName=%E6%99%AF%E9%A1%BA%E9%95%BF%E5%9F%8E%E6%96%B0%E8%83%BD%E6%BA%90%E4%BA%A7%E4%B8%9A%E4%B8%9A",
    wait: 7000,
  },
  { name: "05-profit", type: "navigateTo", url: "/subpackages/analysis/pages/profit-detail/index", wait: 6000 },
  { name: "06-review", type: "navigateTo", url: "/subpackages/analysis/pages/review/index", wait: 6000 },
  { name: "07-asset", type: "navigateTo", url: "/subpackages/analysis/pages/correlation-matrix/index", wait: 8000 },
  {
    name: "08-compare",
    type: "navigateTo",
    url:
      "/subpackages/analysis/pages/fund-compare/index" +
      "?fundCode=011329&fundName=%E6%99%AF%E9%A1%BA%E9%95%BF%E5%9F%8E%E6%96%B0%E8%83%BD%E6%BA%90%E4%BA%A7%E4%B8%9A%E4%B8%9A" +
      "&fundB=005660&fundBName=%E5%98%89%E5%AE%9E%E8%B5%84%E6%BA%90%E7%B2%BE%E9%80%89%E8%82%A1%E7%A5%A8A",
    wait: 8000,
  },
  { name: "09-add-holding", type: "navigateTo", url: "/pages/add-holding/index", wait: 4000 },
  { name: "10-search", type: "navigateTo", url: "/pages/search/index", wait: 3000 },
];

async function main() {
  console.log("启动开发者工具自动化…");
  const mp = await automator.launch({
    cliPath: CLI_PATH,
    projectPath: PROJECT_PATH,
    port: PORT,
  });
  console.log("已连接\n");

  const si = await mp.systemInfo();
  console.log(
    `设备 ${si.model || "?"} · ${si.windowWidth}x${si.windowHeight} @${si.pixelRatio}x\n`
  );

  const done = [];
  for (const shot of SHOTS) {
    try {
      if (shot.type === "reLaunch") await mp.reLaunch(shot.url);
      else if (shot.type === "switchTab") await mp.switchTab(shot.url);
      else await mp.navigateTo(shot.url);

      await new Promise((r) => setTimeout(r, shot.wait));
      const file = path.join(OUT_DIR, `${shot.name}.png`);
      await mp.screenshot({ path: file });
      const size = fs.statSync(file).size;
      console.log(`  ✅ ${shot.name}  ${(size / 1024).toFixed(0)} KB`);
      done.push(shot.name);
    } catch (e) {
      console.log(`  ⚠️  ${shot.name} 失败：${e.message}`);
    }
  }

  console.log(`\n完成 ${done.length}/${SHOTS.length}，输出目录：${OUT_DIR}`);
  mp.disconnect();
}

main().catch((e) => {
  console.error("❌ 失败：", e.message);
  process.exit(1);
});
