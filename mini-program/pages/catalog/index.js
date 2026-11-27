const api = require('../../utils/api');
const booking = require('../../utils/booking');
const cartSync = require('../../utils/cart-sync');
const { ALL_SIZE, ALL_STYLE, filterCatalog } = require('../../utils/catalog-filter');

function errorBox(error) {
  wx.showModal({ title: '暂时无法查询', content: error.message || '请稍后重试', showCancel: false });
}
function displayWindow(window) {
  try {
    booking.windowPayload(window.storeId, window.pickupDate, window.returnDate);
    return {pickupDate:window.pickupDate,returnDate:window.returnDate,expired:false};
  } catch (_) {
    const pickupDate=booking.addCalendarDays(booking.osloToday(),1);
    return {pickupDate,returnDate:booking.addCalendarDays(pickupDate,1),expired:true};
  }
}

Page({
  data: {
    loading: true, searching: false, stores: [], storeNames: [], storeIndex: 0,
    pickupDate: '', returnDate: '', minDate: '', category: '全部', categories: ['全部'],
    size: ALL_SIZE, sizes: [ALL_SIZE], sizeIndex: 0,
    style: ALL_STYLE, styles: [ALL_STYLE], styleIndex: 0,
    items: [], visibleItems: [], cartCount: 0, availabilityReady: false, loginRequired: false,
    wechatMode: api.isWechatShowcase(), accountMode: api.isAccountShowcase(), error: ''
  },

  async onShow() {
    const app = getApp();
    const window = displayWindow(app.globalData.window);
    this.setData({
      pickupDate: window.pickupDate,
      returnDate: window.returnDate,
      minDate: booking.osloToday(),
      cartCount: app.globalData.cart.reduce((sum, line) => sum + line.qty, 0)
    });
    // Passive page loads use the inline error and retry action, without a blocking modal.
    try { await this.loadCatalog(); } catch (_) { /* loadCatalog has set the error. */ }
  },

  async onPullDownRefresh() {
    try { await this.loadCatalog(true); } catch (_) { /* Keep the retry action visible. */ }
    finally { wx.stopPullDownRefresh(); }
  },

  async loadCatalog(force = false) {
    const app = getApp();
    this.setData({ loading: true, error: '', loginRequired: false });
    try {
      const boot = await app.ensureBootstrap(force);
      if (app.globalData.user) await cartSync.loadRemote(app);
      const stores = boot.stores || [];
      const selected = Math.max(0, stores.findIndex(store => Number(store.id) === Number(app.globalData.window.storeId)));
      const window=displayWindow(app.globalData.window);
      this.setData({ stores, storeNames: stores.map(store => store.name), storeIndex: selected,
        pickupDate: window.pickupDate, returnDate: window.returnDate,
        cartCount: app.globalData.cart.reduce((sum, line) => sum + line.qty, 0) });
      if ((api.isWechatShowcase() || api.isAccountShowcase()) && !app.globalData.user) {
        this.setData({ availabilityReady: false, loginRequired: true, items: [], visibleItems: [] });
        return;
      }
      if(window.expired){
        this.setData({availabilityReady:false,
          error:'原租期已过，已建议新的日期；请核对后点击“查询该日期段库存”。'});
        return;
      }
      await this.search();
    } catch (error) {
      this.setData({ error: error.message, availabilityReady: false });
      throw error;
    } finally { this.setData({ loading: false }); }
  },

  onStoreChange(event) {
    this.setData({ storeIndex: Number(event.detail.value), availabilityReady: false });
  },
  onPickupChange(event) {
    const pickupDate = event.detail.value;
    const returnDate = this.data.returnDate < pickupDate ? pickupDate : this.data.returnDate;
    this.setData({ pickupDate, returnDate, availabilityReady: false });
  },
  onReturnChange(event) {
    this.setData({ returnDate: event.detail.value, availabilityReady: false });
  },

  async search() {
    if ((api.isWechatShowcase() || api.isAccountShowcase()) && !getApp().globalData.user) {
      throw new Error(api.isWechatShowcase() ? '请先到“我的”完成微信登录与顾客账号绑定' : '请先登录顾客账号后查看库存');
    }
    const store = this.data.stores[this.data.storeIndex];
    if (!store) throw new Error('当前没有可选门店');
    const window = booking.windowPayload(store.id, this.data.pickupDate, this.data.returnDate);
    this.setData({ searching: true, error: '' });
    try {
      const app = getApp();
      const selected = { storeId: store.id, pickupDate: this.data.pickupDate, returnDate: this.data.returnDate };
      if (app.globalData.user) {
        try { await cartSync.saveRemote(app, app.globalData.cart, selected); }
        catch (error) {
          if (error.code === 'CART_STALE') {
            try { await cartSync.handleStale(app, error); } catch (conflict) { throw conflict; }
          }
          throw error;
        }
      } else app.saveWindow(selected);
      const query = `?storeId=${window.storeId}&pickupAt=${encodeURIComponent(window.pickupAt)}&returnAt=${encodeURIComponent(window.returnAt)}`;
      const catalog = await api.request(`/api/catalog${query}`);
      app.globalData.catalog = catalog;
      const items = (catalog.items || []).map(item => ({ ...item, categoryMark: String(item.category || '雪具').slice(0, 2) }));
      this.setData({ items, availabilityReady: true });
      this.applyFilters();
    } catch (error) {
      if (error.code === 'CART_STALE') this.setData({ pickupDate: getApp().globalData.window.pickupDate,
        returnDate: getApp().globalData.window.returnDate,
        storeIndex: Math.max(0, this.data.stores.findIndex(row => Number(row.id) === Number(getApp().globalData.window.storeId))),
        cartCount: getApp().globalData.cart.reduce((sum, line) => sum + line.qty, 0) });
      this.setData({ availabilityReady: false, error: error.message });
      throw error;
    } finally { this.setData({ searching: false }); }
  },

  async onSearch() {
    if (this.data.loading || this.data.searching) return;
    if (!this.data.stores.length) return this.onReconnect();
    if (this.data.loginRequired) return this.goAccount();
    try { await this.search(); } catch (error) { errorBox(error); }
  },
  async onReconnect() {
    if (this.data.loading || this.data.searching) return;
    try { await this.loadCatalog(true); } catch (_) { /* Inline error includes a safe diagnostic code. */ }
  },
  onCategory(event) {
    this.setData({ category: event.currentTarget.dataset.category, size: ALL_SIZE, style: ALL_STYLE });
    this.applyFilters();
  },
  onSize(event) {
    this.setData({ size: this.data.sizes[Number(event.detail.value)] || ALL_SIZE, style: ALL_STYLE });
    this.applyFilters();
  },
  onStyle(event) {
    this.setData({ style: this.data.styles[Number(event.detail.value)] || ALL_STYLE });
    this.applyFilters();
  },
  applyFilters() {
    this.setData(filterCatalog(this.data.items, this.data));
  },
  async onAdd(event) {
    if (!this.data.availabilityReady) return errorBox(new Error('请先查询所选日期段的库存'));
    const id = Number(event.currentTarget.dataset.id);
    const item = this.data.items.find(row => Number(row.id) === id);
    if (!item) return;
    try {
      const app = getApp();
      const next = booking.changeCart(app.globalData.cart, id, 1, item.available);
      if (app.globalData.user) {
        try { await cartSync.saveRemote(app, next); }
        catch (error) { await cartSync.handleStale(app, error); }
      } else app.saveCart(next);
      this.setData({ cartCount: app.globalData.cart.reduce((sum, line) => sum + line.qty, 0) });
      wx.showToast({ title: '已加入购物车', icon: 'success' });
    } catch (error) { errorBox(error); }
  },
  goCart() { wx.switchTab({ url: '/pages/cart/index' }); },
  goAccount() { wx.switchTab({ url: '/pages/account/index' }); }
});
