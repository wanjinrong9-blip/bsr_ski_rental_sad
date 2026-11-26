import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,rmdirSync,statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';
import {openDb,hashPassword,verifyPassword,CANDIDATE_SCHEMA_VERSION,SHOWCASE_SCHEMA_VERSION} from './db.mjs';
import {insertSyntheticShowcaseData} from './showcase-data.mjs';

export class RuntimeProvenanceError extends Error {
  constructor(code,message){super(message);this.name='RuntimeProvenanceError';this.code=code;}
}
const deny=(code,message)=>{throw new RuntimeProvenanceError(code,message);};

function hasTable(db,name){
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function inspectManaged(file,runMode){
  let db;
  try{
    // Inspect an in-memory snapshot. Opening a WAL database even read-only can
    // create -wal/-shm sidecars, which would violate the preflight contract.
    if(existsSync(file+'-wal')||existsSync(file+'-shm'))
      deny('SOURCE_ACTIVE_WAL','数据空间存在未关闭的日志文件，须先使用受控备份检查');
    const source=readFileSync(file);
    if(source.length<100||source.subarray(0,16).toString('binary')!=='SQLite format 3\0')
      deny('SOURCE_UNREADABLE','数据空间不是有效的 SQLite 文件');
    if(![1,2].includes(source[18])||![1,2].includes(source[19]))
      deny('SOURCE_UNREADABLE','数据空间日志格式不受支持');
    // SQLite's in-memory deserialize cannot open a WAL-mode file header.
    // With no live sidecars, the main file is checkpointed; normalize only
    // this private buffer, never the source file.
    if(source[18]===2||source[19]===2){source[18]=1;source[19]=1;}
    db=new DatabaseSync(':memory:');
    db.deserialize(source);
    if(!hasTable(db,'runtime_installation'))deny('SOURCE_UNMARKED','数据空间没有受控来源标记');
    const row=db.prepare('SELECT * FROM runtime_installation WHERE singleton_id=1').get();
    if(!row)deny('SOURCE_UNMARKED','数据空间没有受控来源标记');
    const expectedMode=runMode.toUpperCase();
    if(row.run_mode!==expectedMode)deny(`SOURCE_NOT_${expectedMode}`,
      runMode==='candidate'?'演示或其他数据空间不能作为候选运行':'数据空间用途与启动用途不一致');
    const expectedVersion=runMode==='candidate'?CANDIDATE_SCHEMA_VERSION:SHOWCASE_SCHEMA_VERSION;
    if(row.schema_version>expectedVersion)deny('SOURCE_NEWER_VERSION','数据空间版本高于当前程序');
    if(row.schema_version!==expectedVersion)deny('SOURCE_INCOMPATIBLE','数据空间版本不兼容');
    if(row.init_state!=='READY')deny('SOURCE_NOT_READY','受控数据空间初始化尚未完成');
    if(!hasTable(db,'users')||!hasTable(db,'initial_admin_event'))deny('SOURCE_INCOMPLETE','受控身份结构不完整');
    const first=db.prepare("SELECT id,role,account_state FROM users WHERE id=?").get(row.initial_admin_id);
    const event=db.prepare('SELECT user_id FROM initial_admin_event WHERE instance_id=?').get(row.instance_id);
    if(first?.role!=='admin'||first.account_state!=='ACTIVE'||event?.user_id!==first.id)
      deny('SOURCE_ADMIN_INVALID','首个管理员来源不完整');
    if(runMode==='showcase'){
      if(!hasTable(db,'showcase_dataset'))deny('SOURCE_INCOMPLETE','合成数据集标记缺失');
      const dataset=db.prepare('SELECT * FROM showcase_dataset WHERE singleton_id=1').get();
      if(dataset?.instance_id!==row.instance_id||dataset?.synthetic!==1||
         !Number.isInteger(dataset?.dataset_version)||dataset.dataset_version<1||
         !dataset.created_at||!dataset.description)
        deny('SOURCE_INCOMPLETE','合成数据集标记与运行实例不一致');
      if(!hasTable(db,'stores')||!hasTable(db,'variants')||!hasTable(db,'units')||
         !hasTable(db,'price_policies')||!hasTable(db,'reservations')||
         db.prepare('SELECT COUNT(*) AS n FROM stores').get().n<2||
         db.prepare('SELECT COUNT(*) AS n FROM variants').get().n<1||
         db.prepare('SELECT COUNT(*) AS n FROM units').get().n<20||
         db.prepare('SELECT COUNT(*) AS n FROM price_policies').get().n<1)
        deny('SOURCE_INCOMPLETE','合成门店、装备或价目尚未完整建立');
      if(db.prepare("SELECT 1 FROM units WHERE inventory_no LIKE 'BSR-%' LIMIT 1").get())
        deny('SOURCE_DEMO_MIXED','合成数据空间含演示库存编号');
      for(const account of db.prepare('SELECT password_hash FROM users').all()){
        if(verifyPassword('Demo123!',account.password_hash))
          deny('SOURCE_DEMO_MIXED','合成数据空间含演示通用密码');
      }
    }
    if(db.prepare("SELECT 1 FROM users WHERE email LIKE '%@bsr.demo' LIMIT 1").get()||
       db.prepare("SELECT 1 FROM reservations WHERE code LIKE 'BR-DEMO%' LIMIT 1").get())
      deny('SOURCE_DEMO_MIXED','受控数据空间含演示身份或订单');
    return {status:'ready',runMode,instanceId:row.instance_id,schemaVersion:row.schema_version};
  }catch(error){
    if(error instanceof RuntimeProvenanceError)throw error;
    deny('SOURCE_UNREADABLE','数据空间无法安全检查');
  }finally{db?.close();}
}

// Read-only: never call openDb here or create parent directories.
export function preflightRuntime(config,{requireReady=false}={}){
  if(!config||!['demo','candidate','showcase'].includes(config.runMode))
    deny('RUN_MODE_INVALID','运行用途无效');
  if(config.runMode==='demo')return {status:'demo',runMode:'demo'};
  const file=config.dbPath;
  if(!existsSync(file)){
    if(requireReady)deny('SOURCE_NEEDS_INIT','受控数据空间尚未初始化');
    return {status:'needs_init',runMode:config.runMode};
  }
  let stat;
  try{stat=statSync(file);}catch{deny('SOURCE_UNREADABLE','受控数据文件不可读取');}
  if(!stat.isFile()||stat.size===0)deny('SOURCE_UNREADABLE','受控数据文件无效');
  return inspectManaged(file,config.runMode);
}

function validateAdminInput(input){
  const operator=String(input?.operator||'').trim();
  const name=String(input?.name||'').trim();
  const email=String(input?.email||'').trim().toLowerCase();
  const password=String(input?.password||'');
  if(operator.length<2||operator.length>100)deny('INITIAL_OPERATOR_INVALID','请提供可核对的初始化操作员标识');
  if(name.length<2||name.length>100)deny('INITIAL_ADMIN_INVALID','首个管理员姓名无效');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||email.endsWith('@bsr.demo'))
    deny('INITIAL_ADMIN_INVALID','首个管理员邮箱无效');
  if(password.length<12||password.length>256||!/[a-z]/.test(password)||!/[A-Z]/.test(password)||
     !/\d/.test(password)||!/[^A-Za-z0-9]/.test(password)||
     ['Demo123!','Password123!','Admin123456!'].includes(password))
    deny('INITIAL_SECRET_INVALID','请提供该实例专用的非预置强凭据');
  return {operator,name,email,password};
}

