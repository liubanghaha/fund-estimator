/**
 * OCR 截图导入 真实环境测试脚本
 *
 * 在微信开发者工具(云环境)里走真实链路：
 *   本地图片 → base64 → 写入模拟器临时文件 → wx.cloud.uploadFile 上传云存储
 *   → 调用 ocrScreenshot（持仓导入） / ocrTransaction（交易导入）→ 打印返回值
 *
 * 前置：微信开发者工具已启动并开启自动化端口 9420：
 *   cli auto --project /Users/liubangwe/WeChatProjects/fund-estimator
 *
 * 用法：
 *   node scripts/ocr-import-test.js
 */
const automator = require("miniprogram-automator");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECT_PATH = "/Users/liubangwe/WeChatProjects/fund-estimator";
const MOCK_DIR = path.join(PROJECT_PATH, "pic", "mock");

// 自动探测 devtools automation WebSocket 端口：
//  1) 优先读 devtools 会话目录的 .cli / .ide（记录 automation 端口）
//  2) 否则扫描常见端口段
//  优先级: 环境变量 OCR_WS_PORT > .io 标记 > 常见端口
const DEVTOOLS_DIR = path.join(
  os.homedir(),
  "Library", "Application Support", "微信开发者工具",
  "d1e8765721a6c23d43b14c95b1843e6b", "Default"
);

function readMarker(name) {
  try { return fs.readFileSync(path.join(DEVTOOLS_DIR, name), "utf8").trim(); }
  catch (e) { return ""; }
}

function guessWsEndpoint() {
  // 环境变量最高优先
  if (process.env.OCR_WS_PORT) {
    return { port: process.env.OCR_WS_PORT, src: "OCR_WS_PORT" };
  }
  // devtools automation 端口通常记录在 .cli（内容为端口号）
  const cli = readMarker(".cli");
  if (cli && /^\d+$/.test(cli)) {
    return { port: cli, src: ".cli" };
  }
  const ide = readMarker(".ide");
  if (ide && /^\d+$/.test(ide)) {
    return { port: ide, src: ".ide" };
  }
  return { port: "9420", src: "default" };
}

async function connectWithRetry(mp) {
  const guess = guessWsEndpoint();
  const candidates = [guess.port, "9420"].filter((p, i, arr) => arr.indexOf(p) === i);
  const errors = [];
  for (const port of candidates) {
    const endpoint = `ws://127.0.0.1:${port}`;
    try {
      const attached = await automator.connect({ wsEndpoint: endpoint, projectPath: PROJECT_PATH });
      console.log(`✅ 已连接 automation WS: ${endpoint}  (来源: ${guess.src})`);
      return attached;
    } catch (e) {
      errors.push(`${endpoint}: ${e.message.split(",")[0]}`);
    }
  }
  console.error(`❌ 无法连接 devtools automation（尝试过: ${errors.join(" | ")}）`);
  console.error("   请确认：微信开发者工具已打开本项目，且已开启「设置-安全-服务端口」，并已运行: cli auto --project . --auto-port 9420");
  process.exit(1);
}

// 每张图标注入参：path → { fn, desc }
//   持仓导入 add-holding → ocrScreenshot
//   交易导入 adjust-holding → ocrTransaction
const CASES = [
  { file: "IMG_0558.PNG", fn: "ocrScreenshot", desc: "天天基金·持仓列表页(3只)" },
  { file: "IMG_0559.PNG", fn: "ocrTransaction", desc: "天天基金·交易查询页(4条买入)" },
  { file: "IMG_0560.jpg", fn: "ocrScreenshot", desc: "理财通·产品列表页(单基金)" },
  { file: "IMG_0561.PNG", fn: "ocrScreenshot", desc: "理财通·单基金详情页" },
];

function toBase64(filePath) {
  return fs.readFileSync(filePath).toString("base64");
}

