const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { networkError } = require('../utils/network-error');

test('transport failures distinguish domain, TLS, DNS, proxy, timeout and offline causes without leaking URLs', () => {
  for (const [detail, code] of [
    ['request:fail url not in domain list', 'DOMAIN_NOT_ALLOWED'],
    ['request:fail timeout', 'REQUEST_TIMEOUT'],
    ['request:fail net::ERR_CERT_DATE_INVALID', 'TLS_ERROR'],
    ['request:fail net::ERR_NAME_NOT_RESOLVED', 'DNS_ERROR'],
    ['request:fail net::ERR_PROXY_CONNECTION_FAILED', 'PROXY_ERROR'],
    ['request:fail net::ERR_INTERNET_DISCONNECTED', 'NETWORK_OFFLINE'],
    ['request:fail net::ERR_CONNECTION_RESET', 'CONNECTION_FAILED']
  ]) {
    const cause = { errMsg: detail + ' https://private.example/api?token=private-value' };
    const error = networkError(cause);
    assert.equal(error.code, code);
    assert.equal(error.network, true);
    assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /private.example|private-value/);
  }
});

test('opening a disconnected catalog does not block the page; retry rebuilds bootstrap and inventory', async () => {
  const booking = require('../utils/booking');
  let definition, bootCalls = 0, modals = 0, catalogCalls = 0;
  const app = { globalData: { user: null, cart: [], window: {
    storeId: 1, pickupDate: booking.addCalendarDays(booking.osloToday(), 1),
    returnDate: booking.addCalendarDays(booking.osloToday(), 2)
  } }, async ensureBootstrap(force) {
    bootCalls++;
    if (bootCalls === 1) throw networkError({ errMsg: 'request:fail timeout' });
    assert.equal(force, true);
    return { stores: [{ id: 1, name: '虚构门店' }] };
  }, saveWindow(window) { this.globalData.window = window; } };
  const api = { isWechatShowcase: () => false, isAccountShowcase: () => false,
    async request() { catalogCalls++; return { items: [] }; } };
  const filename = path.resolve(__dirname, '../pages/catalog/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    wx: { showModal() { modals++; }, stopPullDownRefresh() {} },
    require(name) {
      if (name === '../../utils/api') return api;
      if (name === '../../utils/cart-sync') return {};
      return require(path.resolve(path.dirname(filename), name));
    }
  }, { filename });
  const page = { ...definition, data: { ...definition.data }, setData(data) { Object.assign(this.data, data); } };
  await page.onShow();
  assert.equal(modals, 0);
  assert.equal(page.data.availabilityReady, false);
  assert.match(page.data.error, /REQUEST_TIMEOUT/);
  assert.equal(page.data.loading, false);
  await page.onSearch();
  assert.equal(bootCalls, 2);
  assert.equal(catalogCalls, 1);
  assert.equal(page.data.stores.length, 1);
  assert.equal(page.data.availabilityReady, true);
  assert.equal(page.data.error, '');
});

test('anonymous cloud visitors see a login action without requesting protected inventory', async () => {
  let definition, catalogCalls = 0, destination;
  const booking = require('../utils/booking');
  const app = { globalData: { user: null, cart: [], window: {
    storeId: 1, pickupDate: booking.addCalendarDays(booking.osloToday(), 1),
    returnDate: booking.addCalendarDays(booking.osloToday(), 2)
  } }, async ensureBootstrap() { return { stores: [{ id: 1, name: '虚构门店' }] }; } };
  const filename = path.resolve(__dirname, '../pages/catalog/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    wx: { switchTab({ url }) { destination = url; }, showModal() { assert.fail('No error modal on open'); } },
    require(name) {
      if (name === '../../utils/api') return {
        isWechatShowcase: () => false, isAccountShowcase: () => true,
        async request() { catalogCalls++; throw new Error('Inventory requires login'); }
      };
      if (name === '../../utils/cart-sync') return {};
      return require(path.resolve(path.dirname(filename), name));
    }
  }, { filename });
  const page = { ...definition, data: { ...definition.data }, setData(data) { Object.assign(this.data, data); } };
  await page.onShow();
  assert.equal(page.data.loginRequired, true);
  assert.equal(page.data.error, '');
  assert.equal(catalogCalls, 0);
  await page.onSearch();
  assert.equal(destination, '/pages/account/index');
  assert.equal(catalogCalls, 0);
});
