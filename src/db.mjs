import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync,mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {upgradeCatalog} from './catalog-upgrade.mjs';
import {upgradeFulfillment} from './fulfillment-schema.mjs';
import {upgradeRentalPolicy} from './rental-policy.mjs';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const schema = `
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, subtitle TEXT NOT NULL,
  address TEXT NOT NULL, open_hours TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_name_unique ON stores(name);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN
  ('customer','staff','manager','contractor','owner','admin')),
  store_id INTEGER REFERENCES stores(id), phone TEXT DEFAULT '',
  height_cm INTEGER, weight_kg INTEGER, shoe_size TEXT, created_at TEXT NOT NULL,
  account_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(account_state IN ('ACTIVE','DISABLED')),
  provisioning_method TEXT CHECK(provisioning_method IN ('OFFLINE_ADMIN','VERIFIED_SELF')),
  verified_at TEXT, must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch>=1)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, issued_at TEXT,
  auth_epoch INTEGER NOT NULL DEFAULT 1, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_attempt_buckets (
  dimension TEXT NOT NULL CHECK(dimension IN ('ACCOUNT','SOURCE')),
  key_hash TEXT NOT NULL, window_started_at TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_count>=0),
  blocked_until TEXT, PRIMARY KEY(dimension,key_hash)
);
CREATE TABLE IF NOT EXISTS runtime_installation (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  run_mode TEXT NOT NULL CHECK(run_mode IN ('DEMO','CANDIDATE','SHOWCASE')),
  instance_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version>=0),
  init_state TEXT NOT NULL CHECK(init_state IN ('INITIALIZING','READY','BLOCKED')),
  initialized_at TEXT, initial_admin_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS runtime_checks (
  id INTEGER PRIMARY KEY, instance_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('INIT','START','RESTORE')),
  result TEXT NOT NULL CHECK(result IN ('PASS','BLOCK')),
  reason_code TEXT NOT NULL, checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS showcase_dataset (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  instance_id TEXT NOT NULL UNIQUE REFERENCES runtime_installation(instance_id),
  dataset_version INTEGER NOT NULL CHECK(dataset_version>=1),
  synthetic INTEGER NOT NULL CHECK(synthetic=1),
  created_at TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS initial_admin_event (
  instance_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  operator_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  style TEXT NOT NULL, size TEXT NOT NULL, skill TEXT NOT NULL,
  description TEXT NOT NULL, visual TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY, inventory_no TEXT NOT NULL UNIQUE,
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL CHECK(status IN
  ('AVAILABLE','RENTED','MAINTENANCE','TRANSFER','RETIRED')) DEFAULT 'AVAILABLE',
  condition_note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customer_carts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  store_id INTEGER NOT NULL REFERENCES stores(id),
  pickup_at TEXT NOT NULL,
  return_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_cart_lines (
  cart_id INTEGER NOT NULL REFERENCES customer_carts(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(cart_id,variant_id)
);
CREATE TABLE IF NOT EXISTS wechat_bindings (
  id INTEGER PRIMARY KEY,
  app_id TEXT NOT NULL, openid_digest TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bound_at TEXT NOT NULL, unbound_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  proof_method TEXT NOT NULL CHECK(proof_method='ACCOUNT_PASSWORD'),
  proof_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_bindings_openid_active
  ON wechat_bindings(app_id,openid_digest) WHERE unbound_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_bindings_customer_active
  ON wechat_bindings(app_id,user_id) WHERE unbound_at IS NULL;
CREATE TABLE IF NOT EXISTS mini_login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL, openid_digest TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  consumed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0)
);
CREATE INDEX IF NOT EXISTS idx_mini_challenge_expiry ON mini_login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS mini_code_uses (
  code_digest TEXT PRIMARY KEY, app_id TEXT NOT NULL,
  used_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mini_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  binding_id INTEGER NOT NULL REFERENCES wechat_bindings(id),
  app_id TEXT NOT NULL, issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=1)
);
CREATE INDEX IF NOT EXISTS idx_mini_sessions_user ON mini_sessions(user_id,revoked_at);
CREATE TABLE IF NOT EXISTS mini_quotes (
  quote_id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  cart_version INTEGER NOT NULL CHECK(cart_version>=1),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  cart_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mini_quotes_customer ON mini_quotes(customer_id,expires_at);
CREATE TABLE IF NOT EXISTS price_policies (
  id INTEGER PRIMARY KEY, variant_id INTEGER NOT NULL REFERENCES variants(id),
  store_id INTEGER NOT NULL REFERENCES stores(id), version INTEGER NOT NULL,
  daily_nok INTEGER NOT NULL CHECK(daily_nok >= 0),
  deposit_nok INTEGER NOT NULL CHECK(deposit_nok >= 0),
  extra_day_factor REAL NOT NULL DEFAULT 0.8,
  effective_from TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED')),
  approved_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(variant_id, store_id, version)
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id), store_id INTEGER NOT NULL REFERENCES stores(id),
  pickup_at TEXT NOT NULL, return_at TEXT NOT NULL, status TEXT NOT NULL,
  rent_nok INTEGER NOT NULL, deposit_nok INTEGER NOT NULL, total_nok INTEGER NOT NULL,
  pickup_code TEXT NOT NULL UNIQUE, quote_json TEXT NOT NULL,
  hold_expires_at TEXT, paid_at TEXT, picked_up_at TEXT, returned_at TEXT,
  refund_status TEXT NOT NULL DEFAULT 'NOT_DUE', refund_nok INTEGER DEFAULT 0,
  cancellation_fee_nok INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservation_requests (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK(channel IN ('ONLINE','COUNTER')),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 16 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,channel,request_key)
);
CREATE TABLE IF NOT EXISTS reservation_items (
  id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  variant_id INTEGER NOT NULL REFERENCES variants(id), qty INTEGER NOT NULL CHECK(qty > 0),
  unit_rent_nok INTEGER NOT NULL, unit_deposit_nok INTEGER NOT NULL,
  policy_id INTEGER NOT NULL REFERENCES price_policies(id)
);
CREATE TABLE IF NOT EXISTS rental_units (
  reservation_item_id INTEGER NOT NULL REFERENCES reservation_items(id),
  unit_id INTEGER NOT NULL REFERENCES units(id), returned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(reservation_item_id, unit_id)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  type TEXT NOT NULL CHECK(type IN ('RENT','DEPOSIT','REFUND','CANCELLATION_REFUND')),
  amount_nok INTEGER NOT NULL, status TEXT NOT NULL, provider_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  unit_id INTEGER NOT NULL REFERENCES units(id), condition TEXT NOT NULL,
  note TEXT NOT NULL, fee_nok INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0, inspected_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, UNIQUE(reservation_id, unit_id)
);
CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id),
  contractor_id INTEGER REFERENCES users(id), store_id INTEGER NOT NULL REFERENCES stores(id),
  issue TEXT NOT NULL, status TEXT NOT NULL, result TEXT DEFAULT '',
  hours REAL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id),
  from_store_id INTEGER NOT NULL REFERENCES stores(id),
  to_store_id INTEGER NOT NULL REFERENCES stores(id), status TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  received_at TEXT
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  store_id INTEGER NOT NULL REFERENCES stores(id), work_date TEXT NOT NULL,
  start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  UNIQUE(user_id, work_date)
);
CREATE TABLE IF NOT EXISTS employee_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id), employee_no TEXT NOT NULL UNIQUE,
  department TEXT NOT NULL, job_title TEXT NOT NULL, expertise TEXT DEFAULT '',
  qualification TEXT DEFAULT '', joined_on TEXT NOT NULL, work_location TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL, store_id INTEGER REFERENCES stores(id),
  clock_in_at TEXT NOT NULL, clock_out_at TEXT, note TEXT DEFAULT '',
  UNIQUE(user_id,work_date)
);
CREATE TABLE IF NOT EXISTS maintenance_events (
  id INTEGER PRIMARY KEY, maintenance_id INTEGER NOT NULL REFERENCES maintenance(id),
  actor_id INTEGER REFERENCES users(id), event TEXT NOT NULL, from_status TEXT,
  to_status TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_events (
  id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id),
  from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  from_store_id INTEGER NOT NULL, to_store_id INTEGER NOT NULL,
  note TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS unit_movement AFTER UPDATE OF status,store_id ON units
WHEN OLD.status <> NEW.status OR OLD.store_id <> NEW.store_id
BEGIN
  INSERT INTO stock_events(unit_id,from_status,to_status,from_store_id,to_store_id,note,created_at)
  VALUES(NEW.id,OLD.status,NEW.status,OLD.store_id,NEW.store_id,NEW.condition_note,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_alert_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  reservation_id INTEGER NOT NULL REFERENCES reservations(id), read_at TEXT NOT NULL,
  PRIMARY KEY(user_id,reservation_id)
);
CREATE TABLE IF NOT EXISTS maintenance_alert_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  maintenance_id INTEGER NOT NULL REFERENCES maintenance(id),
  notice_version INTEGER NOT NULL DEFAULT 0, read_at TEXT NOT NULL,
  PRIMARY KEY(user_id,maintenance_id)
);
CREATE TABLE IF NOT EXISTS damage_consents (
  reservation_id INTEGER PRIMARY KEY REFERENCES reservations(id), user_id INTEGER NOT NULL REFERENCES users(id),
  policy_version TEXT NOT NULL, policy_json TEXT NOT NULL, accepted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS damage_cases (
  id INTEGER PRIMARY KEY, inspection_id INTEGER NOT NULL UNIQUE REFERENCES inspections(id),
  reservation_id INTEGER NOT NULL REFERENCES reservations(id), unit_id INTEGER NOT NULL REFERENCES units(id),
  maintenance_id INTEGER UNIQUE REFERENCES maintenance(id), assessor_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','RETURNED','APPROVED')),
  grade TEXT, part TEXT NOT NULL DEFAULT '', diagnosis TEXT NOT NULL DEFAULT '',
  labor_nok INTEGER NOT NULL DEFAULT 0 CHECK(labor_nok>=0), parts_nok INTEGER NOT NULL DEFAULT 0 CHECK(parts_nok>=0),
  replacement_nok INTEGER NOT NULL DEFAULT 0 CHECK(replacement_nok>=0), value_basis TEXT NOT NULL DEFAULT '',
  fee_nok INTEGER NOT NULL DEFAULT 0 CHECK(fee_nok>=0), version INTEGER NOT NULL DEFAULT 1,
  review_note TEXT NOT NULL DEFAULT '', approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL, submitted_at TEXT, approved_at TEXT
);
CREATE TABLE IF NOT EXISTS damage_photos (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES damage_cases(id),
  uploaded_by INTEGER NOT NULL REFERENCES users(id), part TEXT NOT NULL, caption TEXT NOT NULL,
  mime TEXT NOT NULL, image BLOB NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS damage_case_events (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES damage_cases(id),
  actor_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS damage_settlements (
  reservation_id INTEGER PRIMARY KEY REFERENCES reservations(id), total_fee_nok INTEGER NOT NULL CHECK(total_fee_nok>=0),
  deducted_nok INTEGER NOT NULL CHECK(deducted_nok>=0), refund_nok INTEGER NOT NULL CHECK(refund_nok>=0),
  supplement_nok INTEGER NOT NULL CHECK(supplement_nok>=0), paid_nok INTEGER NOT NULL DEFAULT 0 CHECK(paid_nok>=0),
  status TEXT NOT NULL CHECK(status IN ('AWAITING_CONTACT','CONTACTED','DISPUTED','SETTLED')),
  version INTEGER NOT NULL DEFAULT 1, approved_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, settled_at TEXT
);
CREATE TABLE IF NOT EXISTS damage_contacts (
  id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  actor_id INTEGER NOT NULL REFERENCES users(id), channel TEXT NOT NULL, outcome TEXT NOT NULL,
  note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS damage_receipts (
  id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES damage_settlements(reservation_id),
  amount_nok INTEGER NOT NULL CHECK(amount_nok>0), reference TEXT NOT NULL, recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, UNIQUE(reservation_id,reference)
);
CREATE INDEX IF NOT EXISTS idx_damage_assessor ON damage_cases(assessor_id,status);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id INTEGER,
  detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservation_window ON reservations(store_id,pickup_at,return_at,status);
CREATE INDEX IF NOT EXISTS idx_units_variant_store ON units(variant_id,store_id,status);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
`;

