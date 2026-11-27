const test = require('node:test');
const assert = require('node:assert/strict');
const { profileIssues } = require('../utils/customer-profile');

const complete = { name: '演示顾客', phone: '+47 0000 0000', address: '虚构雪场路1号',
  birthYear: 2000, heightCm: 170, weightKg: 60, shoeSize: 'EU 42' };

test('Mini profile checks agree with the shared server fields and bounds', async () => {
  const { customerProfile } = await import('../../src/master-data.mjs');
  const samples = [complete, { ...complete, name: ' ' }, { ...complete, phone: ' ' },
    { ...complete, address: '' }, { ...complete, shoeSize: '' },
    ...[1899, 2000.5, new Date().getUTCFullYear() + 1, 1900].map(birthYear => ({ ...complete, birthYear })),
    ...[49, 50, 170.5, 250, 251, ''].map(heightCm => ({ ...complete, heightCm })),
    ...[9, 10, 60.5, 300, 301, ''].map(weightKg => ({ ...complete, weightKg }))];
  for (const required of [true, false]) {
    for (const profile of samples) {
      let serverValid = true;
      try { customerProfile({}, profile, required); } catch { serverValid = false; }
      assert.equal(profileIssues(profile, { required }).length === 0, serverValid, JSON.stringify({ required, profile }));
    }
  }
});

test('Mini lists missing contract fields together while allowing a partial profile save', () => {
  const profile = { name: '演示顾客' };
  assert.deepEqual(profileIssues(profile).map(issue => issue.key),
    ['phone', 'address', 'shoeSize', 'birthYear', 'heightCm', 'weightKg']);
  assert.deepEqual(profileIssues(profile, { required: false }), []);
  assert.deepEqual(profileIssues({ ...complete, phone: '现场电话', shoeSize: '儿童尺码' }), []);
});
