export const depositRule={rate:0.08,basis:'RETAIL',label:'每件装备参考价值的 8%',currency:'NOK',rounding:'按整数 NOK 四舍五入',demo:true};
export function depositFor(variant,unitRentNok){return Math.round(Number(depositRule.basis==='RENT'?unitRentNok:variant.retail_nok)*depositRule.rate);}
const coreValues=[4500,5200,9000,4800,5600,1800,1800,900,1000,500,5000,12000];
const additions=[
 ['Aurora 全景滑雪镜','配件','防雾镜片','成人 M','护目镜','可调头带与防雾双层镜片，需现场试戴。','goggles',90,700],
 ['Aurora 全景滑雪镜','配件','防雾镜片','成人 L','护目镜','宽视野镜片，适配大多数滑雪头盔。','goggles',90,700],
 ['Junior 儿童滑雪镜','配件','儿童防雾','儿童','护目镜','儿童面型与防滑头带，需现场试戴。','goggles',65,450],
 ...['S','M','L'].map(size=>['Flex 防冲击护膝','护具','双侧软壳',size,'护膝','一对装，缓冲膝部冲击，现场确认松紧。','kneepads',55,500]),
 ...['M','L'].map(size=>['Flex 护肘','护具','轻量防护',size,'护肘','柔性防护片与弹性绑带。','kneepads',45,350]),
 ...['S / M','L / XL'].map(size=>['SafeTurn 护腕','护具','单板支撑',size,'护腕','腕部支撑设计，需现场试戴匹配。','gloves',45,400]),
 ...['M','L'].map(size=>['Ridge 背部护具','护具','分段式护背',size,'护背','轻量分段防护，不能替代安全滑行。','protector',95,1200]),
 ...['M','L'].map(size=>['Arctic 保暖手套','配件','防水保暖',size,'手套','消毒与干燥后周转，现场检查防水层。','gloves',65,650]),
 ...['S','M','L'].map(size=>['Nord 防风滑雪服','服装','防水外套',size,'滑雪服','防风防水外层，支持搭配护背试穿。','jacket',180,2200]),
 ...['S','M','L'].map(size=>['Nord 防水滑雪裤','服装','耐磨防水',size,'滑雪裤','雪裙裤脚与保暖设计，按尺码租赁。','pants',130,1500])
];
function columns(db,table,definitions){const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));for(const [name,type]of Object.entries(definitions))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);}
export function upgradeCatalog(db,runMode='demo'){
 columns(db,'variants',{subtype:"TEXT NOT NULL DEFAULT ''",retail_nok:'INTEGER NOT NULL DEFAULT 0'});
 columns(db,'units',{purchase_date:'TEXT',purchase_cost_nok:'INTEGER',retail_nok:'INTEGER',skill_code:'TEXT'});
 columns(db,'reservations',{assigned_staff_id:'INTEGER REFERENCES users(id)',staff_reviewed_by:'INTEGER REFERENCES users(id)',staff_reviewed_at:'TEXT',staff_review_note:'TEXT'});
 columns(db,'damage_cases',{feedback_due_at:'TEXT',first_feedback_at:'TEXT',overdue_notified_at:'TEXT'});
 const migration='service-catalog-v4';if(db.prepare('SELECT 1 FROM app_migrations WHERE name=?').get(migration))return;
 // Columns are shared by every mode; only the course DEMO receives the
 // historical catalog, stock numbers and profile backfill below.
 if(runMode!=='demo'){
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration,new Date().toISOString());
  return;
 }
 db.exec('BEGIN IMMEDIATE');try{
  const now=new Date().toISOString();
  for(let i=0;i<coreValues.length;i++)db.prepare("UPDATE variants SET retail_nok=?,subtype=CASE WHEN subtype='' THEN category ELSE subtype END,skill=CASE WHEN category IN ('护具','配件') THEN '不适用' ELSE skill END WHERE id=? AND retail_nok=0").run(coreValues[i],i+1);
  for(const [name,category,style,size,subtype,description,visual,daily,value]of additions){
   if(db.prepare('SELECT id FROM variants WHERE name=? AND size=?').get(name,size))continue;
   const id=Number(db.prepare("INSERT INTO variants(name,category,style,size,skill,subtype,description,visual,retail_nok) VALUES(?,?,?,?,'不适用',?,?,?,?)").run(name,category,style,size,subtype,description,visual,value).lastInsertRowid);
   for(const storeId of[1,2]){
    for(let serial=1;serial<=6;serial++)db.prepare("INSERT INTO units(inventory_no,variant_id,store_id,status) VALUES(?,?,?,'AVAILABLE')").run(`BSR-${storeId}-${String(id).padStart(2,'0')}-${String(serial).padStart(3,'0')}`,id,storeId);
    db.prepare("INSERT INTO price_policies(variant_id,store_id,version,daily_nok,deposit_nok,extra_day_factor,effective_from,status,approved_by,created_at) VALUES(?,?,1,?,?,0.8,'2026-01-01','APPROVED',3,?)").run(id,storeId,daily,Math.round(value*.08),now);
   }
  }
  db.prepare(`UPDATE units SET purchase_date=COALESCE(purchase_date,'2025-11-01'),purchase_cost_nok=COALESCE(purchase_cost_nok,(SELECT CAST(retail_nok*0.65 AS INTEGER) FROM variants WHERE id=variant_id)),retail_nok=COALESCE(retail_nok,(SELECT retail_nok FROM variants WHERE id=variant_id)),skill_code=COALESCE(skill_code,(SELECT CASE WHEN category IN ('双板','单板','雪鞋') OR name LIKE '%雪杖%' THEN skill ELSE NULL END FROM variants WHERE id=variant_id))`).run();
  db.prepare("UPDATE reservations SET assigned_staff_id=(SELECT id FROM users WHERE role='staff' AND store_id=reservations.store_id ORDER BY id LIMIT 1) WHERE assigned_staff_id IS NULL").run();
  db.prepare("UPDATE damage_cases SET feedback_due_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+24 hours') WHERE feedback_due_at IS NULL").run();
  db.prepare("UPDATE users SET name='跨店运营总监' WHERE email='owner@bsr.demo' AND name='BSR 经营分析'").run();
  db.prepare("UPDATE users SET name='平台运维管理员' WHERE email='admin@bsr.demo' AND name='系统管理员'").run();
  db.prepare("UPDATE employee_profiles SET job_title=CASE (SELECT role FROM users WHERE id=user_id) WHEN 'owner' THEN '跨店运营总监' WHEN 'admin' THEN '平台运维与权限管理员' WHEN 'staff' THEN '门店租赁专员' WHEN 'contractor' THEN '装备检修技师' ELSE job_title END").run();
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run(migration,now);db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
