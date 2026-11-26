import {createHash,randomBytes} from 'node:crypto';
import {audit,hashPassword,verifyPassword} from './db.mjs';
import {DomainError} from './domain.mjs';

export const candidateCookieName='__Host-bsr_candidate_session';
export const showcaseCookieName='__Host-bsr_showcase_session';
export const candidateSessionSeconds=8*60*60;
const failedWindowMs=10*60*1000;
const blockedMs=15*60*1000;
const genericLoginError='账号或密码错误';
const managedCookieName=runMode=>runMode==='showcase'?showcaseCookieName:runMode==='candidate'?candidateCookieName:null;
const dummyHash=hashPassword('unregistered-account-'+randomBytes(12).toString('hex'));

const nowIso=ms=>new Date(ms).toISOString();
const hashToken=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status,code)=>{
  const error=new DomainError(message,status);
  if(code)error.code=code;
  throw error;
};
function transaction(db,fn){
  db.exec('BEGIN IMMEDIATE');
  try{const value=fn();db.exec('COMMIT');return value;}
  catch(error){db.exec('ROLLBACK');throw error;}
}
function cookieValue(req,name){
  const header=String(req?.headers?.cookie||'');
  return header.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';
}
const normalizeEmail=value=>String(value||'').trim().toLowerCase();
// The hosted proxy boundary sets bsrClientIp only after authenticating the
// loopback proxy and validating its single, sanitized client-IP header.
const sourceOf=req=>String(req?.bsrClientIp||req?.socket?.remoteAddress||'unknown').trim().toLowerCase();
const keyFor=(instance,dimension,value)=>createHash('sha256').update([instance,dimension,value].join('|')).digest('hex');
const publicUser=account=>({
  id:account.id,name:account.name,email:account.email,role:account.role,store_id:account.store_id,
  phone:account.phone,address:account.address,birth_year:account.birth_year,height_cm:account.height_cm,
  weight_kg:account.weight_kg,shoe_size:account.shoe_size,must_change_password:account.must_change_password
});

export function requireCandidateOrigin(req,expectedOrigin){
  const origin=req?.headers?.origin;
  if(typeof expectedOrigin!=='string'||!expectedOrigin.startsWith('https://')||typeof origin!=='string'||origin!==expectedOrigin)
    fail('请求来源不受信任',403,'UNTRUSTED_ORIGIN');
}

export function validateCandidatePassword(value){
  const password=String(value||'');
  const classes=[/[a-z]/,/[A-Z]/,/[0-9]/,/[^A-Za-z0-9\s]/].filter(re=>re.test(password)).length;
  if(password.length<12||password.length>256||classes<3||
     /^(?:Demo123!|Password123!|Admin123456!|password|admin123)$/i.test(password))
    fail('请使用 12–256 位且包含至少三类字符的非演示密码',400,'WEAK_CREDENTIAL');
  return password;
}

export function candidateSessionUser(db,req,{now=Date.now(),runMode='candidate'}={}){
  const name=managedCookieName(runMode);
  if(!name)return null;
  const token=cookieValue(req,name);
  if(!token)return null;
  return db.prepare(`SELECT u.*,s.issued_at AS session_issued_at,s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL
      AND s.auth_epoch=u.auth_epoch AND u.account_state='ACTIVE'`)
    .get(hashToken(token),nowIso(now))||null;
}

