const test = require('node:test');
const assert = require('node:assert/strict');
const booking = require('../utils/booking');

test('Norway rental window remains 09:00–16:00 across daylight-saving changes', () => {
  assert.equal(booking.osloIso('2026-03-28', 9), '2026-03-28T08:00:00.000Z');
  assert.equal(booking.osloIso('2026-03-29', 9), '2026-03-29T07:00:00.000Z');
  assert.equal(booking.osloIso('2026-10-24', 16), '2026-10-24T14:00:00.000Z');
  assert.equal(booking.osloIso('2026-10-25', 16), '2026-10-25T15:00:00.000Z');
  assert.equal(booking.formatOslo('2026-10-25T15:00:00.000Z'), '2026-10-25 16:00');
});

test('date selection and checkout guard server contract boundaries', () => {
  const now = new Date('2026-02-03T06:00:00.000Z');
  assert.deepEqual(booking.windowPayload(2, '2026-02-04', '2026-02-06', now), {
    storeId: 2, pickupAt: '2026-02-04T08:00:00.000Z', returnAt: '2026-02-06T15:00:00.000Z'
  });
  assert.throws(() => booking.windowPayload(2, '2026-02-04', '2026-02-03', now), /归还日期/);
  assert.throws(() => booking.windowPayload(2, '2026-02-04', '2026-03-07', now), /30 天/);
  assert.throws(() => booking.windowPayload(2, '2026-02-03', '2026-02-04', new Date('2026-02-03T09:00:00Z')), /09:00/);
  assert.throws(() => booking.reservationPayload({}, [{ variantId: 1, qty: 1 }], '初级', null), /阅读并同意/);
});

test('cart enforces quantity and preserves an idempotent reservation payload', () => {
  const cart = booking.changeCart([], 7, 1, 2);
  assert.deepEqual(cart, [{ variantId: 7, qty: 1 }]);
  assert.deepEqual(booking.changeCart(cart, 7, 1, 2), [{ variantId: 7, qty: 2 }]);
  assert.throws(() => booking.changeCart(cart, 7, 2, 2), /最多还可预订 2 件/);
  const payload = booking.reservationPayload({ storeId: 1, pickupAt: 'a', returnAt: 'b' }, cart,
    '中级', { accepted: true, readToEnd: true, version: 'v1' });
  assert.equal(payload.customerSkill, '中级');
  assert.deepEqual(payload.items, cart);
  assert.match(booking.newRequestKey(1000, 0.12), /^[A-Za-z0-9._:-]{16,128}$/);
});

test('local API accepts the configured official AppID only in Developer Tools', () => {
  const configId=require.resolve('../utils/config'),apiId=require.resolve('../utils/api');
  const originalConfig=require.cache[configId],originalApi=require.cache[apiId];
  require.cache[configId]={id:configId,filename:configId,loaded:true,exports:{mode:'local-demo',apiBase:'http://127.0.0.1:4173',devtoolsAppId:'wx51ce51fc873371a6'}};
  delete require.cache[apiId];
  const api = require('../utils/api');
  const config = require('../utils/config');
  const project = require('../project.config.json');
  assert.equal(project.appid, config.devtoolsAppId);
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { appId: 'touristappid' } }) };
  assert.doesNotThrow(api.assertLocalDemo);
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { appId: config.devtoolsAppId } }),
    getDeviceInfo: () => ({ platform: 'devtools' })
  };
  assert.doesNotThrow(api.assertLocalDemo);
  global.wx.getDeviceInfo = () => ({ platform: 'ios' });
  assert.throws(api.assertLocalDemo, /真机/);
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { appId: 'wx-real-account' } }) };
  assert.throws(api.assertLocalDemo, /当前 AppID/);
  delete global.wx;
  if(originalConfig)require.cache[configId]=originalConfig;else delete require.cache[configId];
  if(originalApi)require.cache[apiId]=originalApi;else delete require.cache[apiId];
});
