const { listMyAssessments, listApprovedCounselors, updateAssessment } = require('../../utils/api');
const config = require('../../utils/config');
const { buildCounselorMatches, buildReferralAdvice } = require('../../utils/matching');

Page({
  data: {
    loading: true,
    assessments: [],
    last_refreshed_text: ''
  },

  onShow() {
    this.load();
    this.startAutoRefresh();
  },

  onHide() {
    this.stopAutoRefresh();
  },

  onUnload() {
    this.stopAutoRefresh();
  },

  onPullDownRefresh() {
    this.load().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      this.load({ silent: true });
    }, 3000);
  },

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  },

  statusText(status) {
    const map = {
      pending: '待处理',
      approved: '已通过',
      rejected: '已拒绝',
      contacted: '已联系'
    };
    return map[status] || '未申请';
  },

  load(options = {}) {
    const app = getApp();
    let currentVisitor = null;
    if (!options.silent) this.setData({ loading: true });
    return app.ensureVisitor().then((visitor) => {
      currentVisitor = visitor;
      return Promise.all([
        listMyAssessments(visitor.openid),
        listApprovedCounselors()
      ]);
    }).then((rows) => {
      const assessmentsRows = rows[0] || [];
      const counselors = rows[1] || [];
      const assessments = assessmentsRows.map((item) => ({
        ...item,
        assessment_no: item.id ? item.id.slice(0, 8) : '',
        created_at_text: item.created_at ? item.created_at.slice(0, 10) : '',
        status_text: this.statusText(item.match_request_status),
        can_apply_demo: !item.match_request_cid,
        referral_advice_cards: buildReferralAdvice(item).cards,
        recommended_counselors: !item.match_request_cid ? buildCounselorMatches(item, counselors, 2) : []
      }));
      this.currentVisitor = currentVisitor;
      const now = new Date();
      const timeText = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      this.setData({ assessments, last_refreshed_text: timeText });
    }).catch((err) => {
      if (!options.silent) {
        wx.showModal({ title: '加载失败', content: err.message || '请稍后重试', showCancel: false });
      }
    }).finally(() => {
      if (!options.silent) this.setData({ loading: false });
    });
  },

  openPcoms(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/pcoms/index?aid=${id}` });
  },

  applyDemoCounselor(e) {
    const id = e.currentTarget.dataset.id;
    const counselorId = e.currentTarget.dataset.cid || config.localDemoCounselorId;
    const counselorName = e.currentTarget.dataset.name || config.localDemoCounselorName || '本地演示咨询师';
    const item = (this.data.assessments || []).find((a) => a.id === id);
    if (!item || !counselorId) return;
    const visitor = this.currentVisitor || {};

    wx.showLoading({ title: '提交申请...' });
    updateAssessment(id, {
      match_request_name: item.visitor_name || '微信来访者',
      match_request_contact: visitor.openid || item.visitor_openid || config.devOpenid,
      match_request_cid: counselorId,
      match_request_status: 'pending',
      selected_counselor_id: counselorId,
      selected_counselor_name: counselorName,
      selected_at: new Date().toISOString()
    }).then(() => {
      wx.showToast({ title: '已提交申请', icon: 'success' });
      this.load();
    }).catch((err) => {
      wx.showModal({ title: '申请失败', content: err.message || '请稍后重试', showCancel: false });
    }).finally(() => {
      wx.hideLoading();
    });
  }
});