const catalog = [
  ['北境全山地双板','双板','全山地','158 cm','初中级','稳定灵活，适合雪道巡航与进阶转弯。','ski'],
  ['北境全山地双板','双板','全山地','168 cm','中高级','兼顾速度与控制，适合多种雪况。','ski'],
  ['极光粉雪双板','双板','粉雪','176 cm','高级','更宽的板腰与轻盈浮力，探索深雪地形。','powder'],
  ['Fjord 单板','单板','自由式','148 cm','初中级','柔和弹性，适合练习基础动作。','board'],
  ['Fjord 单板','单板','自由式','158 cm','中高级','清晰的刃感与可靠的高速稳定性。','board'],
  ['Nordic 雪鞋','雪鞋','舒适支撑','EU 39','初中级','保暖贴合，全天滑行依然舒适。','boots'],
  ['Nordic 雪鞋','雪鞋','舒适支撑','EU 42','初中级','可调节贴合度，提供稳固支撑。','boots'],
  ['Summit 头盔','护具','轻量防护','M','全部','轻量通风结构，适合不同雪况。','helmet'],
  ['Summit 头盔','护具','轻量防护','L','全部','轻量通风结构，适合不同雪况。','helmet'],
  ['Arc 雪杖','配件','铝合金','115 cm','全部','稳定可靠的雪道伙伴。','poles'],
  ['Junior 儿童套装','套装','儿童入门','120 cm / EU 32','初级','双板、雪鞋和雪杖组合，适合初次上雪。','junior'],
  ['Alpine Pro 进阶套装','套装','高性能','170 cm / EU 42','中高级','精心搭配的双板、雪鞋与雪杖。','premium']
];

