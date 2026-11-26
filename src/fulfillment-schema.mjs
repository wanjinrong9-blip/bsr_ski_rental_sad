function columns(db,table,defs){const names=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const[name,type]of Object.entries(defs))if(!names.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}
export function upgradeFulfillment(db,runMode='demo'){
 const skillLock="CREATE TRIGGER IF NOT EXISTS unit_skill_immutable BEFORE UPDATE OF skill_code ON units WHEN OLD.skill_code IS NOT NULL AND NEW.skill_code IS NOT OLD.skill_code BEGIN SELECT RAISE(ABORT,'equipment skill is immutable after intake'); END;";
 columns(db,'users',{address:"TEXT NOT NULL DEFAULT ''",birth_year:'INTEGER',employee_notes:"TEXT NOT NULL DEFAULT ''"});
 columns(db,'reservations',{customer_skill:'TEXT',customer_snapshot:'TEXT',created_by:'INTEGER REFERENCES users(id)',requires_fulfillment:'INTEGER NOT NULL DEFAULT 0',contract_version:'INTEGER NOT NULL DEFAULT 0'});
 columns(db,'rental_units',{out_at:'TEXT',returned_at:'TEXT',return_store_id:'INTEGER REFERENCES stores(id)'});
 columns(db,'reservation_items',{rental_from:'TEXT',rental_to:'TEXT'});
 columns(db,'units',{home_store_id:'INTEGER REFERENCES stores(id)',needs_cleaning:'INTEGER NOT NULL DEFAULT 0',data_source:"TEXT NOT NULL DEFAULT '录入'"});
 columns(db,'variants',{serialized:'INTEGER NOT NULL DEFAULT 1'});
 columns(db,'maintenance',{rate_id:'INTEGER',hourly_rate_nok:'INTEGER NOT NULL DEFAULT 0',rate_source:"TEXT NOT NULL DEFAULT '历史未登记'"});
 db.exec(`
 CREATE TABLE IF NOT EXISTS preparations(
  reservation_id INTEGER PRIMARY KEY REFERENCES reservations(id),status TEXT NOT NULL DEFAULT 'QUEUED',
  assigned_to INTEGER REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,public_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,ready_at TEXT);
 CREATE TABLE IF NOT EXISTS preparation_units(
  reservation_id INTEGER NOT NULL REFERENCES preparations(reservation_id),item_id INTEGER NOT NULL REFERENCES reservation_items(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),active INTEGER NOT NULL DEFAULT 1,
  size_checked INTEGER NOT NULL DEFAULT 0,clean_checked INTEGER NOT NULL DEFAULT 0,safety_checked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(reservation_id,unit_id));
 CREATE UNIQUE INDEX IF NOT EXISTS idx_prepared_unit_unique ON preparation_units(unit_id) WHERE active=1;
 CREATE TABLE IF NOT EXISTS preparation_events(
  id INTEGER PRIMARY KEY,reservation_id INTEGER NOT NULL REFERENCES preparations(reservation_id),actor_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS contracts(
  id INTEGER PRIMARY KEY,reservation_id INTEGER NOT NULL REFERENCES reservations(id),code TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
  signed_by INTEGER REFERENCES users(id),signed_name TEXT,signed_at TEXT,signature_method TEXT,signature_note TEXT,
  UNIQUE(reservation_id,version));
 CREATE TABLE IF NOT EXISTS contractor_rates(
  id INTEGER PRIMARY KEY,contractor_id INTEGER NOT NULL REFERENCES users(id),effective_from TEXT NOT NULL,hourly_nok INTEGER NOT NULL CHECK(hourly_nok>=0),
  created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,note TEXT NOT NULL,UNIQUE(contractor_id,effective_from));
 CREATE TABLE IF NOT EXISTS contract_adjustments(
  id INTEGER PRIMARY KEY,reservation_id INTEGER NOT NULL REFERENCES reservations(id),reference TEXT NOT NULL,base_version INTEGER NOT NULL,
  rent_delta_nok INTEGER NOT NULL,deposit_delta_nok INTEGER NOT NULL,detail_json TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'DEMO_SUCCEEDED',
  UNIQUE(reservation_id,reference));
 CREATE TABLE IF NOT EXISTS amendment_proposals(
  id INTEGER PRIMARY KEY,reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  created_by INTEGER NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,
  base_version INTEGER NOT NULL,quote_hash TEXT NOT NULL,quote_json TEXT NOT NULL,input_json TEXT NOT NULL,
  return_store_id INTEGER NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','REJECTED','SUPERSEDED','CONSUMED')),
  created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES users(id),confirmed_at TEXT,
  rejected_by INTEGER REFERENCES users(id),rejected_at TEXT,
  consumed_at TEXT,consumed_adjustment_id INTEGER REFERENCES contract_adjustments(id));
 CREATE UNIQUE INDEX IF NOT EXISTS idx_amendment_proposal_request ON amendment_proposals(created_by,request_key);
 CREATE INDEX IF NOT EXISTS idx_amendment_proposal_order ON amendment_proposals(reservation_id,id);
 `);
 columns(db,'contract_adjustments',{proposal_id:'INTEGER REFERENCES amendment_proposals(id)'});
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_adjustment_proposal_unique ON contract_adjustments(proposal_id) WHERE proposal_id IS NOT NULL');
 if(db.prepare("SELECT 1 FROM app_migrations WHERE name='fulfillment-v5'").get()){db.exec(skillLock);return;}
 // SHOWCASE shares the schema but must not receive course DEMO customer
 // profiles, policy values or sample preparations.
 if(runMode!=='demo'){
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run('fulfillment-v5',new Date().toISOString());
  db.exec(skillLock);
  return;
 }
 db.exec('BEGIN IMMEDIATE');try{
  db.prepare('UPDATE units SET home_store_id=store_id,data_source=? WHERE home_store_id IS NULL').run('课程演示补录（非真实采购凭证）');
  const skills={1:'初级',2:'中级',3:'高级',4:'初级',5:'高级',6:'初级',7:'初级',10:'中级',11:'初级',12:'专家+'};
  for(const[id,skill]of Object.entries(skills)){db.prepare('UPDATE variants SET skill=? WHERE id=?').run(skill,id);db.prepare('UPDATE units SET skill_code=? WHERE variant_id=?').run(skill,id);}
  db.prepare("UPDATE variants SET serialized=0 WHERE visual='poles'").run();
  db.prepare(`UPDATE rental_units SET out_at=(SELECT picked_up_at FROM reservations r JOIN reservation_items ri ON ri.reservation_id=r.id WHERE ri.id=reservation_item_id),returned_at=CASE WHEN returned=1 THEN (SELECT returned_at FROM reservations r JOIN reservation_items ri ON ri.reservation_id=r.id WHERE ri.id=reservation_item_id) END,return_store_id=CASE WHEN returned=1 THEN (SELECT store_id FROM units WHERE id=unit_id) END`).run();
  const at=new Date().toISOString();
  db.prepare("UPDATE users SET address='课程演示地址：Skardalen, Norway',birth_year=1998,height_cm=COALESCE(height_cm,172),weight_kg=COALESCE(weight_kg,65),shoe_size=CASE WHEN COALESCE(shoe_size,'')='' THEN 'EU 42' ELSE shoe_size END,phone=CASE WHEN COALESCE(phone,'')='' THEN '+47 9000 1001' ELSE phone END WHERE email='customer@bsr.demo' AND address='' AND birth_year IS NULL").run();
  for(const u of db.prepare("SELECT id FROM users WHERE role='contractor' AND email LIKE '%@bsr.demo'").all())db.prepare("INSERT OR IGNORE INTO contractor_rates(contractor_id,effective_from,hourly_nok,created_by,created_at,note) VALUES(?,'2026-01-01',350,3,?,'课程演示费率，非真实承包合同')").run(u.id,at);
  db.prepare("INSERT OR IGNORE INTO preparations(reservation_id,status,assigned_to,created_at,updated_at) SELECT id,'QUEUED',assigned_staff_id,?,? FROM reservations WHERE status IN ('CONFIRMED','READY')").run(at,at);
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run('fulfillment-v5',at);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 db.exec(skillLock);
}
