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
    await mp.close().catch(()=>{});
  } catch (e) {
    console.log("LAUNCH FAIL:", e.message);
  }
})();
