App({
  onLaunch: function () {
    if (wx.cloud) {
      wx.cloud.init({
        env: "cloudbase-d0gug00io7bfedd97",
        traceUser: true,
      });
    }
    this.globalData = { _ocrFunds: null, _screenshotPath: null, _syncTradeFund: null };
  },
});