const rates = [420,460,790,430,470,190,190,95,95,75,350,820];
const deposits = [900,900,1400,900,900,400,400,250,250,150,750,1600];

function seed(db) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO stores(id,name,subtitle,address,open_hours) VALUES(?,?,?,?,?)').run(1,'Skardalen Base','山脚旗舰店','Skardalen 18, Troms, Norway','08:00–20:00');
  db.prepare('INSERT INTO stores(id,name,subtitle,address,open_hours) VALUES(?,?,?,?,?)').run(2,'Skardalen North','北坡服务站','Nordveien 6, Troms, Norway','08:30–19:00');
  const accounts = [
    [1,'林雪','customer@bsr.demo','customer',null],
    [2,'Emma Berg','staff@bsr.demo','staff',1],
    [3,'Ole Fjordal','manager@bsr.demo','manager',1],
    [4,'Jonas Vik','contractor@bsr.demo','contractor',null],
    [5,'BSR 经营分析','owner@bsr.demo','owner',null],
    [6,'系统管理员','admin@bsr.demo','admin',null],
    [7,'Nora Lund','staff2@bsr.demo','staff',2]
  ];
  for (const [id,name,email,role,store] of accounts) {
    db.prepare('INSERT INTO users(id,name,email,password_hash,role,store_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,name,email,hashPassword('Demo123!'),role,store,now);
  }
  const insertVariant = db.prepare('INSERT INTO variants(id,name,category,style,size,skill,description,visual) VALUES(?,?,?,?,?,?,?,?)');
  const insertUnit = db.prepare('INSERT INTO units(inventory_no,variant_id,store_id,status) VALUES(?,?,?,?)');
  const insertPolicy = db.prepare('INSERT INTO price_policies(variant_id,store_id,version,daily_nok,deposit_nok,extra_day_factor,effective_from,status,approved_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  catalog.forEach((row,index) => {
    const variantId = index + 1;
    insertVariant.run(variantId,...row);
    for (const storeId of [1,2]) {
      const count = row[1] === '套装' ? 4 : 6;
      for (let serial = 1; serial <= count; serial++) {
        const inventoryNo = `BSR-${storeId}-${String(variantId).padStart(2,'0')}-${String(serial).padStart(3,'0')}`;
        insertUnit.run(inventoryNo,variantId,storeId,'AVAILABLE');
      }
      insertPolicy.run(variantId,storeId,1,rates[index]+(storeId===2?20:0),deposits[index],0.8,'2026-01-01','APPROVED',3,now);
    }
  });
  const damaged = db.prepare("SELECT id FROM units WHERE variant_id=3 AND store_id=1 ORDER BY id LIMIT 1").get();
  db.prepare("UPDATE units SET status='MAINTENANCE', condition_note='固定器松动' WHERE id=?").run(damaged.id);
  db.prepare('INSERT INTO maintenance(unit_id,contractor_id,store_id,issue,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(damaged.id,4,1,'固定器松动，需要安全检查','ASSIGNED',now,now);
  const staff = db.prepare("SELECT id FROM users WHERE role='staff'").all();
  for (const [offset,user] of staff.entries()) {
    const date = new Date(Date.now() + (offset+1)*86400000).toISOString().slice(0,10);
    db.prepare('INSERT INTO shifts(user_id,store_id,work_date,start_time,end_time) VALUES(?,?,?,?,?)')
      .run(user.id,offset+1,date,'08:00','16:00');
  }
  db.prepare('INSERT INTO notifications(user_id,title,body,created_at) VALUES(?,?,?,?)')
    .run(1,'欢迎来到 BSR','选择取货日期和装备规格，即可查看真实可用量与 NOK 正式报价。',now);
  seedDemoOrders(db);
}

