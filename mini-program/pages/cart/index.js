const api = require('../../utils/api');
const booking = require('../../utils/booking');
const cartSync = require('../../utils/cart-sync');
const { profileIssues } = require('../../utils/customer-profile');

const warn = error => wx.showModal({ title: '请检查预约', content: error.message || '请稍后重试', showCancel: false });
const confirm = (title, content) => new Promise(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm), fail: () => resolve(false) }));

Page({
  data: {
    loading: false, submitting: false, lines: [], quote: null, quoteError: '',
    pickupDate: '', returnDate: '', policy: null, showPolicy: false,
    policyRead: false, accepted: false, skills: ['初级', '中级', '高级', '专家+'], skillIndex: -1,
    user: null, profileIssues: [], loadError: '', checkoutError: '', pending: false, wechatMode: api.isWechatShowcase()
  },

  async onShow() {
    try { await this.load(); } catch (error) { this.setData({ loadError: error.message }); }
  },
  async onPullDownRefresh() {
    try { await this.load(true); } catch (error) { this.setData({ loadError: error.message }); }
    finally { wx.stopPullDownRefresh(); }
  },
  async load(force = false) {
    const app = getApp();
    this.setData({ loading: true, quoteError: '', loadError: '', checkoutError: '' });
    try {
      const boot = await app.ensureBootstrap(force);
      if (api.isWechatShowcase() && !app.globalData.user) {
        this.setData({ lines: [], quote: null, user: null, quoteError: '' });
        return;
      }
      if (app.globalData.user) {
        const user = await api.request('/api/me');
        app.globalData.user = user;
        if (app.globalData.boot) app.globalData.boot.user = user;
        await cartSync.loadRemote(app);
      }
      const window = app.globalData.window;
      const payload = booking.windowPayload(window.storeId, window.pickupDate, window.returnDate);
      const catalog = await api.request(`/api/catalog?storeId=${payload.storeId}&pickupAt=${encodeURIComponent(payload.pickupAt)}&returnAt=${encodeURIComponent(payload.returnAt)}`);
      app.globalData.catalog = catalog;
      const lines = app.globalData.cart.map(line => {
        const product = catalog.items.find(item => Number(item.id) === line.variantId);
        return product ? { ...line, name: product.name, size: product.size, category: product.category, available: product.available,
          dailyNok: product.dailyNok, depositNok: product.depositNok } : { ...line, name: '已下架的装备', size: '请删除', available: 0 };
      });
      this.setData({ lines, pickupDate: window.pickupDate, returnDate: window.returnDate, policy: boot.damagePolicy,
        user: app.globalData.user, profileIssues: app.globalData.user ? profileIssues(app.globalData.user) : [],
        pending: !!wx.getStorageSync(api.pendingKey()) });
      await this.refreshQuote();
    } finally { this.setData({ loading: false }); }
  },

  async refreshQuote() {
    const app = getApp();
    if (!app.globalData.cart.length) return this.setData({ quote: null, quoteError: '' });
    try {
      const window = app.globalData.window;
      const payload = booking.windowPayload(window.storeId, window.pickupDate, window.returnDate);
      const quote = await api.request('/api/quote', 'POST', api.isWechatShowcase()
        ? { cartVersion: app.globalData.cartVersion }
        : { ...payload, items: app.globalData.cart });
      this.setData({ quote, quoteError: '' });
    } catch (error) { this.setData({ quote: null, quoteError: error.message }); }
  },

  async onQuantity(event) {
    const id = Number(event.currentTarget.dataset.id), delta = Number(event.currentTarget.dataset.delta);
    const line = this.data.lines.find(item => item.variantId === id);
    if (!line) return;
    try {
      const app = getApp();
      const next = booking.changeCart(app.globalData.cart, id, delta, line.available);
      if (app.globalData.user) {
        try { await cartSync.saveRemote(app, next); }
        catch (error) { await cartSync.handleStale(app, error); }
      } else app.saveCart(next);
      this.setData({ lines: app.globalData.cart.map(item => {
        const product = app.globalData.catalog?.items.find(row => Number(row.id) === item.variantId);
        return { ...item, name: product?.name || '已下架的装备', size: product?.size || '请删除',
          category: product?.category, available: product?.available || 0,
          dailyNok: product?.dailyNok, depositNok: product?.depositNok };
      }) });
      await this.refreshQuote();
    } catch (error) { await this.load().catch(() => {}); warn(error); }
  },
  goCatalog() { wx.switchTab({ url: '/pages/catalog/index' }); },
  goAccount() { wx.switchTab({ url: '/pages/account/index' }); },
  async retryLoad() { await this.onShow(); },
  onSkill(event) { this.setData({ skillIndex: Number(event.detail.value) }); },
  openPolicy() { this.setData({ showPolicy: true, policyRead: false, accepted: false }); },
  closePolicy() { this.setData({ showPolicy: false }); },
  onPolicyBottom() { this.setData({ policyRead: true }); },
  onAccepted(event) { this.setData({ accepted: this.data.policyRead && event.detail.value.includes('yes') }); },

  async submitIntent(entry) {
    this.setData({ submitting: true });
    try {
      const result = await api.request('/api/reservations', 'POST', entry.payload, { 'Idempotency-Key': entry.key });
      wx.removeStorageSync(api.pendingKey());
      this.setData({ pending: false, accepted: false, policyRead: false, showPolicy: false });
      const app = getApp();
      try { await cartSync.saveRemote(app, []); }
      catch (error) {
        if (error.code === 'CART_STALE') await cartSync.loadRemote(app).catch(() => {});
        wx.showToast({ title: '订单已创建，购物车需刷新', icon: 'none' });
      }
      if (result.status === 'EXPIRED') {
        return wx.showModal({ title: '暂留已过期', content: '原提交已找回，但 15 分钟暂留已失效，请重新选择租期和库存。', showCancel: false });
      }
      wx.navigateTo({ url: `/pages/order-detail/index?id=${result.id}` });
    } catch (error) {
      if (!error.network) wx.removeStorageSync(api.pendingKey());
      this.setData({ pending: !!wx.getStorageSync(api.pendingKey()) });
      warn(error.network ? new Error('网络结果不确定，原预约可能已经创建。请点“找回上次提交”，系统会用同一标识安全重试。') : error);
    } finally { this.setData({ submitting: false }); }
  },

  async onRetry() {
    const entry = wx.getStorageSync(api.pendingKey());
    const user = getApp().globalData.user;
    if (!entry || entry.userId !== user?.id) return warn(new Error('没有当前账号的待确认提交'));
    await this.submitIntent(entry);
  },

  async onCheckout() {
    if (this.data.submitting) return;
    const app = getApp();
    if (!app.globalData.user) return this.goAccount();
    if (api.isWechatShowcase()) {
      const uncertain = wx.getStorageSync(api.pendingKey());
      if (uncertain?.userId === app.globalData.user.id) {
        return warn(new Error('上次预约结果尚未确认。请先点“找回上次预约提交”，系统会用原提交标识安全重试。'));
      }
    }
    if (!this.data.quote) return warn(new Error(this.data.quoteError || '请重新核对库存和报价'));
    if (!this.data.accepted || !this.data.policyRead) return warn(new Error('请打开规则，阅读到末尾并勾选同意'));
    if (this.data.skillIndex < 0) return warn(new Error('请选择本次滑雪水平'));
    try {
      const user = await api.request('/api/me');
      app.globalData.user = user;
      if (app.globalData.boot) app.globalData.boot.user = user;
      const issues = profileIssues(user);
      this.setData({ user, profileIssues: issues, checkoutError: '' });
      if (issues.length) return;
      const window = app.globalData.window;
      const payload = booking.reservationPayload(
        booking.windowPayload(window.storeId, window.pickupDate, window.returnDate),
        app.globalData.cart, this.data.skills[this.data.skillIndex],
        { accepted: true, readToEnd: true, version: this.data.policy.version }
      );
      const quote = await api.request('/api/quote', 'POST', api.isWechatShowcase()
        ? { cartVersion: app.globalData.cartVersion }
        : { ...booking.windowPayload(window.storeId, window.pickupDate, window.returnDate), items: app.globalData.cart });
      this.setData({ quote });
      const simulation = api.isWechatShowcase() ? '合成预览不产生真实扣款' : '本机演示不真实扣款';
      const agreed = await confirm('确认创建预约', `装备租金 NOK ${quote.rentNok} + 可退押金 NOK ${quote.depositNok} = NOK ${quote.totalNok}。${simulation}；创建后暂留 15 分钟，请继续阅读合同。`);
      if (!agreed) return;
      const reservation = api.isWechatShowcase()
        ? { cartVersion: app.globalData.cartVersion, quoteId: quote.quoteId,
          customerSkill: payload.customerSkill, damageConsent: payload.damageConsent }
        : payload;
      const pending = wx.getStorageSync(api.pendingKey());
      const entry = pending && pending.userId === user.id && JSON.stringify(pending.payload) === JSON.stringify(reservation)
        ? pending : { userId: user.id, key: booking.newRequestKey(), payload: reservation };
      wx.setStorageSync(api.pendingKey(), entry);
      this.setData({ pending: true });
      await this.submitIntent(entry);
    } catch (error) { this.setData({ checkoutError: error.message }); }
  }
});
