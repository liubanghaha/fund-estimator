const APP_VERSION = '2.0.0';

const CHANGELOG = [
  {
    version: '2.0.0',
    date: '2026-06-21',
    items: [
      '🎨 新增红蓝主题切换，用户中心一键换肤',
      '🌡️ 基金估值温度：52周价格区间加权计算，低估/正常/高估一列看清',
      '📊 持仓穿透：行业分布与集中度预警',
      '💰 定投模拟：历史数据回测定投收益',
      '📋 列表头支持长按拖拽排序',
      '📈 自选分组管理、盘中实时轮询',
      '🔔 收益走势页支持日/月/年日历视图',
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
    this.globalData = { _ocrFunds: null, _screenshotPath: null, _syncTradeFund: null };

    // 版本更新检测
    const lastVersion = wx.getStorageSync('appVersion') || '';
    if (lastVersion !== APP_VERSION && CHANGELOG.length > 0) {
      this.globalData._pendingChangelog = CHANGELOG.find(c => c.version === APP_VERSION) || CHANGELOG[0];
    }
  },

  markChangelogRead: function () {
    wx.setStorageSync('appVersion', APP_VERSION);
    this.globalData._pendingChangelog = null;
  },

  getVersion: function () {
    return APP_VERSION;
  },
  getChangelog: function () {
    return CHANGELOG;
  }
});
