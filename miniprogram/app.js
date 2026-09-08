const APP_VERSION = (() => {
  try { return wx.getAccountInfoSync().miniProgram.version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

const track = require("./utils/track.js");

const CHANGELOG = [
  {
    version: '2.1.0',
    date: '2026-09-08',
    items: [
      '📊 实时估值支持切换数据源（我的页→数据源）：官方估值 / 自主估算',
      '🔔 收盘播报改为当日净值确认后通知，收益更准确',
      '📈 行情页盘中每 30 秒自动刷新',
      '🛠 解决已知问题，优化相关体验',
    ]
  },
  {
    version: '2.0.0',
    date: '2026-09-06',
    items: [
      '📰 新增「资讯」页:财经快讯实时更新,重要消息红标,长新闻点一下展开/收起',
      '📊 行情页行业卡片可以按持仓、涨幅、跌幅排序,点小圆点直接翻页',
      '🛠 解决已知问题，优化相关体验',
    ]
  },
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
    this._handlePushEntry(options, "cold");
    this._trackLaunch();
    // 统一埋点（P0-0）：建会话 + 接回未发完队列，2s 后补发避开冷启动关键路径
    track.init();
  },

  onHide: function () {
    // 退后台立刻落库，避免进程被杀丢批
    track.flush();
  },

  onShow: function (options) {
    // 推送热启动落地（冷启动走 onLaunch）
    this._handlePushEntry(options, "warm");
  },

  // 推送落地追踪：所有推送 page 带 src=push&lid=日志ID，补 openedAt 供打开率统计
  // （服务端 openedAt 是打开率权威口径；客户端 push_open 只补落地上下文，供召回实验归因）
  _handlePushEntry: function (options, entry) {
    try {
      if (options && options.src === "push" && options.lid) {
        require("./utils/subscribe.js").bindTrackOpen(options.lid);
        try {
          track.pushOpen({
            lid: String(options.lid).slice(0, 40),
            entry: entry || "cold",
            path: (options && options.path) || "",
          });
        } catch (e) { /* 埋点失败不提示 */ }
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
