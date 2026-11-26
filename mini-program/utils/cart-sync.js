const api = require('./api');
const booking = require('./booking');

function applyRemote(app, remote) {
  app.globalData.cartVersion = remote.version;
  app.saveCart(remote.items || []);
  if (remote.storeId && remote.pickupAt && remote.returnAt) {
    app.saveWindow({
      storeId: remote.storeId,
      pickupDate: booking.formatOslo(remote.pickupAt).slice(0, 10),
      returnDate: booking.formatOslo(remote.returnAt).slice(0, 10)
    });
  }
  return remote;
}

async function loadRemote(app) {
  return applyRemote(app, await api.request('/api/cart'));
}

async function saveRemote(app, items, window = app.globalData.window) {
  const range = booking.windowPayload(window.storeId, window.pickupDate, window.returnDate);
  const saved = await api.request('/api/cart', 'PUT', {
    expectedVersion: app.globalData.cartVersion,
    ...range,
    items: booking.normalizeCart(items)
  });
  return applyRemote(app, saved);
}

async function handleStale(app, error) {
  if (error.code !== 'CART_STALE') throw error;
  await loadRemote(app);
  const conflict = new Error('购物车已在网页或另一设备更新。已同步账号中的最新版，请核对租期、数量和报价后重试。');
  conflict.code = 'CART_STALE';
  throw conflict;
}

function chooseCart() {
  return new Promise(resolve => wx.showModal({
    title: '发现两份购物车',
    content: '网页账号中已有购物车。点“使用网页版”同步账号中的装备；点“保留本机”用当前选择覆盖账号购物车。两端预约库存仍以服务端最新结果为准。',
    confirmText: '使用网页版', cancelText: '保留本机',
    success: response => resolve(response.confirm ? 'remote' : 'local'),
    fail: () => resolve('remote')
  }));
}

async function mergeAfterLogin(app) {
  const guest = booking.normalizeCart(app.globalData.cart);
  const window = app.globalData.window;
  const remote = await api.request('/api/cart');
  app.globalData.cartVersion = remote.version;
  if (guest.length && remote.items.length) {
    const choice = await chooseCart();
    if (choice === 'remote') return applyRemote(app, remote);
    try { return await saveRemote(app, guest, window); }
    catch (error) { return handleStale(app, error); }
  }
  if (guest.length) {
    try { return await saveRemote(app, guest, window); }
    catch (error) { return handleStale(app, error); }
  }
  return applyRemote(app, remote);
}

module.exports = { applyRemote, loadRemote, saveRemote, handleStale, mergeAfterLogin };
