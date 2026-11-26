const test = require('node:test');
const assert = require('node:assert/strict');

const appId = 'wx1234567890abcdef';
const configPath = require.resolve('../utils/config');
const apiPath = require.resolve('../utils/api');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
  exports: { mode: 'wechat-showcase', apiBase: 'https://bsr.example.org', appId } };
delete require.cache[apiPath];
const api = require('../utils/api');

const storage = new Map();
const calls = [];
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { appId } }),
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  request(options) {
    calls.push(options);
    let result = {};
    if (options.url.endsWith('/api/mini/bootstrap')) result = { status: 'ready', synthetic: true, customerOnly: true };
    else if (options.url.endsWith('/api/mini/auth/wechat')) result = { status: 'needs_binding', challenge: 'c'.repeat(64) };
    else if (options.url.endsWith('/api/mini/auth/bind')) result = {
      status: 'authenticated', sessionToken: 'a'.repeat(64), user: { id: 7, role: 'customer', name: '演示顾客' }
    };
    else if (options.url.endsWith('/api/mini/me')) result = { id: 7, role: 'customer', name: '演示顾客' };
    else if (options.url.endsWith('/api/mini/catalog?storeId=1')) result = { items: [{ id: 3, availableCount: 2 }] };
    else if (options.url.endsWith('/api/mini/auth/logout')) result = { ok: true };
    options.success({ statusCode: 200, data: result });
  }
};

test('secure mode maps only customer routes and rejects Web password login', () => {
  assert.equal(api.mapPath('/api/catalog?storeId=1'), '/api/mini/catalog?storeId=1');
  assert.equal(api.mapPath('/api/reservations/17/contracts'), '/api/mini/reservations/17/contracts');
  assert.equal(api.mapPath('/api/contracts/2/sign'), '/api/mini/contracts/2/sign');
  assert.throws(() => api.mapPath('/api/auth/login'), /不提供/);
  assert.throws(() => api.mapPath('/api/auth/register'), /不提供/);
  assert.throws(() => api.mapPath('https://other.example/api/mini/me'), /路径无效/);
});

test('wx code and explicit binding use no Web session; private customer calls use Bearer', async () => {
  api.restoreToken();
  await api.bootstrap();
  const start = await api.wechatLogin('freshCode1234');
  assert.equal(start.status, 'needs_binding');
  const user = await api.bindWechat(start.challenge, 'demo@example.test', 'private-proof');
  assert.equal(user.role, 'customer');
  assert.equal(storage.get('bsr-mini-wechat-session'), 'a'.repeat(64));
  assert.equal(storage.has('bsr-mini-local-session'), false);
  await api.request('/api/me');
  const catalog = await api.request('/api/catalog?storeId=1');
  assert.equal(catalog.items[0].available, 2);
  assert.equal(calls.find(call => call.url.endsWith('/api/mini/auth/wechat')).header.Authorization, undefined);
  assert.equal(calls.find(call => call.url.endsWith('/api/mini/auth/bind')).header.Authorization, undefined);
  assert.equal(calls.find(call => call.url.endsWith('/api/mini/me')).header.Authorization, `Bearer ${'a'.repeat(64)}`);
  assert.equal(calls.some(call => 'X-BSR-Session' in call.header), false);
  await api.logout();
  assert.equal(storage.has('bsr-mini-wechat-session'), false);
});

test('expired mini session clears only secure-mode private cache', async () => {
  storage.set('bsr-mini-cart', [{ variantId: 1, qty: 1 }]);
  storage.set(api.cartKey(), [{ variantId: 2, qty: 1 }]);
  storage.set(api.pendingKey(), { key: 'retry-key' });
  api.setToken('b'.repeat(64));
  const prior = wx.request;
  wx.request = options => options.success({ statusCode: 401,
    data: { code: 'SESSION_EXPIRED', error: '会话过期' } });
  try {
    await assert.rejects(api.request('/api/me'), error => error.code === 'SESSION_EXPIRED');
    assert.equal(storage.has('bsr-mini-wechat-session'), false);
    assert.equal(storage.has(api.cartKey()), false);
    assert.equal(storage.has(api.pendingKey()), false);
    assert.equal(storage.has('bsr-mini-cart'), true);
  } finally { wx.request = prior; }
});

