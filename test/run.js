"use strict";
// 测试入口：node test/run.js —— 零依赖跑全部用例，失败退出码 1（可接 CI/发布前门禁）
const { setFile, summary } = require("./helpers");

const files = ["calculator.test.js", "fund-data.test.js"];
files.forEach((f) => {
  setFile(f);
  require("./" + f);
});
process.exitCode = summary() > 0 ? 1 : 0;
