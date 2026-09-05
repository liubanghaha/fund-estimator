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
      await mp.close().catch(()=>{});
      return;
    } catch (e) {
      r.err = e.message.split(",")[0];
      console.log(port, "fail", r.err.slice(0,60));
    }
  }
})();