test('damage photo download uses scoped Mini bearer token and removes local copy on logout', async () => {
  const removed = [];
  const downloads = [];
  let issued = 0;
  wx.getFileSystemManager = () => ({ unlink(options) {
    removed.push(options.filePath);
    options.success?.();
  } });
  wx.downloadFile = options => {
    downloads.push(options);
    options.success({ statusCode: 200,
      tempFilePath: '/private/synthetic-damage-' + (++issued) + '.png' });
  };
  api.setToken('d'.repeat(64));
  const path = await api.downloadDamagePhoto(7);
  assert.equal(path, '/private/synthetic-damage-1.png');
  assert.equal(api.canPreviewDamagePhoto(path), true);
  assert.equal(downloads[0].url, 'https://bsr.example.org/api/mini/damage-photos/7');
  assert.equal(downloads[0].header.Authorization, 'Bearer ' + 'd'.repeat(64));
  assert.equal(downloads[0].header['X-BSR-Session'], undefined);
  api.setToken('f'.repeat(64));
  assert.deepEqual(removed, [path]);
  assert.equal(api.canPreviewDamagePhoto(path), false);
  const secondPath = await api.downloadDamagePhoto(7);
  assert.equal(secondPath, '/private/synthetic-damage-2.png');
  assert.equal(downloads[1].header.Authorization, 'Bearer ' + 'f'.repeat(64));
  await api.logout();
  assert.deepEqual(removed, [path, secondPath]);
  assert.equal(storage.has('bsr-mini-wechat-session'), false);
  await assert.rejects(api.downloadDamagePhoto(7), /先登录/);
  delete wx.downloadFile;
  delete wx.getFileSystemManager;
});

test('damage photo download hides missing or unauthorized photos and expires invalid sessions', async () => {
  api.setToken('e'.repeat(64));
  wx.downloadFile = options => options.success({ statusCode: 404 });
  await assert.rejects(api.downloadDamagePhoto(8), /不存在或无权查看/);
  assert.equal(storage.get('bsr-mini-wechat-session'), 'e'.repeat(64));
  wx.downloadFile = options => options.success({ statusCode: 401 });
  await assert.rejects(api.downloadDamagePhoto(8), /照片获取失败/);
  assert.equal(storage.has('bsr-mini-wechat-session'), false);
  delete wx.downloadFile;
});

test('a late damage photo response cannot cross logout or account switch', async () => {
  const pending = [];
  const removed = [];
  wx.downloadFile = options => pending.push(options);
  wx.getFileSystemManager = () => ({ unlink(options) {
    removed.push(options.filePath);
    options.success?.();
  } });
  try {
    api.setToken('1'.repeat(64));
    const first = api.downloadDamagePhoto(9);
    assert.equal(pending[0].header.Authorization, 'Bearer ' + '1'.repeat(64));
    api.setToken('2'.repeat(64));
    pending[0].success({ statusCode: 200, tempFilePath: '/private/old-account.png' });
    await assert.rejects(first, /登录状态已变化/);
    assert.deepEqual(removed, ['/private/old-account.png']);
    assert.equal(storage.get('bsr-mini-wechat-session'), '2'.repeat(64));

    const second = api.downloadDamagePhoto(10);
    api.setToken('3'.repeat(64));
    pending[1].success({ statusCode: 401, tempFilePath: '/private/old-error.png' });
    await assert.rejects(second, /登录状态已变化/);
    assert.deepEqual(removed, ['/private/old-account.png', '/private/old-error.png']);
    assert.equal(storage.get('bsr-mini-wechat-session'), '3'.repeat(64));
  } finally {
    api.setToken('');
    delete wx.downloadFile;
    delete wx.getFileSystemManager;
  }
});
