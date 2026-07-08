const APP_VERSION = (() => {
  try { return wx.getAccountInfoSync().miniProgram.version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

const CHANGELOG = [
  {
    version: '2.3.0',
    date: '2026-07-08',
    items: [
      '📈 收益走势新增当天实时折线对比图，组合收益 vs 大盘指数',
      '⚡ 数据缓存策略优化，加载速度大幅提升',
      '📊 收益率计算统一修正，数据展示更加精准',
      '🎨 走势图交互与样式优化，体验更流畅',
    ]
  },
  {
    version: '2.2.0',
    date: '2026-07-05',
    items: [
      '📤 持仓卡片分享，一键生成精美卡片分享给好友',
      '📝 操作笔记，调整份额时可记录理由，事后回顾决策',
      '📉 走势图新增动态回撤曲线，直观展示最大回落',
      '🔔 PE估值变化提醒，估值档位切换时主动通知',
      '✏️ 编辑页调整份额，支持快速操作并自动更新成本',
      '💰 基金换手率展示，量化交易频率对净值的影响',
      '📷 优化若干功能，体验更流畅',
    ]
  }
];

// 全局弹窗：在任意页面可调用 wx.showChangelog() 弹出更新日志
wx.showChangelog = function () {
  const app = getApp();
  if (!app || !app.globalData._pendingChangelog) return;
  const changelog = app.globalData._pendingChangelog;
  const items = changelog.items.map(i => i + '\n').join('');
  wx.showModal({
    title: `🎉 新版本更新 ${changelog.version}`,
    content: `${changelog.date}\n\n${items}`,
    confirmText: '知道了',
    showCancel: false,
    success: () => { app.markChangelogRead(); },
  });
};

App({
  onLaunch: function () {
    if (wx.cloud) {
      try {
        wx.cloud.init({
          env: "cloudbase-d0gug00io7bfedd97",
          traceUser: true,
        });
      } catch (e) {
        console.error("云开发初始化失败:", e);
      }
    }
    this.globalData = { _ocrFunds: null, _screenshotPath: null };

    // 版本更新检测
    const lastVersion = wx.getStorageSync('appVersion') || '';
    if (lastVersion !== APP_VERSION && CHANGELOG.length > 0) {
      this.globalData._pendingChangelog = CHANGELOG.find(c => c.version === APP_VERSION) || CHANGELOG[CHANGELOG.length - 1];
    }
  },

  markChangelogRead: function () {
    wx.setStorageSync('appVersion', APP_VERSION);
    this.globalData._pendingChangelog = null;
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
