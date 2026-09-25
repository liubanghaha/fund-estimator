const automator = require("miniprogram-automator");
const ports = [46073, 20368, 32123, 59270, 9420];
(async () => {
  for (const port of ports) {
    let r = { port };
    try {
      const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
      r.ok = true;
      const v = await mp.version().catch(e=>"verErr");
      r.ver = v;
      console.log(port, "CONNECT-OK", JSON.stringify(r));
      // 只断连接，不要用 mp.close()：它的实现是 App.exit + Tool.close（= 关掉开发者工具本身），
      // 探连接把工具关掉过好几次，改成 disconnect()
      mp.disconnect();
      return;
    } catch (e) {
      r.err = e.message.split(",")[0];
      console.log(port, "fail", r.err.slice(0,60));
    }
  }
})();
