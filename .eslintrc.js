// ESLint 配置（2026-11-09 L-01）：核心目标是 no-undef——
// 2026-11-08~09 连续 3 个线上 bug（ev 未定义 / todayKey 作用域 / totalRatio 残留）
// 全部会被 no-undef 拦住。发版前必跑：npm run lint
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,      // cloudfunctions/ 与 scripts/ 是 Node 环境（require/Buffer/console/module）
    commonjs: true,
  },
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  globals: {
    // 小程序全局对象（客户端页面）
    wx: "readonly",
    App: "readonly",
    Page: "readonly",
    Component: "readonly",
    Behavior: "readonly",
    getApp: "readonly",
    getCurrentPages: "readonly",
    CloudID: "readonly",
  },
  rules: {
    "no-undef": "error",
    "no-redeclare": "error",
    "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
  },
  ignorePatterns: ["node_modules/", "miniprogram/node_modules/", "cloudfunctions/*/node_modules/", "scripts/node_modules/", ".tmp/", "web/", "*.min.js", "web/dist/"],
  overrides: [
    // 客户端页面：wx 等是小程序全局，但不是 Node 环境（去掉 node env 的 require 宽容也行——
    // 页面里确实用 require/module，所以保留 commonjs）
    {
      files: ["miniprogram/**/*.js"],
      globals: { wx: "readonly" },
    },
    // 云函数：wx 不是全局（防御式禁用），cloud 由 wx-server-sdk require 而来（合法变量）
    {
      files: ["cloudfunctions/**/*.js"],
      globals: { wx: "off" },
    },
    // 测试：Node 环境
    {
      files: ["test/**/*.js"],
      env: { node: true },
    },
    {
      files: ["scripts/**/*.js"],
      env: { node: true },
    },
  ],
};
