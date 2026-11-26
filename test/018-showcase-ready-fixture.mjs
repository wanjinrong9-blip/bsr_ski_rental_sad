import {openDb,hashPassword,SHOWCASE_SCHEMA_VERSION} from '../src/db.mjs';

// A deliberately small, wholly fictional READY source for boundary tests.
// It is not the production SHOWCASE initializer planned in Phase 3.
export function readySyntheticSource(path){
  const db=openDb(path,{runMode:'showcase',initialize:true});
  const now='2026-11-19T09:00:00.000Z',instance='018syntheticfixture00000000000001';
  try{
    db.exec('BEGIN IMMEDIATE');
    const adminId=Number(db.prepare(`INSERT INTO users
      (name,email,password_hash,role,created_at,account_state,provisioning_method,verified_at)
      VALUES(?,?,?,'admin',?,'ACTIVE','OFFLINE_ADMIN',?)`)
      .run('虚构系统管理员','synthetic-admin@example.test',hashPassword('Private#Synthetic2026'),now,now).lastInsertRowid);
    db.prepare(`INSERT INTO runtime_installation
      (singleton_id,run_mode,instance_id,schema_version,init_state,initialized_at,initial_admin_id)
      VALUES(1,'SHOWCASE',? ,? ,'READY',?,?)`)
      .run(instance,SHOWCASE_SCHEMA_VERSION,now,adminId);
    db.prepare(`INSERT INTO initial_admin_event(instance_id,user_id,operator_id,result,created_at)
      VALUES(?,?,?,'CREATED',?)`).run(instance,adminId,'018-test-operator',now);
    db.prepare(`INSERT INTO showcase_dataset
      (singleton_id,instance_id,dataset_version,synthetic,created_at,description)
      VALUES(1,?,1,1,?,'全虚构测试数据')`).run(instance,now);
    const store=db.prepare('INSERT INTO stores(name,subtitle,address,open_hours) VALUES(?,?,?,?)');
    const first=Number(store.run('虚构北峰站','合成预览','虚构地址一','09:00–16:00').lastInsertRowid);
    store.run('虚构南岭站','合成预览','虚构地址二','09:00–16:00');
    const variant=Number(db.prepare(`INSERT INTO variants(name,category,style,size,skill,description,visual,retail_nok)
      VALUES(?,?,?,?,?,?,?,?)`).run('虚构护膝','护具','标准','M','通用','仅供测试','knee-pad',600).lastInsertRowid);
    const unit=db.prepare('INSERT INTO units(inventory_no,variant_id,store_id) VALUES(?,?,?)');
    for(let i=1;i<=20;i++)unit.run(`SY-018-${String(i).padStart(3,'0')}`,variant,first);
    db.prepare(`INSERT INTO price_policies
      (variant_id,store_id,version,daily_nok,deposit_nok,effective_from,status,approved_by,created_at)
      VALUES(?,?,1,80,48,?,'APPROVED',?,?)`).run(variant,first,now,adminId,now);
    db.exec('COMMIT');
    return {adminId,instance,storeId:first,variantId:variant};
  }catch(error){db.exec('ROLLBACK');throw error;}
  finally{db.close();}
}
