const test = require('node:test');
const assert = require('node:assert/strict');
const { filterCatalog, ALL_SIZE, ALL_STYLE } = require('../utils/catalog-filter');

const items = [
  { id: 1, category: '双板', size: '148 cm', style: '稳定巡航' },
  { id: 2, category: '双板', size: '164 cm', style: '轻量转弯' },
  { id: 3, category: '护具', size: 'M', style: '软壳缓冲' },
  { id: 4, category: '护具', size: 'M', style: '可调节' }
];

test('category, size and style narrow the same catalog without changing inventory data', () => {
  const filtered = filterCatalog(items, { category: '护具', size: 'M', style: '软壳缓冲' });
  assert.deepEqual(filtered.categories, ['全部', '双板', '护具']);
  assert.deepEqual(filtered.sizes, [ALL_SIZE, 'M']);
  assert.deepEqual(filtered.styles, [ALL_STYLE, '软壳缓冲', '可调节']);
  assert.deepEqual(filtered.visibleItems.map(item => item.id), [3]);
  assert.equal(items.length, 4);
});

test('store/window catalog replacement clears selections no longer available', () => {
  const filtered = filterCatalog(items.slice(0, 2), { category: '护具', size: 'M', style: '软壳缓冲' });
  assert.equal(filtered.category, '全部');
  assert.equal(filtered.size, ALL_SIZE);
  assert.equal(filtered.style, ALL_STYLE);
  assert.deepEqual(filtered.visibleItems.map(item => item.id), [1, 2]);
});
