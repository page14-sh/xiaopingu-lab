const { getCounselorAvailability, requestAppointment } = require('../../utils/api');

function monday(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function slotText(value) {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: { loading: true, submitting: false, assessmentId: '', counselorId: '', counselorName: '', weekStart: '', slots: [] },

  onLoad(query) {
    this.setData({ assessmentId: query.aid || '', counselorId: query.cid || '', counselorName: query.name || '咨询师', weekStart: monday() });
    this.load();
  },

  load() {
    const { assessmentId, counselorId, weekStart } = this.data;
    if (!assessmentId || !counselorId) return;
    this.setData({ loading: true });
    Promise.all([getCounselorAvailability(assessmentId, counselorId, weekStart), getCounselorAvailability(assessmentId, counselorId, monday(7))]).then((results) => {
      const from = Date.now(), through = from + 7 * 24 * 60 * 60 * 1000;
      const slots = results.flatMap((result) => result.slots || []).filter((slot) => {
        const at = new Date(slot.start_at).getTime();
        return at >= from && at <= through;
      });
      this.setData({ slots: slots.map((slot) => ({ ...slot, text: `${slotText(slot.start_at)}–${new Date(slot.end_at).toTimeString().slice(0, 5)}` })) });
    }).catch((error) => {
      wx.showModal({ title: '日程加载失败', content: error.message || '请稍后重试', showCancel: false });
    }).finally(() => this.setData({ loading: false }));
  },

  choose(e) {
    if (this.data.submitting || e.currentTarget.dataset.state !== 'available') return;
    const startAt = e.currentTarget.dataset.start;
    wx.showModal({ title: '确认预约', content: `预约 ${e.currentTarget.dataset.text}？提交后等待咨询师确认，双方确认前不会展示详细资料。`, success: (modal) => {
      if (!modal.confirm) return;
      this.setData({ submitting: true });
      requestAppointment(this.data.assessmentId, this.data.counselorId, startAt).then(() => {
        wx.showToast({ title: '已提交，待确认', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 700);
      }).catch((error) => wx.showModal({ title: '预约失败', content: error.message || '该时段可能已被占用', showCancel: false }))
        .finally(() => this.setData({ submitting: false }));
    } });
  }
});
