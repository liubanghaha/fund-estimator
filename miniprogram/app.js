const APP_VERSION = (() => {
  try { return wx.getAccountInfoSync().miniProgram.version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

const CHANGELOG = [
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
