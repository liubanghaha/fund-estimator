const APP_VERSION = (() => {
  try { return wx.getAccountInfoSync().miniProgram.version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

const track = require("./utils/track.js");
const api = require("./utils/api");

// 更新日志：数组第 0 条即「当前版本」——版本日志页只展示 log[0]，升级弹窗按版本号匹配。
// 排序约定：新的在前（按发布日期倒序）；末尾那条 2026-07-08 的 2.3.0 是「老小程序（迁移前 AppID）」的历史记录，非本小程序版本。
const CHANGELOG = [
  {
    version: '2.4.0',
    date: '2026-09-17',
    items: [
      '🏦 持仓支持多账户：同一只基金分平台各记各的，「全部」自动合并',
      '📸 截图导入可选账户，识别不确定的基金标「待确认」',
      '🌍 行情页新增指数期货 / 黄金原油 / 汇率，指数支持港美欧亚四组',
      '🔔 提醒修复：推送额度可见可补，额度不足时优先保提醒',
      '📌 首页顶部固定只滚列表；快捷操作收进悬浮按钮',
      '🛠 解决已知问题，优化相关体验',
    ]
  },
  {
    version: '2.3.0',
    date: '2026-09-13',
    items: [
      '📊 行情页回归：港美股指数 + 你的重仓股实时行情',
      '💸 资产分析新增「费用与复盘」：持有费用与卖出后的走势对比',
      '📈 收益页新增周期复盘，一键生成周签 / 月签 / 年签',
      '🔍 我的页新增持仓体检与提醒管理；加减仓可记录操作心情',
      '🔎 基金详情新增同类排名；卖出时提示持有天数与赎回费',
      '🛠 解决已知问题，优化相关体验',
    ]
  },
  {
    version: '2.2.0',
    date: '2026-09-10',
    items: [
      '📈 走势图接入绘制动画：曲线从左往右画出（当天、周月年、净值走势、基金对比）',
      '📊 实时估值支持切换数据源（我的页→数据源）：数据源一 新浪实时估值 / 数据源二 自主估算',
      '🔔 收盘播报改为当日净值确认后通知，收益更准确',
      '🛠 解决已知问题，优化相关体验',
    ]
  },
  {
    version: '2.1.0',
    date: '2026-09-08',
    items: [
      '📊 实时估值支持切换数据源（我的页→数据源）：数据源一 新浪实时估值 / 数据源二 自主估算',
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
  },
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
    this.ensureLogin(); // 静默取 openid，各页开场即可用，用户无登录步骤
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

  // 全局异常上报（此前线上 JS 异常完全失明）：走统一埋点链路，静默不阻塞
  onError: function (msg) {
    try {
      track.track("js_error", { msg: String(msg).slice(0, 500) });
    } catch (e) { /* ignore */ }
  },

  onUnhandledRejection: function (res) {
    try {
      const r = res && res.reason;
      const msg = r && r.message ? r.message : String(r);
      track.track("js_error", { msg: ("unhandledrejection: " + msg).slice(0, 500) });
    } catch (e) { /* ignore */ }
  },

  onPageNotFound: function (res) {
    // 深链失效兜底：回首页
    try {
      track.track("page_not_found", { path: String((res && res.path) || "").slice(0, 120) });
    } catch (e) { /* ignore */ }
    wx.switchTab({ url: "/pages/index/index" });
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

  // 静默登录：openid 由云函数从微信调用上下文直接返回，不弹任何授权、不需要用户操作。
  // 因此「登录」不再是用户可见的步骤——打开小程序即可浏览，数据自动归属到本人微信账号。
  // 只在首次（或本地缓存被清）时真的发一次请求，之后走本地缓存；失败会清掉在途标记，下次进页面自动重试。
  ensureLogin: function () {
    // 本地已有 openid 即视为就绪（storage 是唯一真源，重装/清缓存后自然走下面的重新获取）
    try {
      const cached = wx.getStorageSync("userInfo");
      if (cached && cached.loggedIn && cached.openid) return Promise.resolve(true);
    } catch (e) { /* ignore */ }
    // 在途请求去重：多页同时开场只发一次；落地即清标记（结果一律以 storage 为准），
    // 避免把一次失败/旧结果缓存住 —— 判定口径只有 storage 一处。
    if (this._loginPromise) return this._loginPromise;
    const p = api.userLogin().then((res) => {
      const r = (res && res.result) || {};
      if (r.code !== 0 || !r.data || !r.data.openid) return false;
      // 合并写入：昵称/头像等本地资料不能被覆盖
      const prev = wx.getStorageSync("userInfo") || {};
      wx.setStorageSync("userInfo", Object.assign({}, prev, { loggedIn: true, openid: r.data.openid }));
      return true;
    }).catch(() => false);
    this._loginPromise = p;
    const clear = () => { if (this._loginPromise === p) this._loginPromise = null; };
    p.then(clear, clear);
    return p;
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
