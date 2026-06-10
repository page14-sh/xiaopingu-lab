const { miniLogin } = require('./utils/api');

App({
  globalData: {
    visitor: null
  },

  onLaunch() {
    this.ensureVisitor();
  },

  ensureVisitor() {
    if (this.globalData.visitor) {
      return Promise.resolve(this.globalData.visitor);
    }

    const cached = wx.getStorageSync('xpg_visitor');
    if (cached && cached.openid) {
      this.globalData.visitor = cached;
      return Promise.resolve(cached);
    }

    return miniLogin().then((visitor) => {
      this.globalData.visitor = visitor;
      wx.setStorageSync('xpg_visitor', visitor);
      return visitor;
    });
  }
});
