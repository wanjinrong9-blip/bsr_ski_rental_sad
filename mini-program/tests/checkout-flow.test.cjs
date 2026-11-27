const test = require('node:test');
const assert = require('node:assert/strict');

function pageHarness(name, api, app, wx = {}) {
  const apiPath = require.resolve('../utils/api');
  const path = require.resolve(`../pages/${name}/index.js`);
  const priorApi = require.cache[apiPath], priorPage = require.cache[path];
  const priorGlobals = { Page: global.Page, getApp: global.getApp, wx: global.wx };
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true,
    exports: { isWechatShowcase: () => true, isAccountShowcase: () => false, ...api } };
  let definition;
  global.Page = value => { definition = value; };
  global.getApp = () => app;
  global.wx = wx;
  delete require.cache[path];
  require(path);
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); } };
  return { page, close() {
    if (priorApi) require.cache[apiPath] = priorApi; else delete require.cache[apiPath];
    if (priorPage) require.cache[path] = priorPage; else delete require.cache[path];
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  } };
}

test('checkout rechecks current customer data and stops before creating an invalid reservation', async () => {
  const calls = [];
  const app = { globalData: { user: { id: 7, name: '旧缓存顾客', heightCm: 170 }, boot: { user: {} } } };
  const h = pageHarness('cart', {
    pendingKey: () => 'pending', request: async (path, method = 'GET') => {
      calls.push([path, method]);
      return { id: 7, name: '演示顾客', phone: '0000', address: '虚构地址',
        birthYear: 2000, heightCm: 49, weightKg: 60, shoeSize: 'EU 42' };
    }
  }, app, { getStorageSync: () => null });
  try {
    Object.assign(h.page.data, { quote: { totalNok: 100 }, accepted: true, policyRead: true, skillIndex: 0 });
    await h.page.onCheckout();
    assert.deepEqual(calls, [['/api/me', 'GET']]);
    assert.deepEqual(h.page.data.profileIssues, [{ key: 'heightCm', message: '身高须为50–250厘米' }]);
    assert.equal(app.globalData.boot.user.heightCm, 49);
    assert.equal(h.page.data.checkoutError, '');
  } finally { h.close(); }
});

test('profile save updates cached bootstrap and keeps server validation errors in the form', async () => {
  let fail = false, calls = 0;
  const saved = { name: '最新演示顾客', phone: '0000', address: '虚构地址', birthYear: 2000,
    heightCm: 170, weightKg: 60, shoeSize: 'EU 42' };
  const app = { globalData: { user: { id: 7 }, boot: { user: { id: 7, name: '旧姓名' } } } };
  const h = pageHarness('account', { request: async (path, method, data) => {
    calls++;
    assert.equal(path, '/api/me'); assert.equal(method, 'PATCH');
    assert.equal(data.address, saved.address);
    if (fail) throw new Error('会话已失效，请重新登录');
    return saved;
  } }, app, { showToast() {} });
  try {
    Object.assign(h.page.data, { user: app.globalData.user, profile: { ...saved, heightCm: '251' } });
    await h.page.onSaveProfile();
    assert.equal(calls, 0);
    assert.match(h.page.data.profileError, /50–250/);
    h.page.data.profile = saved;
    await h.page.onSaveProfile();
    assert.equal(app.globalData.boot.user.name, saved.name);
    assert.equal(app.globalData.user.id, 7);
    assert.equal(h.page.data.profileIssues.length, 0);
    fail = true;
    await h.page.onSaveProfile();
    assert.match(h.page.data.profileError, /会话已失效/);
    assert.equal(h.page.data.user.id, 7);
    assert.equal(h.page.data.busy, false);
  } finally { h.close(); }
});

const orderFixture = () => ({ id: 91, status: 'HOLD', rent_nok: 100, deposit_nok: 40, total_nok: 140,
  hold_expires_at: '2099-12-01T09:00:00.000Z', contracts: [{ id: 3, code: 'CT-91-V1', version: 1,
    signed_at: '2099-12-01T08:00:00.000Z' }],
  workflow: { current: '确认演示付款', handler: { role: 'customer', name: '演示顾客' },
    steps: [{ key: 'PAYMENT', status: 'CURRENT', handler: { role: 'customer', name: '演示顾客' } }] } });

test('signed contract exposes a separate payment phase and payment cancellation creates nothing', async () => {
  const calls = [], confirmations = [];
  const h = pageHarness('order-detail', { request: async (path, method = 'GET') => {
    calls.push([path, method]); return orderFixture();
  } }, {}, { showModal(options) { confirmations.push(options); options.success({ confirm: false }); } });
  try {
    h.page.data.id = 91;
    await h.page.refresh();
    assert.equal(h.page.data.statusLabel, '已确认合同 · 待演示付款');
    assert.equal(h.page.data.currentHandler, '顾客本人 · 演示顾客');
    assert.equal(h.page.data.canPay, true);
    await h.page.onDemoPay();
    assert.match(confirmations[0].content, /CT-91-V1 · V1.*NOK 100.*NOK 40.*NOK 140/);
    assert.deepEqual(calls, [['/api/reservations/91', 'GET']]);
    assert.equal(h.page.data.acting, false);
  } finally { h.close(); }
});

test('payment uses the existing authorized route, prevents duplicate confirmation, and retains errors', async () => {
  const calls = [];
  let decide, fail = true, paid = false;
  const h = pageHarness('order-detail', { request: async (path, method = 'GET', payload) => {
    calls.push([path, method]);
    if (method === 'POST') {
      assert.equal(path, '/api/reservations/91/pay'); assert.equal(payload, undefined);
      if (fail) throw new Error('暂留已过期，请重新预约');
      paid = true;
    }
    const order = orderFixture();
    return paid ? { ...order, status: 'CONFIRMED', paid_at: '2099-12-01T08:01:00.000Z' } : order;
  } }, {}, { showModal(options) { decide = () => options.success({ confirm: true }); } });
  try {
    h.page.data.id = 91;
    await h.page.refresh();
    const first = h.page.onDemoPay();
    await h.page.onDemoPay();
    decide(); await first;
    assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
    assert.match(h.page.data.paymentError, /暂留已过期/);
    assert.equal(h.page.data.order.id, 91);
    assert.equal(h.page.data.acting, false);
    fail = false;
    const retry = h.page.onDemoPay(); decide(); await retry;
    assert.equal(h.page.data.paymentError, '');
    assert.equal(h.page.data.order.status, 'CONFIRMED');
    assert.equal(h.page.data.canPay, false);
  } finally { h.close(); }
});