function installationId(db,runMode){
  const row=db.prepare("SELECT instance_id,run_mode FROM runtime_installation WHERE singleton_id=1 AND run_mode IN ('CANDIDATE','SHOWCASE') AND init_state='READY'").get();
  if(!row?.instance_id||runMode&&row.run_mode!==runMode.toUpperCase())
    fail(runMode==='candidate'?'正式候选身份尚未初始化':'受管理身份尚未初始化',503,
      runMode==='candidate'?'CANDIDATE_NOT_READY':'MANAGED_NOT_READY');
  return row.instance_id;
}
function readBucket(db,dimension,keyHash,now){
  const row=db.prepare('SELECT window_started_at,failed_count,blocked_until FROM auth_attempt_buckets WHERE dimension=? AND key_hash=?').get(dimension,keyHash);
  if(!row)return null;
  if(row.blocked_until&&Date.parse(row.blocked_until)>now)return row;
  if(now-Date.parse(row.window_started_at)>=failedWindowMs){
    db.prepare('DELETE FROM auth_attempt_buckets WHERE dimension=? AND key_hash=?').run(dimension,keyHash);
    return null;
  }
  return row;
}
function recordFailed(db,dimension,keyHash,now){
  const row=readBucket(db,dimension,keyHash,now);
  const started=row?row.window_started_at:nowIso(now);
  const count=(row?.failed_count||0)+1;
  const blockedUntil=count>=5?nowIso(now+blockedMs):null;
  db.prepare(`INSERT INTO auth_attempt_buckets(dimension,key_hash,window_started_at,failed_count,blocked_until)
    VALUES(?,?,?,?,?) ON CONFLICT(dimension,key_hash) DO UPDATE SET
    window_started_at=excluded.window_started_at,failed_count=excluded.failed_count,blocked_until=excluded.blocked_until`)
    .run(dimension,keyHash,started,count,blockedUntil);
}
function assertNotBlocked(db,keys,now){
  for(const [dimension,keyHash] of keys){
    const row=readBucket(db,dimension,keyHash,now);
    if(row?.blocked_until&&Date.parse(row.blocked_until)>now){
      const error=new DomainError('尝试过于频繁，请稍后再试',429);
      error.code='AUTH_RATE_LIMITED';
      error.retryAfter=Math.ceil((Date.parse(row.blocked_until)-now)/1000);
      audit(db,null,'AUTH_RATE_LIMITED','security',null,{dimension,keyHash});
      throw error;
    }
  }
}
export function candidateLogin(db,req,input,{now=Date.now(),runMode='candidate'}={}){
  const name=managedCookieName(runMode);
  if(!name)fail('受管理身份用途无效',503,'MANAGED_NOT_READY');
  const email=normalizeEmail(input?.email),password=String(input?.password||'');
  const instance=installationId(db,runMode);
  db.prepare(`DELETE FROM auth_attempt_buckets
    WHERE (blocked_until IS NULL AND window_started_at<=?)
       OR (blocked_until IS NOT NULL AND blocked_until<=?)`)
    .run(nowIso(now-failedWindowMs),nowIso(now));
  const keys=[
    ['ACCOUNT',keyFor(instance,'account',email)],
    ['SOURCE',keyFor(instance,'source',sourceOf(req))]
  ];
  assertNotBlocked(db,keys,now);
  const account=db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const valid=verifyPassword(password,account?.password_hash||dummyHash);
  if(!valid||account?.account_state!=='ACTIVE'){
    for(const [dimension,keyHash] of keys)recordFailed(db,dimension,keyHash,now);
    audit(db,null,'AUTH_FAILED','security',null,{kind:'credentials',accountKey:keys[0][1],sourceKey:keys[1][1]});
    fail(genericLoginError,401,'INVALID_CREDENTIALS');
  }
  db.prepare('DELETE FROM auth_attempt_buckets WHERE dimension=? AND key_hash=?').run('ACCOUNT',keys[0][1]);
  const token=randomBytes(32).toString('hex');
  const expires=now+candidateSessionSeconds*1000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,issued_at,auth_epoch,revoked_at) VALUES(?,?,?,?,?,NULL)')
    .run(hashToken(token),account.id,nowIso(expires),nowIso(now),account.auth_epoch);
  audit(db,account.id,'LOGIN','user',account.id,{runMode});
  return {
    user:publicUser(account),
    cookie:`${name}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${candidateSessionSeconds}`
  };
}

export function candidateLogout(db,req,{runMode='candidate'}={}){
  const name=managedCookieName(runMode);
  if(!name)fail('受管理身份用途无效',503,'MANAGED_NOT_READY');
  const token=cookieValue(req,name);
  if(token){
    const tokenHash=hashToken(token);
    const active=db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND revoked_at IS NULL').get(tokenHash);
    if(active){
      db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
        .run(new Date().toISOString(),tokenHash);
      audit(db,active.user_id,'LOGOUT','user',active.user_id,{runMode});
    }
  }
  return {cookie:`${name}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`};
}

