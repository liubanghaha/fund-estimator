const automator = require("miniprogram-automator");
(async () => {
  try {
    const mp = await automator.launch({
      projectPath: "/Users/liubangwe/WeChatProjects/fund-estimator",
      cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
      trustProject: true,
      timeout: 60000,
    });
    console.log("LAUNCH OK");
    console.log("version:", await mp.version().catch(e=>"err:"+e.message));
    // 探完只断连接：mp.close() 会连带 Tool.close 把开发者工具关掉（探活脚本不该关工具）
    mp.disconnect();
  } catch (e) {
    console.log("LAUNCH FAIL:", e.message);
  }
})();
