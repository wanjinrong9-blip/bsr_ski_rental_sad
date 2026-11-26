const test = require('node:test');
const assert = require('node:assert/strict');

test('Mini order detail makes the shared damage assessment, deadline and contact visible', async () => {
  const apiPath = require.resolve('../utils/api');
  const previousApi = require.cache[apiPath];
  const order = {
    id: 91, code: 'SYN-91', status: 'SETTLEMENT', pickup_at: '2026-12-01T08:00:00.000Z',
    return_at: '2026-12-02T15:00:00.000Z', contracts: [],
    workflow: { current: '联系顾客并核实补差', steps: [] },
    damage: {
      cases: [{ id: 7, inventory_no: 'SYN-UNIT-7', status: 'APPROVED',
        grade: 'MODERATE', part: '板面边缘', fee_nok: 650,
        diagnosis: '板面边缘存在可修复损伤', assessor_name: '虚构装备检修技师',
        photos: [{ id: 3, part: '板面边缘' }],
        feedback_due_at: '2026-12-03T15:00:00.000Z',
        first_feedback_at: '2026-12-03T12:00:00.000Z',
        approved_at: '2026-12-03T13:00:00.000Z', review_note: '已核对照片' }],
      settlement: { damage_fee_nok: 650, late_fee_nok: 0, deducted_nok: 48,
        refund_nok: 0, supplement_nok: 602, paid_nok: 0 },
      contacts: [{ id: 4, outcome: 'REACHED', note: '已说明鉴定费用',
        created_at: '2026-12-03T14:00:00.000Z' }]
    }
  };
  const downloaded = [];
  const previews = [];
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true,
    exports: { isWechatShowcase: () => true,
      request: async path => { assert.equal(path, '/api/reservations/91'); return order; },
      downloadDamagePhoto: async id => { downloaded.push(id); return '/private/bsr-damage-3.png'; },
      canPreviewDamagePhoto: path => path === '/private/bsr-damage-3.png' } };
  let page;
  global.Page = definition => { page = definition; };
  global.wx = { previewImage: options => {
    previews.push(options);
    options.success();
  } };
  try {
    delete require.cache[require.resolve('../pages/order-detail/index.js')];
    require('../pages/order-detail/index.js');
    const context = { data: { id: 91 }, setData(values) { Object.assign(this.data, values); } };
    await page.refresh.call(context);
    assert.equal(context.data.error, '');
    assert.equal(context.data.damageCases[0].gradeLabel, '中度受损');
    assert.equal(context.data.damageCases[0].statusLabel, '经理已复核');
    assert.equal(context.data.damageCases[0].photoCount, 1);
    assert.deepEqual(context.data.damageCases[0].photos,
      [{ id: 3, part: '板面边缘', caption: '鉴定照片' }]);
    assert.equal(context.data.damageCases[0].dueText, '2026-12-03 16:00');
    assert.equal(context.data.damageCases[0].feedbackText, '2026-12-03 13:00');
    assert.equal(context.data.damageContacts[0].outcomeText, '已联系');
    assert.equal(context.data.order.damage.settlement.supplement_nok, 602);
    await page.onPreviewDamagePhoto.call(context, { currentTarget: { dataset: { photoId: 3 } } });
    assert.deepEqual(downloaded, [3]);
    assert.equal(previews.length, 1);
    assert.equal(previews[0].current, '/private/bsr-damage-3.png');
    assert.deepEqual(previews[0].urls, ['/private/bsr-damage-3.png']);
    assert.equal(context.data.acting, false);
  } finally {
    if (previousApi) require.cache[apiPath] = previousApi;
    else delete require.cache[apiPath];
    delete require.cache[require.resolve('../pages/order-detail/index.js')];
    delete global.Page;
    delete global.wx;
  }
});

test('Mini order detail refuses to preview a photo after the customer session changes', async () => {
  const apiPath = require.resolve('../utils/api');
  const previousApi = require.cache[apiPath];
  let finishDownload;
  let previewCount = 0;
  const modals = [];
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true,
    exports: { isWechatShowcase: () => true,
      downloadDamagePhoto: () => new Promise(resolve => { finishDownload = resolve; }),
      canPreviewDamagePhoto: () => false } };
  let page;
  global.Page = definition => { page = definition; };
  global.wx = {
    previewImage: () => { previewCount++; },
    showModal: options => modals.push(options)
  };
  try {
    delete require.cache[require.resolve('../pages/order-detail/index.js')];
    require('../pages/order-detail/index.js');
    const context = { data: { id: 91, acting: false },
      setData(values) { Object.assign(this.data, values); } };
    const pending = page.onPreviewDamagePhoto.call(context,
      { currentTarget: { dataset: { photoId: 3 } } });
    finishDownload('/private/stale-account.png');
    await pending;
    assert.equal(previewCount, 0);
    assert.match(modals[0].content, /登录状态已变化/);
    assert.equal(context.data.acting, false);
  } finally {
    if (previousApi) require.cache[apiPath] = previousApi;
    else delete require.cache[apiPath];
    delete require.cache[require.resolve('../pages/order-detail/index.js')];
    delete global.Page;
    delete global.wx;
  }
});
