App({
  onLaunch: function () {
    if (wx.cloud) {
      wx.cloud.init({
        env: "cloudbase-d0gug00io7bfedd97",
        traceUser: true,
      });
    }
    this.globalData = {};
  },
});