function seedDemoOrders(db) {
  const iso = days => new Date(Date.now()+days*86400000).toISOString();
  const scenarios = [
    {code:'BR-DEMO001',variantId:1,status:'CONFIRMED',pickup:1,return:2,rent:420,deposit:900},
    {code:'BR-DEMO002',variantId:4,status:'ACTIVE',pickup:-1,return:1,rent:774,deposit:900},
    {code:'BR-DEMO003',variantId:8,status:'REVIEW',pickup:-4,return:-3,rent:95,deposit:250},
    {code:'BR-DEMO004',variantId:11,status:'COMPLETED',pickup:-8,return:-7,rent:350,deposit:750}
  ];
  for (const [index,s] of scenarios.entries()) {
    const policy=db.prepare('SELECT id,daily_nok FROM price_policies WHERE variant_id=? AND store_id=1 AND version=1').get(s.variantId);
    const pickup=iso(s.pickup),returnAt=iso(s.return);
    const variant=db.prepare('SELECT name,size,category FROM variants WHERE id=?').get(s.variantId);
    const quote={storeId:1,pickupAt:pickup,returnAt,days:s.return-s.pickup,
      lines:[{variantId:s.variantId,name:variant.name,size:variant.size,category:variant.category,
        qty:1,unitRentNok:s.rent,unitDepositNok:s.deposit,policyId:policy.id,policyVersion:1}],
      rentNok:s.rent,depositNok:s.deposit,totalNok:s.rent+s.deposit,currency:'NOK'};
    const id=Number(db.prepare(`INSERT INTO reservations
      (code,user_id,store_id,pickup_at,return_at,status,rent_nok,deposit_nok,total_nok,
       pickup_code,quote_json,hold_expires_at,paid_at,picked_up_at,returned_at,refund_status,refund_nok,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.code,1,1,pickup,returnAt,s.status,
      s.rent,s.deposit,s.rent+s.deposit,`D0A00${index+1}`,JSON.stringify(quote),null,iso(s.pickup-1),
      s.status==='CONFIRMED'?null:pickup,['REVIEW','COMPLETED'].includes(s.status)?returnAt:null,
      s.status==='REVIEW'?'REVIEW':s.status==='COMPLETED'?'REFUNDED':'NOT_DUE',
      s.status==='COMPLETED'?s.deposit:0,iso(s.pickup-1)).lastInsertRowid);
    const line=Number(db.prepare(`INSERT INTO reservation_items
      (reservation_id,variant_id,qty,unit_rent_nok,unit_deposit_nok,policy_id)
      VALUES(?,?,?,?,?,?)`).run(id,s.variantId,1,s.rent,s.deposit,policy.id).lastInsertRowid);
    for(const [type,amount] of [['RENT',s.rent],['DEPOSIT',s.deposit]])
      db.prepare(`INSERT INTO payments(reservation_id,type,amount_nok,status,provider_ref,idempotency_key,created_at)
        VALUES(?,?,?,'SUCCEEDED',?,?,?)`).run(id,type,amount,`DEMO-SEED-${id}`,`seed:${type}:${id}`,iso(s.pickup-1));
    if(s.status!=='CONFIRMED') {
      const unit=db.prepare("SELECT id FROM units WHERE variant_id=? AND store_id=1 AND status='AVAILABLE' ORDER BY id LIMIT 1").get(s.variantId);
      db.prepare('INSERT INTO rental_units(reservation_item_id,unit_id,returned) VALUES(?,?,?)')
        .run(line,unit.id,s.status==='ACTIVE'?0:1);
      if(s.status==='ACTIVE') db.prepare("UPDATE units SET status='RENTED' WHERE id=?").run(unit.id);
      if(s.status==='REVIEW') {
        db.prepare("UPDATE units SET status='MAINTENANCE',condition_note='边刃损伤，待复核' WHERE id=?").run(unit.id);
        db.prepare(`INSERT INTO inspections(reservation_id,unit_id,condition,note,fee_nok,inspected_by,created_at)
          VALUES(?,?,'DAMAGED','边刃损伤，待经理复核',80,2,?)`).run(id,unit.id,returnAt);
        db.prepare(`INSERT INTO maintenance(unit_id,contractor_id,store_id,issue,status,created_at,updated_at)
          VALUES(?,4,1,'边刃损伤','ASSIGNED',?,?)`).run(unit.id,returnAt,returnAt);
      }
      if(s.status==='COMPLETED') {
        db.prepare(`INSERT INTO inspections(reservation_id,unit_id,condition,note,fee_nok,approved,inspected_by,created_at)
          VALUES(?,?,'GOOD','外观和功能正常',0,1,2,?)`).run(id,unit.id,returnAt);
        db.prepare(`INSERT INTO payments(reservation_id,type,amount_nok,status,provider_ref,idempotency_key,created_at)
          VALUES(?,'REFUND',?,'SUCCEEDED',?,?,?)`).run(id,s.deposit,`DEMO-REFUND-${id}`,`seed:refund:${id}`,returnAt);
      }
    }
  }
}

export const CANDIDATE_SCHEMA_VERSION=1;
export const SHOWCASE_SCHEMA_VERSION=1;

function existingInstallation(file){
  if(!existsSync(file))return null;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_installation'").get();
    return table?db.prepare('SELECT * FROM runtime_installation WHERE singleton_id=1').get()||{run_mode:'UNKNOWN'}:{run_mode:'LEGACY'};
  }finally{db.close();}
}

function ensureIdentityColumns(db){
  const add=(table,definitions)=>{
    const current=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
    for(const [name,definition] of Object.entries(definitions))
      if(!current.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  add('users',{
    account_state:"TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(account_state IN ('ACTIVE','DISABLED'))",
    provisioning_method:"TEXT CHECK(provisioning_method IN ('OFFLINE_ADMIN','VERIFIED_SELF'))",
    verified_at:'TEXT',must_change_password:'INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1))',
    auth_epoch:'INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch>=1)'
  });
  add('sessions',{issued_at:'TEXT',auth_epoch:'INTEGER NOT NULL DEFAULT 1',revoked_at:'TEXT'});
  add('mini_quotes',{cart_json:"TEXT NOT NULL DEFAULT '{}'"});
}

export function openDb(file,{runMode='demo',initialize=false}={}){
  if(!['demo','candidate','showcase'].includes(runMode))throw new Error('运行用途无效');
  const prior=existingInstallation(file);
  if(runMode==='candidate'||runMode==='showcase'){
    const expected=runMode.toUpperCase();
    const version=runMode==='candidate'?CANDIDATE_SCHEMA_VERSION:SHOWCASE_SCHEMA_VERSION;
    if(initialize){
      if(prior)throw new Error(`${runMode==='candidate'?'候选':'合成预览'}初始化只允许全新数据文件`);
    }else if(prior?.run_mode!==expected||prior.init_state!=='READY'||prior.schema_version>version)
      throw new Error(`${runMode==='candidate'?'候选':'合成预览'}数据来源或初始化状态不受信任`);
  }else if(prior?.run_mode==='CANDIDATE')throw new Error('候选数据空间不能以演示用途打开');
  else if(prior?.run_mode==='SHOWCASE')throw new Error('合成预览数据空间不能以演示用途打开');
  if(runMode!=='demo'&&!initialize&&!existsSync(file))throw new Error(`${runMode==='candidate'?'候选':'合成预览'}数据文件不存在`);
  if(runMode==='demo'||initialize)mkdirSync(dirname(file),{recursive:true});
  const db=new DatabaseSync(file);
  try{
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(schema);
    ensureIdentityColumns(db);
    if(runMode==='demo'){
      if(db.prepare('SELECT COUNT(*) AS n FROM stores').get().n===0)seed(db);
      else if(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n===0)seedDemoOrders(db);
    }
    upgradeOperations(db,runMode);
    upgradeDamage(db);
    upgradeCatalog(db,runMode);
    upgradeFulfillment(db,runMode);
    upgradeRentalPolicy(db);
    if(runMode==='demo'&&!prior)
      db.prepare("INSERT INTO runtime_installation(singleton_id,run_mode,instance_id,schema_version,init_state,initialized_at) VALUES(1,'DEMO',?,1,'READY',?)")
        .run(randomBytes(16).toString('hex'),new Date().toISOString());
    return db;
  }catch(error){db.close();throw error;}
}

function upgradeDamage(db){
  // Preserve historical paid/closed records. Only unresolved damaged inspections need assessment backfill.
  const inspector=db.prepare("SELECT id FROM users WHERE role='contractor' ORDER BY id LIMIT 1").get();
  const rows=db.prepare(`SELECT i.* FROM inspections i JOIN reservations r ON r.id=i.reservation_id
    WHERE i.condition='DAMAGED' AND r.status='REVIEW' AND NOT EXISTS(SELECT 1 FROM damage_cases c WHERE c.inspection_id=i.id)`).all();
  for(const row of rows){
    const task=db.prepare('SELECT id,contractor_id FROM maintenance WHERE unit_id=? AND created_at=? ORDER BY id DESC LIMIT 1').get(row.unit_id,row.created_at);
    db.prepare(`INSERT INTO damage_cases(inspection_id,reservation_id,unit_id,maintenance_id,assessor_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(row.id,row.reservation_id,row.unit_id,task?.id||null,task?.contractor_id||inspector?.id||null,new Date().toISOString());
  }
}

function upgradeOperations(db,runMode='demo') {
  const columns=new Set(db.prepare('PRAGMA table_info(maintenance)').all().map(c=>c.name));
  for(const [name,type] of Object.entries({priority:"TEXT NOT NULL DEFAULT 'NORMAL'",diagnosis:"TEXT DEFAULT ''",parts:"TEXT DEFAULT ''",cost_nok:'INTEGER NOT NULL DEFAULT 0',due_at:'TEXT',checklist_json:"TEXT NOT NULL DEFAULT '{}'",version:'INTEGER NOT NULL DEFAULT 1',completed_at:'TEXT',review_note:"TEXT DEFAULT ''"})) {
    if(!columns.has(name))db.exec(`ALTER TABLE maintenance ADD COLUMN ${name} ${type}`);
  }
  if(db.prepare("SELECT name FROM app_migrations WHERE name='operations-v2'").get())return;
  const now=new Date().toISOString();
  if(runMode!=='demo'){
    db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run('operations-v2',now);
    return;
  }
  const departments={staff:['门店服务','租赁顾问'],manager:['门店运营','门店经理'],contractor:['装备技术','维修技师'],owner:['经营管理','经营负责人'],admin:['信息技术','系统管理员']};
  for(const user of db.prepare("SELECT * FROM users WHERE role<>'customer'").all()) {
    const [department,title]=departments[user.role];
    db.prepare(`INSERT OR IGNORE INTO employee_profiles(user_id,employee_no,department,job_title,expertise,qualification,joined_on,work_location) VALUES(?,?,?,?,?,?,?,?)`)
      .run(user.id,`BSR-${String(user.id).padStart(4,'0')}`,department,title,user.role==='contractor'?'双板固定器调校 · 板底养护 · 安全检测':'门店协作 · 客户服务',user.role==='contractor'?'演示档案：装备维护与安全培训':'演示档案：岗位安全培训','2025-11-01',user.store_id?'所属门店':'跨门店支持');
    if(!user.phone&&user.email.endsWith('@bsr.demo'))db.prepare('UPDATE users SET phone=? WHERE id=?').run(`+47 9000 ${String(1000+user.id)}`,user.id);
  }
  db.prepare("UPDATE maintenance SET due_at=datetime(created_at,'+2 days') WHERE due_at IS NULL").run();
  db.prepare(`INSERT INTO maintenance_events(maintenance_id,actor_id,event,to_status,note,created_at)
    SELECT m.id,m.contractor_id,'CREATED',m.status,m.issue,m.created_at FROM maintenance m
    WHERE NOT EXISTS(SELECT 1 FROM maintenance_events e WHERE e.maintenance_id=m.id)`).run();
  // 仅为本地演示账号补充本周排班，保留已有班次。
  for(let offset=0;offset<7;offset++) {
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+offset*86400000));
    for(const user of db.prepare("SELECT * FROM users WHERE email LIKE '%@bsr.demo' AND ((role IN ('staff','manager') AND store_id IS NOT NULL) OR role='contractor')").all()) {
      db.prepare('INSERT OR IGNORE INTO shifts(user_id,store_id,work_date,start_time,end_time) VALUES(?,?,?,?,?)').run(user.id,user.store_id||1,date,user.role==='contractor'?'09:00':'08:00',user.role==='contractor'?'17:00':'16:00');
    }
  }
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run('operations-v2',now);
}

export function audit(db, actor, action, type, id, detail = {}) {
  db.prepare('INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(actor ?? null,action,type,id ?? null,JSON.stringify(detail),new Date().toISOString());
}

export function notify(db, userId, title, body) {
  db.prepare('INSERT INTO notifications(user_id,title,body,created_at) VALUES(?,?,?,?)')
    .run(userId,title,body,new Date().toISOString());
}
