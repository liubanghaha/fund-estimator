const APP_VERSION = (() => {
  try { return wx.getAccountInfoSync().miniProgram.version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

const CHANGELOG = [
  {
    version: '1.0.5',
    date: '2026-08-30',
    items: [
      '每日收盘与晚间数据播报（需订阅，可随时关闭）',
      '涨跌与温度变化提醒，阈值自行设置',
      '每周数据小结',
      '持仓新增占比、距一年高点参考列',
      '盈亏日历支持按周查看',
    ]
  },
  {
    version: '2.3.0',
    date: '2026-07-08',
    items: [
      '📈 新增当天实时对比图，随时掌握变化趋势',
      '⚡ 性能优化，加载更快体验更流畅',
      '🔧 修复若干问题，展示更合理',
    ]
  }
];

App({
  onLaunch: function (options) {
    if (wx.cloud) {
      try {
        wx.cloud.init({
          env: "cloud1-d7gu9zv3i796839b8",
          traceUser: true,
        });
      } catch (e) {
        console.error("云开发初始化失败:", e);
      }
    }
    this.globalData = { _ocrFunds: null, _screenshotPath: null };
    this._handlePushEntry(options);
    this._trackLaunch();
  },

  onShow: function (options) {
    // 推送热启动落地（冷启动走 onLaunch）
    this._handlePushEntry(options);
  },

  // 推送落地追踪：所有推送 page 带 src=push&lid=日志ID，补 openedAt 供打开率统计
  _handlePushEntry: function (options) {
    try {
      if (options && options.src === "push" && options.lid) {
        require("./utils/subscribe.js").bindTrackOpen(options.lid);
      }
    } catch (e) { /* ignore */ }
  },

  // 启动埋点：直连写库不经云函数（不增加冷启动耗时），fire-and-forget 失败静默
  _trackLaunch: function () {
    try {
      const mt = require("./utils/market-time.js");
      wx.cloud.database().collection("analytics_launches").add({
        data: {
          ts: Date.now(),
          date: mt.bjDateStr(),
          phase: mt.marketPhase(),
          isTradingDay: mt.isTradingDay(mt.bjDateStr()),
          version: APP_VERSION
        }
      }).catch(() => {});
    } catch (e) { /* 埋点失败不提示 */ }
  },

  getVersion: function () {
    // 开发环境 fallback 到 changelog 最新版本
    if (APP_VERSION === '0.0.0' || APP_VERSION === 'dev' || !APP_VERSION) {
      return CHANGELOG.length > 0 ? CHANGELOG[0].version : '1.0.0';
    }
    return APP_VERSION;
  },
  getChangelog: function () {
    return CHANGELOG;
  }
});
