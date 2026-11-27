// Mirrors master-data.customerProfile. The server remains authoritative.
function profileIssues(profile, { required = true, now = new Date() } = {}) {
  const source = profile || {};
  const text = (key, max) => String(source[key] || '').trim().slice(0, max);
  const number = key => Number(source[key]) || null;
  const issues = [];
  const add = (key, message) => issues.push({ key, message });
  if (text('name', 100).length < 2) add('name', '姓名至少两个字');
  if (required) {
    for (const [key, label, max] of [['phone', '电话', 100], ['address', '地址', 500], ['shoeSize', '鞋码', 30]]) {
      if (!text(key, max)) add(key, `请填写${label}`);
    }
  }
  const year = number('birthYear'), height = number('heightCm'), weight = number('weightKg');
  if (required && !year) add('birthYear', '请填写出生年');
  else if (year && (!Number.isInteger(year) || year < 1900 || year > now.getUTCFullYear())) add('birthYear', '出生年份无效');
  if (required && !height) add('heightCm', '请填写身高');
  else if (height && (height < 50 || height > 250)) add('heightCm', '身高须为50–250厘米');
  if (required && !weight) add('weightKg', '请填写体重');
  else if (weight && (weight < 10 || weight > 300)) add('weightKg', '体重须为10–300千克');
  return issues;
}

module.exports = { profileIssues };
