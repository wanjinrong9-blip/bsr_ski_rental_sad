const test = require('node:test');
const assert = require('node:assert/strict');

test('ambiguous secure booking cannot acquire a second quote and idempotency key', async () => {
  const apiPath = require.resolve('../utils/api');
  const priorApi = require.cache[apiPath];
  let requests = 0;
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
    isWechatShowcase: () => true,
    pendingKey: () => 'bsr-mini-wechat-pending',
    request: async () => { requests += 1; throw new Error('must not send a second request'); }
  } };
  let page, modal;
  global.Page = definition => { page = definition; };
  global.getApp = () => ({ globalData: { user: { id: 17 } } });
  global.wx = {
    getStorageSync: key => key === 'bsr-mini-wechat-pending' ? { userId: 17, key: 'original-key' } : null,
    showModal: options => { modal = options; }
  };
  try {
    delete require.cache[require.resolve('../pages/cart/index.js')];
    require('../pages/cart/index.js');
    await page.onCheckout.call({ data: { quote: { totalNok: 100 }, accepted: true,
      policyRead: true, skillIndex: 0 } });
    assert.equal(requests, 0);
    assert.match(modal.content, /找回上次预约提交/);
  } finally {
    if (priorApi) require.cache[apiPath] = priorApi;
    else delete require.cache[apiPath];
    delete global.Page;
    delete global.getApp;
    delete global.wx;
  }
});