// 在模拟器上下文：写临时文件 + 上传云存储，返回 fileID
function uploadToCloud(mp, base64, ext) {
  const data = { base64, ext };
  return mp.evaluate((d) => new Promise((resolve) => {
    const fsys = wx.getFileSystemManager();
    const tmpPath = `${wx.env.USER_DATA_PATH}/ocr_test_${Date.now()}.${d.ext}`;
    // 写文件
    fsys.writeFile({
      filePath: tmpPath,
      data: d.base64,
      encoding: "base64",
      success: () => {
        wx.cloud.uploadFile({
          cloudPath: `ocr_test_${Date.now()}.${d.ext}`,
          filePath: tmpPath,
          success: (up) => resolve({ ok: true, fileID: up.fileID }),
          fail: (e) => resolve({ ok: false, err: (e && e.errMsg) || "uploadFail", stage: "upload" }),
        });
      },
      fail: (e) => resolve({ ok: false, err: (e && e.errMsg) || "writeFail", stage: "write" }),
    });
  }), data);
}

// 在模拟器上下文：调用指定云函数
function callCloud(mp, name, data) {
  return mp.evaluate((fnName, fnData) => new Promise((resolve) => {
    wx.cloud.callFunction({
      name: fnName,
      data: fnData || {},
      success: (r) => resolve({ ok: true, result: r.result }),
      fail: (e) => resolve({ ok: false, err: (e && e.errMsg) || "callFail" }),
    });
  }), name, data || {});
}

async function main() {
  console.log("🚀 连接微信开发者工具自动化...");
  const mp = await connectWithRetry();
  console.log("✅ 已连接，reLaunch 到首页保证云环境就绪...");
  await mp.reLaunch("/pages/index/index");
  await new Promise((r) => setTimeout(r, 2500));
  console.log("");

  for (const c of CASES) {
    const filePath = path.join(MOCK_DIR, c.file);
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  跳过 ${c.file}（不存在: ${filePath}）`);
      continue;
    }
    const base64 = toBase64(filePath);
    const ext = path.extname(c.file).replace(".", "");
    console.log(`\n========== ${c.desc}  [${c.file}] → ${c.fn} ==========`);

    // 1) 上传云存储拿 fileID
    const up = await uploadToCloud(mp, base64, ext);
    if (!up.ok) {
      console.log("  ❌ 上传失败:", up.err, "(stage:", up.stage + ")");
      continue;
    }
    console.log("  ✅ 已上传 fileID:", up.fileID);

    // 2) 调 OCR 云函数
    const r = await callCloud(mp, c.fn, { fileID: up.fileID });
    if (!r.ok) {
      console.log("  ❌ 云函数调用失败:", r.err);
      continue;
    }
    const out = JSON.stringify(r.result);
    console.log("  ── 返回 ──");
    console.log(out.length > 1600 ? out.slice(0, 1600) + "…" : out);

    // 3) 简单结构摘要
    const res = r.result || {};
    const data = res.data || {};
    if (res.code === 0) {
      if (c.fn === "ocrScreenshot") {
        const h = data.holdings || [];
        console.log(`  ── 摘要: code=${res.code} type=${data.type || "-"} method=${data.method || "-"} 持仓数=${h.length}`);
        h.forEach((x, i) => console.log(`    [${i}] ${x.fundName || "?"} | code=${x.fundCode || "?"} | 市值=${x.marketValue || "?"} | 收益=${x.holdingReturn || "?"}`));
      } else {
        const t = data.transactions || [];
        console.log(`  ── 摘要: code=${res.code} method=${data.method || "-"} 交易数=${t.length}`);
        t.forEach((x, i) => console.log(`    [${i}] ${x.fundName || "?"} | ${x.action || x.type || "?"} | ${x.buyAmount || x.amount || "?"} | ${x.buyPrice || x.price || "?"} | ${x.shares || "?"}`));
      }
    } else {
      console.log(`  ── 非 0 code=${res.code} msg=${res.msg || "-"}`);
    }
  }

  console.log("\n🏁 全部测试完成，关闭连接...");
  await mp.close();
}

main().catch((e) => {
  console.error("❌ 脚本失败:", e.message);
  process.exit(1);
});