// Call inside the same transaction as a role, store, assignment or credential change.
export function invalidateCandidateSessions(db,userId){
  const result=db.prepare('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=?').run(userId);
  if(result.changes){
    const at=new Date().toISOString();
    db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .run(at,userId);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mini_sessions'").get())
      db.prepare('UPDATE mini_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
        .run(at,userId);
  }
  return result.changes;
}

export function candidateProvisionAccount(db,actor,input,{runMode='candidate'}={}){
  if(actor?.role!=='admin'||actor?.account_state!=='ACTIVE'||actor?.must_change_password)
    fail('没有开通账号的权限',403,'FORBIDDEN');
  const instance=installationId(db,runMode);
  const name=String(input?.name||'').trim(),email=normalizeEmail(input?.email),role=String(input?.role||'');
  if(name.length<2||name.length>120||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    fail('姓名或邮箱无效',400,'INVALID_ACCOUNT');
  if(runMode==='showcase'&&email.endsWith('@bsr.demo'))
    fail('合成预览不能使用课程演示账号',400,'DEMO_ACCOUNT_FORBIDDEN');
  if(!['customer','staff','manager','contractor','owner','admin'].includes(role))
    fail('岗位无效',400,'INVALID_ROLE');
  const password=validateCandidatePassword(input?.temporaryPassword??input?.initialPassword);
  const storeScoped=['staff','manager'].includes(role)||runMode==='showcase'&&role==='contractor';
  const storeId=storeScoped&&input?.storeId!==undefined&&input.storeId!==null&&input.storeId!==''?Number(input.storeId):
    ['staff','manager'].includes(role)?Number(input?.storeId):null;
  if(['staff','manager'].includes(role)&&(!Number.isInteger(storeId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId)))
    fail('门店岗位必须绑定有效门店',400,'INVALID_STORE');
  if(runMode==='showcase'&&role==='contractor'&&storeId!==null&&
     (!Number.isInteger(storeId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId)))
    fail('检修岗位绑定的门店无效',400,'INVALID_STORE');
  const verificationRef=String(input?.verificationRef||'').trim();
  const needsVerification=runMode==='showcase'||['customer','manager','owner','admin'].includes(role);
  if(needsVerification&&(verificationRef.length<6||verificationRef.length>200))
    fail('该岗位开通须记录线下核验依据',400,'VERIFICATION_REQUIRED');
  if(db.prepare('SELECT id FROM users WHERE email=?').get(email))
    fail('账号已存在',409,'ACCOUNT_EXISTS');
  return transaction(db,()=>{
    const now=new Date().toISOString();
    const id=Number(db.prepare(`INSERT INTO users(name,email,password_hash,role,store_id,created_at,
      account_state,provisioning_method,verified_at,must_change_password,auth_epoch)
      VALUES(?,?,?,?,?,?,'ACTIVE','OFFLINE_ADMIN',?,1,1)`)
      .run(name,email,hashPassword(password),role,storeId,now,now).lastInsertRowid);
    if(runMode==='showcase'&&role!=='customer'){
      const jobs={staff:['虚构门店服务','门店租赁专员'],manager:['虚构门店运营','门店运营经理'],
        contractor:['虚构装备技术','装备检修技师'],owner:['虚构跨店经营','经营负责人'],
        admin:['虚构平台管理','权限管理员']};
      const [department,title]=jobs[role];
      db.prepare(`INSERT INTO employee_profiles
        (user_id,employee_no,department,job_title,expertise,qualification,joined_on,work_location)
        VALUES(?,?,?,?,?,?,?,?)`).run(id,`SYN-${String(id).padStart(4,'0')}`,
          department,title,'合成预览岗位训练','虚构培训档案，仅供课程展示',
          now.slice(0,10),storeId?'虚构雪场门店':'虚构跨店支持');
      if(['staff','manager','contractor'].includes(role)){
        const shiftStore=storeId??db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get()?.id;
        const workDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',
          year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
        db.prepare(`INSERT INTO shifts(user_id,store_id,work_date,start_time,end_time)
          VALUES(?,?,?,'09:00','16:00')`).run(id,shiftStore,workDate);
      }
    }
    audit(db,actor.id,'ACCOUNT_PROVISIONED','user',id,{role,storeId,
      offlineVerified:needsVerification,verificationRefHash:verificationRef?keyFor(instance,'verification',verificationRef):null,
      runMode});
    return {id,name,email,role,storeId,mustChangePassword:true};
  });
}

function requireAccountAdministrator(actor){
  if(actor?.role!=='admin'||actor?.account_state!=='ACTIVE'||actor?.must_change_password)
    fail('没有管理账号的权限',403,'FORBIDDEN');
}

function verifiedOfflineReference(db,value,runMode){
  const reference=String(value||'').trim();
  if(reference.length<6||reference.length>200)
    fail('此操作须记录线下身份核验编号',400,'VERIFICATION_REQUIRED');
  return keyFor(installationId(db,runMode),'verification',reference);
}

export function candidateSetAccountState(db,actor,targetId,input,{runMode='candidate'}={}){
  requireAccountAdministrator(actor);
  installationId(db,runMode);
  const id=Number(targetId),state=String(input?.state||'');
  if(!Number.isSafeInteger(id)||id<1||!['ACTIVE','DISABLED'].includes(state))
    fail('账号或目标状态无效',400,'INVALID_ACCOUNT_STATE');
  if(id===actor.id)fail('不能停用或重新启用自己的账号',403,'SELF_ACCOUNT_CHANGE');
  const referenceHash=state==='ACTIVE'?verifiedOfflineReference(db,input?.verificationRef,runMode):null;
  return transaction(db,()=>{
    const target=db.prepare('SELECT id,account_state FROM users WHERE id=?').get(id);
    if(!target)fail('账号不存在',404,'ACCOUNT_NOT_FOUND');
    const initialAdmin=db.prepare("SELECT initial_admin_id FROM runtime_installation WHERE singleton_id=1 AND run_mode IN ('CANDIDATE','SHOWCASE')").get();
    if(id===initialAdmin?.initial_admin_id&&state==='DISABLED')
      fail('首个管理员账号不能停用',409,'INITIAL_ADMIN_REQUIRED');
    if(target.account_state===state)return {id,accountState:state,changed:false};
    db.prepare('UPDATE users SET account_state=? WHERE id=?').run(state,id);
    invalidateCandidateSessions(db,id);
    audit(db,actor.id,state==='ACTIVE'?'ACCOUNT_ENABLED':'ACCOUNT_DISABLED','user',id,
      {verificationRefHash:referenceHash,runMode});
    return {id,accountState:state,changed:true};
  });
}

export function candidateResetPassword(db,actor,targetId,input,{runMode='candidate'}={}){
  requireAccountAdministrator(actor);
  installationId(db,runMode);
  const id=Number(targetId);
  if(!Number.isSafeInteger(id)||id<1)fail('账号无效',400,'INVALID_ACCOUNT');
  if(id===actor.id)fail('请使用本人改密流程',403,'SELF_CREDENTIAL_RESET');
  const referenceHash=verifiedOfflineReference(db,input?.verificationRef,runMode);
  const password=validateCandidatePassword(input?.temporaryPassword);
  return transaction(db,()=>{
    const target=db.prepare('SELECT id,password_hash FROM users WHERE id=?').get(id);
    if(!target)fail('账号不存在',404,'ACCOUNT_NOT_FOUND');
    if(verifyPassword(password,target.password_hash))
      fail('新凭据不能与当前凭据相同',400,'SAME_CREDENTIAL');
    db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?')
      .run(hashPassword(password),id);
    invalidateCandidateSessions(db,id);
    audit(db,actor.id,'CREDENTIAL_RESET','user',id,{verificationRefHash:referenceHash,runMode});
    return {id,mustChangePassword:true};
  });
}

export function candidateChangePassword(db,user,input,{runMode='candidate'}={}){
  const name=managedCookieName(runMode);
  if(!name)fail('受管理身份用途无效',503,'MANAGED_NOT_READY');
  if(!user||user.account_state!=='ACTIVE')fail('请先登录',401,'UNAUTHORIZED');
  const current=String(input?.currentPassword||'');
  if(!verifyPassword(current,user.password_hash))
    fail('当前凭据不正确',401,'INVALID_CREDENTIALS');
  const next=validateCandidatePassword(input?.newPassword);
  if(verifyPassword(next,user.password_hash))
    fail('新凭据不能与当前凭据相同',400,'SAME_CREDENTIAL');
  return transaction(db,()=>{
    db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?')
      .run(hashPassword(next),user.id);
    invalidateCandidateSessions(db,user.id);
    audit(db,user.id,'PASSWORD_CHANGED','user',user.id,{runMode});
    return {ok:true,cookie:`${name}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`};
  });
}