export function initializeCandidate(config,input){
  if(config?.runMode!=='candidate')deny('RUN_MODE_INVALID','仅候选用途可初始化管理员');
  const before=preflightRuntime(config);
  if(before.status!=='needs_init')deny('INITIAL_ALREADY_DONE','候选数据空间已经初始化');
  const details=validateAdminInput(input);
  // The first openDb call performs schema migrations. SQLite serializes the
  // later admin INSERT, but two processes must not run those migrations at
  // the same time against a brand-new file. An atomic directory creation
  // serializes the entire first initialization across processes.
  try{mkdirSync(dirname(config.dbPath),{recursive:true});}
  catch{deny('INITIAL_FAILED','无法建立候选数据目录');}
  const lockPath=`${config.dbPath}.init-lock`,wait=new Int32Array(new SharedArrayBuffer(4));
  const deadline=Date.now()+15000;
  while(true){
    try{mkdirSync(lockPath);break;}
    catch(error){
      if(error.code!=='EEXIST')deny('INITIAL_FAILED','无法锁定候选初始化');
      if(Date.now()>=deadline)deny('INITIAL_LOCKED','候选初始化被其他操作占用；请核对后再处理');
      Atomics.wait(wait,0,0,25);
    }
  }
  let db;
  try{
    // A second initializer may have finished while this one waited.
    if(preflightRuntime(config).status!=='needs_init')deny('INITIAL_ALREADY_DONE','候选数据空间已经初始化');
    db=openDb(config.dbPath,{runMode:'candidate',initialize:true});
    db.exec('BEGIN IMMEDIATE');
    try{
      if(db.prepare('SELECT 1 FROM runtime_installation LIMIT 1').get()||
         db.prepare('SELECT 1 FROM users LIMIT 1').get()||
         db.prepare('SELECT 1 FROM stores LIMIT 1').get())
        deny('INITIAL_ALREADY_DONE','候选数据空间已有资料，不能重复初始化');
      const now=new Date().toISOString();
      const id=Number(db.prepare(`INSERT INTO users
        (name,email,password_hash,role,store_id,created_at,account_state,provisioning_method,verified_at,must_change_password,auth_epoch)
        VALUES(?,?,?,'admin',NULL,?,'ACTIVE','OFFLINE_ADMIN',?,0,1)`)
        .run(details.name,details.email,hashPassword(details.password),now,now).lastInsertRowid);
      const instanceId=randomBytes(16).toString('hex');
      db.prepare(`INSERT INTO runtime_installation
        (singleton_id,run_mode,instance_id,schema_version,init_state,initialized_at,initial_admin_id)
        VALUES(1,'CANDIDATE',? ,? ,'READY',?,?)`)
        .run(instanceId,CANDIDATE_SCHEMA_VERSION,now,id);
      db.prepare(`INSERT INTO initial_admin_event(instance_id,user_id,operator_id,result,created_at)
        VALUES(?,?,?,'CREATED',?)`).run(instanceId,id,details.operator,now);
      db.prepare(`INSERT INTO runtime_checks(instance_id,phase,result,reason_code,checked_at)
        VALUES(?,'INIT','PASS','INITIAL_ADMIN_CREATED',?)`).run(instanceId,now);
      db.prepare(`INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at)
        VALUES(?,'CANDIDATE_INITIALIZED','runtime_installation',1,?,?)`)
        .run(id,JSON.stringify({operator:details.operator,instanceId}),now);
      db.exec('COMMIT');
      return {id,status:'ready',instanceId};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }catch(error){
    if(error instanceof RuntimeProvenanceError)throw error;
    deny('INITIAL_FAILED','候选初始化失败，数据空间未投入服务');
  }finally{db?.close();rmdirSync(lockPath);}
}

// Offline-only initialization. The caller validates runtime configuration and
// supplies the administrator secret through a private interactive terminal.
export function initializeShowcase(config,input,{beforeReady}={}){
  if(config?.runMode!=='showcase')deny('RUN_MODE_INVALID','仅独立合成预览用途可初始化');
  if(beforeReady!==undefined&&typeof beforeReady!=='function')
    deny('INITIAL_FAILED','合成预览初始化参数无效');
  if(preflightRuntime(config).status!=='needs_init')
    deny('INITIAL_ALREADY_DONE','合成预览数据空间已经初始化');
  const details=validateAdminInput(input);
  try{mkdirSync(dirname(config.dbPath),{recursive:true});}
  catch{deny('INITIAL_FAILED','无法建立合成预览数据目录');}
  const lockPath=`${config.dbPath}.init-lock`,wait=new Int32Array(new SharedArrayBuffer(4));
  const deadline=Date.now()+15000;
  while(true){
    try{mkdirSync(lockPath);break;}
    catch(error){
      if(error.code!=='EEXIST')deny('INITIAL_FAILED','无法锁定合成预览初始化');
      if(Date.now()>=deadline)deny('INITIAL_LOCKED','合成预览初始化被其他操作占用');
      Atomics.wait(wait,0,0,25);
    }
  }
  let db;
  try{
    if(preflightRuntime(config).status!=='needs_init')
      deny('INITIAL_ALREADY_DONE','合成预览数据空间已经初始化');
    db=openDb(config.dbPath,{runMode:'showcase',initialize:true});
    db.exec('BEGIN IMMEDIATE');
    try{
      if(db.prepare('SELECT 1 FROM runtime_installation LIMIT 1').get()||
         db.prepare('SELECT 1 FROM users LIMIT 1').get()||
         db.prepare('SELECT 1 FROM stores LIMIT 1').get())
        deny('INITIAL_ALREADY_DONE','合成预览数据空间已有资料，不能重复初始化');
      const now=new Date().toISOString(),instanceId=randomBytes(16).toString('hex');
      const id=Number(db.prepare(`INSERT INTO users
        (name,email,password_hash,role,store_id,created_at,account_state,
         provisioning_method,verified_at,must_change_password,auth_epoch)
        VALUES(?,?,?,'admin',NULL,?,'ACTIVE','OFFLINE_ADMIN',?,0,1)`)
        .run(details.name,details.email,hashPassword(details.password),now,now).lastInsertRowid);
      db.prepare(`INSERT INTO runtime_installation
        (singleton_id,run_mode,instance_id,schema_version,init_state,initial_admin_id)
        VALUES(1,'SHOWCASE',? ,? ,'INITIALIZING',?)`)
        .run(instanceId,SHOWCASE_SCHEMA_VERSION,id);
      const summary=insertSyntheticShowcaseData(db,{adminId:id,instanceId,now});
      db.prepare(`INSERT INTO employee_profiles
        (user_id,employee_no,department,job_title,expertise,qualification,joined_on,work_location)
        VALUES(?,?,?,?,?,?,?,?)`).run(id,`SYN-${String(id).padStart(4,'0')}`,
          '虚构平台管理','权限管理员','合成预览账号治理',
          '虚构培训档案，仅供课程展示',now.slice(0,10),'虚构跨店支持');
      db.prepare(`INSERT INTO showcase_dataset
        (singleton_id,instance_id,dataset_version,synthetic,created_at,description)
        VALUES(1,?,1,1,?,'课程合成预览：门店、人员与价格均为虚构')`)
        .run(instanceId,now);
      db.prepare(`INSERT INTO initial_admin_event(instance_id,user_id,operator_id,result,created_at)
        VALUES(?,?,?,'CREATED',?)`).run(instanceId,id,details.operator,now);
      db.prepare(`INSERT INTO runtime_checks(instance_id,phase,result,reason_code,checked_at)
        VALUES(?,'INIT','PASS','SHOWCASE_DATASET_CREATED',?)`).run(instanceId,now);
      db.prepare(`INSERT INTO audit_log(actor_id,action,target_type,target_id,detail_json,created_at)
        VALUES(?,'SHOWCASE_INITIALIZED','runtime_installation',1,?,?)`)
        .run(id,JSON.stringify({operator:details.operator,instanceId,summary}),now);
      // Allows a deterministic interrupted-initialization test. The offline
      // command and HTTP routes never supply this callback.
      beforeReady?.();
      db.prepare("UPDATE runtime_installation SET init_state='READY',initialized_at=? WHERE singleton_id=1")
        .run(now);
      db.exec('COMMIT');
      return {id,status:'ready',instanceId,summary};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }catch(error){
    if(error instanceof RuntimeProvenanceError)throw error;
    deny('INITIAL_FAILED','合成预览初始化失败，数据空间未投入服务');
  }finally{db?.close();rmdirSync(lockPath);}
}
