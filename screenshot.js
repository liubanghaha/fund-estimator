/**
 * Vibe Coding 活动截图脚本
 * 使用 miniprogram-automator 连接微信开发者工具自动截图
 */
const automator = require('miniprogram-automator');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, 'vibe-coding');
const PROJECT_PATH = '/Users/liubangwe/WeChatProjects/fund-estimator';

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 要截图的页面列表
const pages = [
  {
    name: '01-home',
    path: 'pages/index/index',
    desc: '首页-今日收益卡片+持仓列表',
    wait: 3000,
  },
  {
    name: '02-index-bar',
    path: 'pages/index/index',
    desc: '首页-展开底部指数行情栏',
    wait: 2000,
    // 需要先点开指数栏，这里可能需要手动操作
  },
  {
    name: '03-ocr',
    path: 'pages/add-holding/index',
    desc: '添加持仓-截图导入OCR入口',
    wait: 2000,
  },
  {
    name: '04-profit',
    path: 'pages/profit-detail/index',
    desc: '收益详情-走势图+盈亏日历',
    wait: 3000,
  },
  {
    name: '05-compare',
    path: 'pages/fund-compare/index',
    desc: '基金对比',
    wait: 2000,
  },
  {
    name: '06-search',
    path: 'pages/search/index',
    desc: '搜索基金',
    wait: 1500,
  },
];

async function screenshot(automator, page, name, wait) {
  // 等待页面渲染
  await new Promise(r => setTimeout(r, wait));
  const filePath = path.join(OUTPUT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath });
  console.log(`  ✅ 已保存: ${name}.png`);
}

async function main() {
  console.log('🚀 启动自动化截图...\n');

  console.log('连接到微信开发者工具...');
  const miniProgram = await automator.connect({
    wsEndpoint: 'ws://127.0.0.1:9420',
    projectPath: PROJECT_PATH,
  });
  console.log('✅ 已连接\n');

  // 截图首页
  console.log('📸 1/6 首页 - 收益卡片 + 持仓列表');
  let page = await miniProgram.reLaunch('/pages/index/index');
  await screenshot(null, page, '01-home', 3000);

  // 截图首页 - 指数栏（在首页基础上需要点击展开）
  console.log('📸 2/6 首页 - 指数行情栏');
  // 尝试点击指数栏展开按钮
  try {
    const el = await page.$('.index-bar-toggle');
    if (el) await el.tap();
    await new Promise(r => setTimeout(r, 1000));
  } catch(e) {
    console.log('  ⚠️ 无法点击指数栏，截取当前页面');
  }
  await screenshot(null, page, '02-index-bar', 1000);

  // 截图添加持仓页（OCR 入口）
  console.log('📸 3/6 添加持仓 - OCR截图导入');
  page = await miniProgram.navigateTo('/pages/add-holding/index');
  await screenshot(null, page, '03-ocr', 2500);

  // 截图收益详情
  console.log('📸 4/6 收益详情');
  page = await miniProgram.navigateTo('/pages/profit-detail/index');
  await screenshot(null, page, '04-profit', 3000);

  // 截图搜索页（这个不需要参数）
  console.log('📸 5/6 搜索基金');
  page = await miniProgram.navigateTo('/pages/search/index');
  await screenshot(null, page, '05-search', 2000);

  // 基金对比页需要参数，尝试 navigateTo 传参
  console.log('📸 6/6 基金对比（如失败则是缺参数）');
  try {
    page = await miniProgram.navigateTo('/pages/fund-compare/index');
    await screenshot(null, page, '06-compare', 2000);
  } catch(e) {
    console.log('  ⚠️ 基金对比页需要参数，已跳过');
  }

  console.log('\n🎉 截图完成！文件保存在 vibe-coding/ 目录');
  await miniProgram.close();
}

main().catch(async (err) => {
  console.error('❌ 截图失败:', err.message);
  // 如果连接失败，给出提示
  if (err.message.includes('connect')) {
    console.log('\n请确保微信开发者工具已通过以下命令启动：');
    console.log('  cli auto --project . --port 9420');
  }
  process.exit(1);
});
