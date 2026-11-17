const { submitAppointmentFeedback } = require('../../utils/api');

Page({
  data: { assessmentId: '', appointmentId: '', amount: '', feedback: '', submitting: false },
  onLoad(query) { this.setData({ assessmentId: query.aid || '', appointmentId: query.appointment || '' }); },
  changeAmount(e) { this.setData({ amount: e.detail.value }); },
  changeFeedback(e) { this.setData({ feedback: e.detail.value }); },
  submit() {
    const amount = Number(this.data.amount);
    if (!Number.isFinite(amount) || amount < 0) return wx.showModal({ title: '请填写金额', content: '请输入双方需确认的实际已付金额。', showCancel: false });
    this.setData({ submitting: true });
    submitAppointmentFeedback(this.data.assessmentId, this.data.appointmentId, amount, this.data.feedback).then((result) => {
      wx.showModal({ title: '反馈已提交', content: result.amount_confirmed ? '双方金额已确认，流程完成。' : '等待对方提交反馈并确认相同金额。', showCancel: false, success: () => wx.navigateBack() });
    }).catch((error) => wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false }))
      .finally(() => this.setData({ submitting: false }));
  }
});
