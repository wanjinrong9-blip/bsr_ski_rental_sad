const DAY_MS = 86400000;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const time = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function lastSunday(year, monthIndex) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

function osloOffsetAt(instant) {
  const year = instant.getUTCFullYear();
  const start = Date.UTC(year, 2, lastSunday(year, 2), 1);
  const end = Date.UTC(year, 9, lastSunday(year, 9), 1);
  return instant.getTime() >= start && instant.getTime() < end ? 2 : 1;
}

function osloToday(now = new Date()) {
  return new Date(now.getTime() + osloOffsetAt(now) * 3600000).toISOString().slice(0, 10);
}

function formatOslo(iso) {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return '—';
  return new Date(instant.getTime() + osloOffsetAt(instant) * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

function addCalendarDays(date, days) {
  if (!validDate(date) || !Number.isInteger(days)) throw new Error('日期无效');
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function osloIso(date, hour) {
  if (!validDate(date) || ![9, 16].includes(hour)) throw new Error('取还日期无效');
  const year = Number(date.slice(0, 4));
  const summerStart = `${year}-03-${String(lastSunday(year, 2)).padStart(2, '0')}`;
  const summerEnd = `${year}-10-${String(lastSunday(year, 9)).padStart(2, '0')}`;
  // 09:00 and 16:00 are after the 02:00/03:00 DST transition on both dates.
  const offset = date >= summerStart && date < summerEnd ? 2 : 1;
  return new Date(Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`) - offset * 3600000).toISOString();
}

function windowPayload(storeId, pickupDate, returnDate, now = new Date()) {
  const id = Number(storeId);
  if (!Number.isInteger(id) || id < 1) throw new Error('请选择取货门店');
  if (!validDate(pickupDate) || !validDate(returnDate)) throw new Error('请选择完整有效的日期');
  const today = osloToday(now);
  const currentHour = Number(new Date(now.getTime() + osloOffsetAt(now) * 3600000).toISOString().slice(11, 13));
  if (pickupDate < (currentHour >= 9 ? addCalendarDays(today, 1) : today)) throw new Error('当天 09:00 取货时间已过，请选择之后的日期');
  if (returnDate < pickupDate) throw new Error('归还日期不能早于起租日期');
  if (returnDate > addCalendarDays(pickupDate, 29)) throw new Error('单笔预约最多计费 30 天');
  return { storeId: id, pickupAt: osloIso(pickupDate, 9), returnAt: osloIso(returnDate, 16) };
}

function normalizeCart(saved) {
  if (!Array.isArray(saved)) return [];
  const quantities = new Map();
  for (const line of saved) {
    const id = Number(line && line.variantId);
    const qty = Number(line && line.qty);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(qty) || qty < 1) continue;
    quantities.set(id, Math.min(5, (quantities.get(id) || 0) + qty));
  }
  return Array.from(quantities, ([variantId, qty]) => ({ variantId, qty })).slice(0, 12);
}

function changeCart(cart, variantId, delta, available) {
  const id = Number(variantId), max = Math.min(5, Number(available));
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(delta) || !Number.isInteger(max) || max < 0) {
    throw new Error('装备数量无效');
  }
  const current = normalizeCart(cart);
  const existing = current.find(line => line.variantId === id);
  const next = (existing?.qty || 0) + delta;
  if (next > max) throw new Error(`所选日期段最多还可预订 ${max} 件`);
  if (next > 5) throw new Error('同一规格最多预订 5 件');
  if (next > 0 && !existing && current.length >= 12) throw new Error('单笔最多选择 12 种装备');
  return normalizeCart([...current.filter(line => line.variantId !== id), ...(next > 0 ? [{ variantId: id, qty: next }] : [])]);
}

function reservationPayload(window, cart, skill, consent) {
  if (!['初级', '中级', '高级', '专家+'].includes(skill)) throw new Error('请选择本次滑雪水平');
  const items = normalizeCart(cart);
  if (!items.length) throw new Error('请先选择装备');
  if (!consent || consent.accepted !== true || consent.readToEnd !== true || !consent.version) {
    throw new Error('请完整阅读并同意当前损坏与押金规则');
  }
  return { ...window, items, customerSkill: skill, damageConsent: consent };
}

function newRequestKey(now = Date.now(), random = Math.random()) {
  return `mini-${Number(now).toString(36).padStart(8, '0')}-${Math.floor(Number(random) * 0x100000000).toString(36).padStart(7, '0')}`;
}

module.exports = { validDate, osloToday, formatOslo, addCalendarDays, osloIso, windowPayload, normalizeCart, changeCart, reservationPayload, newRequestKey };
