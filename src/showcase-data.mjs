// Fictional course-preview master data. This function runs inside the caller's
// initialization transaction; it neither opens a database nor commits one.
const stores=[
  {code:'N1',name:'虚构北脊雪场门店',subtitle:'合成预览 · 北脊站',address:'虚构场景地址 N1，不对应真实门店',openHours:'09:00–16:00'},
  {code:'S2',name:'虚构南谷雪场门店',subtitle:'合成预览 · 南谷站',address:'虚构场景地址 S2，不对应真实门店',openHours:'09:00–16:00'}
];

const catalog=[
  {name:'Northline 双板',category:'双板',subtype:'全山地',style:'稳定巡航',size:'148 cm',skill:'初级',visual:'ski',retail:5200,daily:290},
  {name:'Northline 双板',category:'双板',subtype:'全山地',style:'稳定巡航',size:'164 cm',skill:'中级',visual:'ski',retail:6200,daily:340},
  {name:'Snowfield 单板',category:'单板',subtype:'自由式',style:'轻量转弯',size:'150 cm',skill:'中级',visual:'board',retail:6800,daily:360},
  {name:'Snowfield 单板',category:'单板',subtype:'自由式',style:'轻量转弯',size:'158 cm',skill:'高级',visual:'board',retail:7600,daily:410},
  {name:'Stepfit 雪鞋',category:'雪鞋',subtype:'双板雪鞋',style:'舒适支撑',size:'EU 39',skill:'初级',visual:'boots',retail:2600,daily:180},
  {name:'Stepfit 雪鞋',category:'雪鞋',subtype:'双板雪鞋',style:'舒适支撑',size:'EU 42',skill:'中级',visual:'boots',retail:2900,daily:195},
  {name:'Clearview 滑雪镜',category:'配件',subtype:'护目镜',style:'防雾双层镜片',size:'成人 M',skill:'不适用',visual:'goggles',retail:850,daily:85},
  {name:'Clearview 滑雪镜',category:'配件',subtype:'护目镜',style:'防雾双层镜片',size:'成人 L',skill:'不适用',visual:'goggles',retail:850,daily:85},
  {name:'Softguard 护膝',category:'护具',subtype:'护膝',style:'软壳缓冲',size:'M',skill:'不适用',visual:'kneepads',retail:600,daily:60},
  {name:'Softguard 护膝',category:'护具',subtype:'护膝',style:'软壳缓冲',size:'L',skill:'不适用',visual:'kneepads',retail:600,daily:60},
  {name:'Ridgeline 头盔',category:'护具',subtype:'头盔',style:'可调节',size:'M',skill:'不适用',visual:'helmet',retail:1150,daily:95},
  {name:'Warmtrack 手套',category:'配件',subtype:'手套',style:'防水保暖',size:'M',skill:'不适用',visual:'gloves',retail:500,daily:55}
];

function count(db,table){return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;}

export function insertSyntheticShowcaseData(db,{adminId,instanceId,now}={}){
  if(!db||!Number.isSafeInteger(adminId)||adminId<1||
     typeof instanceId!=='string'||!/^[a-f0-9]{32,}$/i.test(instanceId)||
     typeof now!=='string'||!Number.isFinite(Date.parse(now)))
    throw new Error('合成数据初始化参数无效');
  const source=db.prepare(`SELECT initial_admin_id,init_state FROM runtime_installation
    WHERE singleton_id=1 AND run_mode='SHOWCASE' AND instance_id=?`).get(instanceId);
  if(source?.initial_admin_id!==adminId||source.init_state!=='INITIALIZING'||
     !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND account_state='ACTIVE'").get(adminId))
    throw new Error('合成数据只能写入正在初始化的独立 SHOWCASE 实例');
  if(['stores','variants','units','price_policies','reservations','showcase_dataset']
    .some(table=>count(db,table)!==0)||count(db,'users')!==1)
    throw new Error('合成数据目标不是空白实例');

  const insertStore=db.prepare('INSERT INTO stores(name,subtitle,address,open_hours) VALUES(?,?,?,?)');
  const insertVariant=db.prepare(`INSERT INTO variants
    (name,category,style,size,skill,subtype,description,visual,retail_nok,serialized)
    VALUES(?,?,?,?,?,?,?,?,?,1)`);
  const insertUnit=db.prepare(`INSERT INTO units
    (inventory_no,variant_id,store_id,status,retail_nok,skill_code,home_store_id,data_source)
    VALUES(?,?,?,'AVAILABLE',?,?,?,'虚构合成展示单件')`);
  const insertPolicy=db.prepare(`INSERT INTO price_policies
    (variant_id,store_id,version,daily_nok,deposit_nok,extra_day_factor,effective_from,status,approved_by,created_at)
    VALUES(?,?,1,?,?,0.8,'2026-01-01','APPROVED',?,?)`);
  const storeIds=[];
  for(const store of stores)storeIds.push(Number(insertStore
    .run(store.name,store.subtitle,store.address,store.openHours).lastInsertRowid));
  let unitCount=0,policyCount=0;
  for(const item of catalog){
    const description=`虚构展示装备；${item.style}，需到店核对尺码和安全状态。`;
    const variantId=Number(insertVariant.run(item.name,item.category,item.style,item.size,
      item.skill,item.subtype,description,item.visual,item.retail).lastInsertRowid);
    for(let storeIndex=0;storeIndex<storeIds.length;storeIndex++){
      const storeId=storeIds[storeIndex],storeCode=stores[storeIndex].code;
      for(let copy=1;copy<=2;copy++){
        unitCount++;
        const inventoryNo=`SYN-${storeCode}-${String(variantId).padStart(3,'0')}-${copy}`;
        insertUnit.run(inventoryNo,variantId,storeId,item.retail,
          ['双板','单板','雪鞋'].includes(item.category)?item.skill:null,storeId);
      }
      insertPolicy.run(variantId,storeId,item.daily,Math.round(item.retail*0.08),adminId,now);
      policyCount++;
    }
  }
  db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run('showcase-catalog-v1',now);
  return {storeIds,stores:storeIds.length,variants:catalog.length,units:unitCount,policies:policyCount};
}
