const api = require('./utils/api');
const booking = require('./utils/booking');

App({
  globalData: {
    boot: null,
    user: null,
    catalog: null,
    cart: [],
    cartVersion: 0,
    window: null
  },

  onLaunch() {
    api.restoreToken();
    this.globalData.cart = booking.normalizeCart(wx.getStorageSync(api.cartKey()) || []);
    const savedWindow = wx.getStorageSync(api.windowKey());
    let validSaved = false;
    if (savedWindow && typeof savedWindow === 'object') {
      try {
        booking.windowPayload(savedWindow.storeId, savedWindow.pickupDate, savedWindow.returnDate);
        validSaved = true;
      } catch (_) { /* A previous visit may have left a past rental window. */ }
    }
    this.globalData.window = validSaved ? savedWindow : {
      storeId: 1,
      pickupDate: booking.addCalendarDays(booking.osloToday(), 1),
      returnDate: booking.addCalendarDays(booking.osloToday(), 2)
    };
    if (!validSaved) wx.setStorageSync(api.windowKey(), this.globalData.window);
  },

  async ensureBootstrap(force = false) {
    if (!force && this.globalData.boot) return this.globalData.boot;
    const boot = await api.bootstrap();
    this.globalData.boot = boot;
    this.globalData.user = boot.user?.role === 'customer' ? boot.user : null;
    return boot;
  },

  saveCart(cart) {
    this.globalData.cart = booking.normalizeCart(cart);
    wx.setStorageSync(api.cartKey(), this.globalData.cart);
    return this.globalData.cart;
  },

  saveWindow(window) {
    this.globalData.window = { storeId: Number(window.storeId), pickupDate: window.pickupDate, returnDate: window.returnDate };
    wx.setStorageSync(api.windowKey(), this.globalData.window);
  },

  clearIdentity() {
    api.setToken('');
    this.globalData.user = null;
    this.globalData.cartVersion = 0;
    this.saveCart([]);
    wx.removeStorageSync(api.pendingKey());
    this.globalData.boot = null;
  }
});
