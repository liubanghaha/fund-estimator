const APP_VERSION = '2.0.0';

const CHANGELOG = [
  {
    version: '2.0.0',
    date: '2026-06-21',
    items: [
      '🎨 新增红蓝主题切换，用户中心一键换肤',
      '🌡️ 基金估值温度：52周价格区间加权计算，低估/正常/高估一列看清',
      '📊 资产分析：持仓穿透、健康分、重合度一页打尽',
      '📉 风险指标：最大回撤、年化波动率、夏普比率',
      '💸 费用黑洞：管理费托管费长期侵蚀对比',
      '💯 持仓健康分：估值温度+行业集中度加权评分',
      '🔔 止盈止损提醒：自定义阈值，触发顶部通知条',
      '🔗 持仓重合度：多基金重仓同一股票穿透分析',
      '💰 定投模拟：历史数据回测定投收益',
      '📋 列表头支持长按拖拽排序',
      '📈 自选分组管理、盘中实时轮询',
      '🔔 收益走势页支持日/月/年日历视图',
      '📱 指数栏收缩/展开样式统一为卡片',
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
