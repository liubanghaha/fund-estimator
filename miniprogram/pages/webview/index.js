Page({
  data: { url: '' },

  onLoad(options) {
    // 从页面参数构建 H5 URL
    const baseUrl = options.base || 'https://your-domain.tcloudbaseapp.com';
    const page = options.page || 'fund-detail.html';
    const params = [];
    // 透传所有参数（排除 base 和 page）
    Object.keys(options).forEach(k => {
      if (k === 'base' || k === 'page') return;
      params.push(encodeURIComponent(k) + '=' + encodeURIComponent(options[k]));
    });
    const url = baseUrl + '/' + page + (params.length ? '?' + params.join('&') : '');
    console.log('[webview] navigating to:', url);
    this.setData({ url });
  },

  onMessage(e) {
    console.log('[webview] message:', e.detail);
  },

  onError(e) {
    console.error('[webview] error:', e.detail);
    wx.showToast({ title: '页面加载失败', icon: 'none' });
  },

  onLoad() {
    // web-view load success
  }
});
