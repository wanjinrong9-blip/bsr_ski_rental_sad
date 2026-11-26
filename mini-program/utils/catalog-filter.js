const ALL_SIZE = '全部尺码';
const ALL_STYLE = '全部款式';

function distinct(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function filterCatalog(items, selected = {}) {
  const rows = Array.isArray(items) ? items : [];
  const categories = ['全部', ...distinct(rows.map(item => item.category))];
  const category = categories.includes(selected.category) ? selected.category : '全部';
  const categoryRows = category === '全部' ? rows : rows.filter(item => item.category === category);
  const sizes = [ALL_SIZE, ...distinct(categoryRows.map(item => item.size))];
  const size = sizes.includes(selected.size) ? selected.size : ALL_SIZE;
  const sizeRows = size === ALL_SIZE ? categoryRows : categoryRows.filter(item => item.size === size);
  const styles = [ALL_STYLE, ...distinct(sizeRows.map(item => item.style))];
  const style = styles.includes(selected.style) ? selected.style : ALL_STYLE;
  const visibleItems = style === ALL_STYLE ? sizeRows : sizeRows.filter(item => item.style === style);
  return { categories, category, sizes, size, styles, style, visibleItems,
    sizeIndex: sizes.indexOf(size), styleIndex: styles.indexOf(style) };
}

module.exports = { ALL_SIZE, ALL_STYLE, filterCatalog };
