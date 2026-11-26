const api = require('../../utils/api');
const booking = require('../../utils/booking');

const statusLabels = { HOLD: '待确认合同', EXPIRED: '暂留已过期', CONFIRMED: '已确认 · 待备货', READY: '装备已备妥',
  ACTIVE: '租赁中', REVIEW: '受损鉴定中', SETTLEMENT: '待补差', COMPLETED: '已完成', CANCELLED: '已取消' };
const stepLabels = { DONE: '已完成', CURRENT: '当前', WAITING: '待处理', SKIPPED: '跳过' };
const damageGrades = { NONE: '无损 / 正常磨损', MINOR: '轻微受损', MODERATE: '中度受损',
  SEVERE: '严重受损', TOTAL_LOSS: '无法修复' };
const damageStages = { DRAFT: '待鉴定', SUBMITTED: '已反馈 · 待经理复核',
  RETURNED: '退回补充证据', APPROVED: '经理已复核' };

const modalError = error => wx.showModal({ title: '操作未完成', content: error.message || '请重试', showCancel: false });
const confirm = (title, content) => new Promise(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm), fail: () => resolve(false) }));

Page({
  data: { id: 0, loading: true, acting: false, order: null, error: '', statusLabel: '', steps: [],
    contract: null, showContract: false, contractRead: false, contractAccepted: false, signedName: '',
    canCancel: false, canPay: false, canIssue: false, canSign: false, pickupText: '', returnText: '',
    prepEvents: [], damageCases: [], damageContacts: [], wechatMode: api.isWechatShowcase() },
  onLoad(options) { this.setData({ id: Number(options.id) || 0 }); },
  async onShow() { if (this.data.id) await this.refresh(); },
  async onPullDownRefresh() { await this.refresh(); wx.stopPullDownRefresh(); },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const order = await api.request(`/api/reservations/${this.data.id}`);
      const contract = order.contracts?.[0] || null;
      this.setData({ order, contract, statusLabel: statusLabels[order.status] || order.status,
        pickupText: booking.formatOslo(order.pickup_at), returnText: booking.formatOslo(order.return_at),
        steps: (order.workflow?.steps || []).map(step => ({ ...step, statusText: stepLabels[step.status] || step.status,
          timeText: step.at ? booking.formatOslo(step.at) : step.dueAt ? `期限 ${booking.formatOslo(step.dueAt)}` : '' })),
        prepEvents: (order.preparation?.events || []).map(event => ({ ...event, timeText: booking.formatOslo(event.created_at) })),
        damageCases: (order.damage?.cases || []).map(damage => ({ ...damage,
          gradeLabel: damageGrades[damage.grade] || '待鉴定',
          statusLabel: damageStages[damage.status] || damage.status,
          photoCount: damage.photos?.length || 0,
          photos: (damage.photos || []).map(photo => ({
            id: photo.id, part: photo.part || '受损部位', caption: photo.caption || '鉴定照片'
          })),
          dueText: damage.feedback_due_at ? booking.formatOslo(damage.feedback_due_at) : '待分派',
          feedbackText: damage.first_feedback_at ? booking.formatOslo(damage.first_feedback_at) : '',
          reviewText: damage.approved_at ? booking.formatOslo(damage.approved_at) : '' })),
        damageContacts: (order.damage?.contacts || []).map(contact => ({ ...contact,
          timeText: booking.formatOslo(contact.created_at),
          outcomeText: { REACHED: '已联系', NO_ANSWER: '暂未接通', DISPUTED: '顾客有异议' }[contact.outcome]
            || contact.outcome })),
        canCancel: ['HOLD', 'CONFIRMED', 'READY'].includes(order.status),
        canIssue: order.status === 'HOLD' && !contract,
        canSign: order.status === 'HOLD' && !!contract && !contract.signed_at,
        canPay: order.status === 'HOLD' && !!contract?.signed_at });
    } catch (error) { this.setData({ error: error.message, order: null }); }
    finally { this.setData({ loading: false }); }
  },

  async onIssueContract() {
    if (this.data.acting) return;
    this.setData({ acting: true });
    try { await api.request(`/api/reservations/${this.data.id}/contracts`, 'POST'); await this.refresh(); this.openContract(); }
    catch (error) { modalError(error); }
    finally { this.setData({ acting: false }); }
  },
  openContract() { if (this.data.contract) this.setData({ showContract: true, contractRead: false, contractAccepted: false,
    signedName: getApp().globalData.user?.name || '' }); },
  closeContract() { this.setData({ showContract: false }); },
  onContractBottom() { this.setData({ contractRead: true }); },
  onContractAccepted(event) { this.setData({ contractAccepted: this.data.contractRead && event.detail.value.includes('yes') }); },
  onSignedName(event) { this.setData({ signedName: event.detail.value }); },
  async onSignContract() {
    if (this.data.acting || !this.data.canSign) return;
    if (!this.data.contractRead || !this.data.contractAccepted) return modalError(new Error('请完整阅读当前合同并主动勾选确认'));
    if (this.data.signedName.trim().length < 2) return modalError(new Error('请填写至少两个字的确认姓名'));
    this.setData({ acting: true });
    try {
      await api.request(`/api/contracts/${this.data.contract.id}/sign`, 'POST',
        { accepted: true, snapshotHash: this.data.contract.snapshot_hash, name: this.data.signedName.trim() });
      this.closeContract(); await this.refresh();
    } catch (error) { modalError(error); }
    finally { this.setData({ acting: false }); }
  },
  async onDemoPay() {
    if (this.data.acting || !this.data.canPay) return;
    if (!await confirm('确认演示付款', api.isWechatShowcase()
      ? '此操作只在合成预览中记录模拟支付，不发生真实扣款。确认后门店开始准备装备。'
      : '此操作只在本机记录模拟支付，不发生真实扣款。确认后门店开始准备装备。')) return;
    this.setData({ acting: true });
    try { await api.request(`/api/reservations/${this.data.id}/pay`, 'POST'); await this.refresh(); }
    catch (error) { modalError(error); }
    finally { this.setData({ acting: false }); }
  },
  async onPreviewDamagePhoto(event) {
    if (this.data.acting) return;
    const photoId = Number(event.currentTarget?.dataset?.photoId);
    if (!Number.isSafeInteger(photoId) || photoId <= 0) return modalError(new Error('照片编号无效'));
    this.setData({ acting: true });
    try {
      const localPath = await api.downloadDamagePhoto(photoId);
      if (!api.canPreviewDamagePhoto(localPath)) throw new Error('登录状态已变化，请重新打开订单后查看照片');
      await new Promise((resolve, reject) => wx.previewImage({
        current: localPath, urls: [localPath], success: resolve, fail: reject
      }));
    } catch (error) { modalError(error); }
    finally { this.setData({ acting: false }); }
  },
  async onCancel() {
    if (this.data.acting || !this.data.canCancel) return;
    if (!await confirm('取消预约', '取消规则以当前订单快照为准；已发生的金额均为本机模拟记录。确认取消吗？')) return;
    this.setData({ acting: true });
    try { await api.request(`/api/reservations/${this.data.id}/cancel`, 'POST'); await this.refresh(); }
    catch (error) { modalError(error); }
    finally { this.setData({ acting: false }); }
  }
});
