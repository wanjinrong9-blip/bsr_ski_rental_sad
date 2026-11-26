const api = require('../../utils/api');
const booking = require('../../utils/booking');

const labels = { HOLD: '待确认合同', EXPIRED: '暂留已过期', CONFIRMED: '已确认 · 待备货', READY: '装备已备妥',
  ACTIVE: '租赁中', REVIEW: '受损鉴定中', SETTLEMENT: '待补差', COMPLETED: '已完成', CANCELLED: '已取消' };

Page({
  data: { loading: true, user: null, orders: [], error: '' },

  async onShow() {
    try { await this.load(); } catch (error) { this.setData({ error: error.message }); }
  },
  async onPullDownRefresh() {
    try { await this.load(); } catch (error) { this.setData({ error: error.message }); }
    finally { wx.stopPullDownRefresh(); }
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const boot = await getApp().ensureBootstrap(true);
      const user = boot.user?.role === 'customer' ? boot.user : null;
      this.setData({ user });
      if (!user) return this.setData({ orders: [] });
      const rows = await api.request('/api/reservations');
      this.setData({ orders: rows.map(row => ({ ...row, statusLabel: labels[row.status] || row.status,
        pickupText: booking.formatOslo(row.pickup_at), returnText: booking.formatOslo(row.return_at),
        prepLabel: row.preparation?.label || '等待后续流程' })) });
    } finally { this.setData({ loading: false }); }
  },
  goAccount() { wx.switchTab({ url: '/pages/account/index' }); },
  goCatalog() { wx.switchTab({ url: '/pages/catalog/index' }); },
  openOrder(event) { wx.navigateTo({ url: `/pages/order-detail/index?id=${Number(event.currentTarget.dataset.id)}` }); }
});
