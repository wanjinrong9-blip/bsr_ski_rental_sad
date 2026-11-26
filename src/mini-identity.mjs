import {createHash,createHmac,randomBytes} from 'node:crypto';
import {audit,hashPassword,verifyPassword} from './db.mjs';
import {DomainError} from './domain.mjs';

const challengeMs=5*60*1000;
const sessionMs=8*60*60*1000;
const attemptWindowMs=10*60*1000;
const attemptBlockMs=15*60*1000;
const codeExchangeLimit=30;
const dummyPasswordHash=hashPassword(randomBytes(24).toString('hex'));
const iso=ms=>new Date(ms).toISOString();
const sha=value=>createHash('sha256').update(value).digest('hex');
const deny=(code,message,status)=>{const error=new DomainError(message,status);error.code=code;throw error;};
const normalizedNow=value=>Number.isFinite(value)?Number(value):Date.now();
const normalizedEmail=value=>String(value||'').trim().toLowerCase();
const safeUser=user=>({id:user.id,name:user.name,email:user.email,role:'customer',storeId:user.store_id});

function config({appId,openidKey}={}){
  if(typeof appId!=='string'||!/^wx[A-Za-z0-9]{16}$/.test(appId)||
      typeof openidKey!=='string'||openidKey.length<32)
    deny('MINI_NOT_READY','微信小程序身份配置尚未就绪',503);
  return {appId,openidKey};
}
function digest(key,namespace,value){return createHmac('sha256',key).update(`${namespace}\0${value}`).digest('hex');}
function tx(db,action){
  db.exec('BEGIN IMMEDIATE');
  try{const result=action();db.exec('COMMIT');return result;}
  catch(error){db.exec('ROLLBACK');throw error;}
}
function issueSession(db,user,binding,now){
  const token=randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO mini_sessions
    (token_hash,user_id,binding_id,app_id,issued_at,expires_at,auth_epoch)
    VALUES(?,?,?,?,?,?,?)`).run(sha(token),user.id,binding.id,binding.app_id,
      iso(now),iso(now+sessionMs),user.auth_epoch);
  audit(db,user.id,'MINI_LOGIN','wechat_binding',binding.id,{channel:'wechat-mini'});
  return {status:'authenticated',sessionToken:token,expiresAt:iso(now+sessionMs),user:safeUser(user)};
}
function attemptKeys(key,email,source){return [
  ['ACCOUNT',digest(key,'mini-account',email)],
  ['SOURCE',digest(key,'mini-source',String(source).slice(0,128))]
];}
function checkedAttempt(db,dimension,key,now){
  const row=db.prepare('SELECT * FROM auth_attempt_buckets WHERE dimension=? AND key_hash=?')
    .get(dimension,key);
  if(!row)return null;
  if(row.blocked_until&&Date.parse(row.blocked_until)>now){
    const error=new DomainError('尝试过于频繁，请稍后再试',429);
    error.code='RATE_LIMITED';error.retryAfter=Math.ceil((Date.parse(row.blocked_until)-now)/1000);
    throw error;
  }
  if(now-Date.parse(row.window_started_at)>=attemptWindowMs){
    db.prepare('DELETE FROM auth_attempt_buckets WHERE dimension=? AND key_hash=?')
      .run(dimension,key);
    return null;
  }
  return row;
}
function recordFailure(db,keys,now){
  for(const [dimension,key] of keys){
    const row=checkedAttempt(db,dimension,key,now);
    const count=(row?.failed_count||0)+1;
    db.prepare(`INSERT INTO auth_attempt_buckets
      (dimension,key_hash,window_started_at,failed_count,blocked_until)
      VALUES(?,?,?,?,?) ON CONFLICT(dimension,key_hash) DO UPDATE SET
      window_started_at=excluded.window_started_at,
      failed_count=excluded.failed_count,blocked_until=excluded.blocked_until`)
      .run(dimension,key,row?.window_started_at||iso(now),count,
        count>=5?iso(now+attemptBlockMs):null);
  }
}

// A successful or failed upstream exchange still consumes platform quota.
// Reuse the persistent SOURCE bucket with a distinct HMAC namespace, never a raw IP.
export function claimMiniCodeExchange(db,{openidKey,source,now=Date.now()}={}){
  if(typeof openidKey!=='string'||openidKey.length<32)
    deny('MINI_NOT_READY','微信小程序身份配置尚未就绪',503);
  const at=normalizedNow(now);
  const sourceHash=digest(openidKey,'mini-code-source',String(source||'unknown').slice(0,128));
  return tx(db,()=>{
    const row=checkedAttempt(db,'SOURCE',sourceHash,at);
    const count=(row?.failed_count||0)+1;
    db.prepare(`INSERT INTO auth_attempt_buckets
      (dimension,key_hash,window_started_at,failed_count,blocked_until)
      VALUES('SOURCE',?,?,?,?) ON CONFLICT(dimension,key_hash) DO UPDATE SET
      window_started_at=excluded.window_started_at,
      failed_count=excluded.failed_count,blocked_until=excluded.blocked_until`)
      .run(sourceHash,row?.window_started_at||iso(at),count,
        count>=codeExchangeLimit?iso(at+attemptBlockMs):null);
    return {remaining:Math.max(0,codeExchangeLimit-count)};
  });
}

export async function wechatMiniLogin(db,input,{adapter,appId,openidKey,now=Date.now()}={}){
  const checked=config({appId,openidKey});
  if(!adapter||typeof adapter.exchangeCode!=='function')
    deny('MINI_NOT_READY','微信登录服务尚未就绪',503);
  const code=input?.code;
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(code))
    deny('CODE_INVALID','微信临时登录码无效',400);
  const at=normalizedNow(now);
  const codeDigest=digest(checked.openidKey,'code',`${checked.appId}\0${code}`);
  if(db.prepare('SELECT 1 FROM mini_code_uses WHERE code_digest=?').get(codeDigest))
    deny('CODE_REPLAYED','微信临时登录码已使用，请重新登录',401);
  // Only the server-side adapter handles platform credentials and session_key.
  const platform=await adapter.exchangeCode(code);
  if(typeof platform?.openid!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(platform.openid))
    deny('WECHAT_UNAVAILABLE','微信登录服务暂不可用',503);
  const openidDigest=digest(checked.openidKey,'openid',`${checked.appId}\0${platform.openid}`);
  const result=tx(db,()=>{
    if(db.prepare('SELECT 1 FROM mini_code_uses WHERE code_digest=?').get(codeDigest))
      deny('CODE_REPLAYED','微信临时登录码已使用，请重新登录',401);
    db.prepare('INSERT INTO mini_code_uses(code_digest,app_id,used_at,expires_at) VALUES(?,?,?,?)')
      .run(codeDigest,checked.appId,iso(at),iso(at+24*60*60*1000));
    const bound=db.prepare(`SELECT u.*,b.id AS binding_id,b.app_id
      FROM wechat_bindings b JOIN users u ON u.id=b.user_id
      WHERE b.app_id=? AND b.openid_digest=? AND b.unbound_at IS NULL`)
      .get(checked.appId,openidDigest);
    if(bound){
      if(bound.account_state!=='ACTIVE'||bound.role!=='customer'||bound.must_change_password)
        return {status:'account_disabled'};
      return issueSession(db,bound,{id:bound.binding_id,app_id:checked.appId},at);
    }
    const challenge=randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO mini_login_challenges
      (challenge_hash,app_id,openid_digest,created_at,expires_at)
      VALUES(?,?,?,?,?)`).run(sha(challenge),checked.appId,openidDigest,iso(at),iso(at+challengeMs));
    return {status:'needs_binding',challenge,expiresAt:iso(at+challengeMs)};
  });
  if(result.status==='account_disabled')
    deny('ACCOUNT_DISABLED','该顾客账号暂不可用于小程序',403);
  return result;
}

export function bindMiniCustomer(db,input,{appId,openidKey,now=Date.now(),source='unknown'}={}){
  const checked=config({appId,openidKey});
  if(input?.explicitConsent!==true)
    deny('CONSENT_REQUIRED','请确认绑定现有顾客账号',422);
  const rawChallenge=input?.challenge;
  if(typeof rawChallenge!=='string'||!/^[a-f0-9]{64}$/.test(rawChallenge))
    deny('CODE_INVALID','绑定请求无效，请重新登录',400);
  const at=normalizedNow(now),challengeHash=sha(rawChallenge);
  const challenge=db.prepare('SELECT * FROM mini_login_challenges WHERE challenge_hash=? AND app_id=?')
    .get(challengeHash,checked.appId);
  if(!challenge||challenge.consumed_at)deny('CHALLENGE_USED','绑定请求已使用，请重新登录',409);
  if(Date.parse(challenge.expires_at)<=at)deny('CHALLENGE_EXPIRED','绑定请求已过期，请重新登录',401);
  if(challenge.attempt_count>=5)deny('RATE_LIMITED','尝试过于频繁，请稍后再试',429);
  const email=normalizedEmail(input?.email),password=String(input?.password||'');
  const keys=attemptKeys(checked.openidKey,email,source);
  for(const [dimension,key] of keys)checkedAttempt(db,dimension,key,at);
  const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const proof=verifyPassword(password,user?.password_hash||dummyPasswordHash);
  if(!proof||user?.account_state!=='ACTIVE'||user?.must_change_password){
    db.prepare('UPDATE mini_login_challenges SET attempt_count=attempt_count+1 WHERE challenge_hash=?')
      .run(challengeHash);
    recordFailure(db,keys,at);
    audit(db,null,'MINI_BIND_FAILED','security',null,{reason:'proof',
      sourceHash:digest(checked.openidKey,'source',String(source).slice(0,128))});
    deny('INVALID_CREDENTIALS','账号或密码错误',401);
  }
  if(user.role!=='customer'){
    db.prepare('UPDATE mini_login_challenges SET attempt_count=attempt_count+1 WHERE challenge_hash=?')
      .run(challengeHash);
    recordFailure(db,keys,at);
    deny('FORBIDDEN','只有顾客账号可绑定微信小程序',403);
  }
  return tx(db,()=>{
    const pending=db.prepare('SELECT * FROM mini_login_challenges WHERE challenge_hash=? AND app_id=?')
      .get(challengeHash,checked.appId);
    if(!pending||pending.consumed_at||Date.parse(pending.expires_at)<=at)
      deny('CHALLENGE_USED','绑定请求已失效，请重新登录',409);
    if(db.prepare(`SELECT 1 FROM wechat_bindings WHERE app_id=? AND unbound_at IS NULL
      AND (openid_digest=? OR user_id=?)`).get(checked.appId,pending.openid_digest,user.id))
      deny('BINDING_CONFLICT','微信身份或顾客账号已绑定，请先解绑',409);
    const bindingId=Number(db.prepare(`INSERT INTO wechat_bindings
      (app_id,openid_digest,user_id,bound_at,proof_method,proof_at)
      VALUES(?,?,?,?,'ACCOUNT_PASSWORD',?)`).run(checked.appId,pending.openid_digest,
        user.id,iso(at),iso(at)).lastInsertRowid);
    db.prepare('UPDATE mini_login_challenges SET consumed_at=? WHERE challenge_hash=?')
      .run(iso(at),challengeHash);
    audit(db,user.id,'MINI_BOUND','wechat_binding',bindingId,{channel:'wechat-mini'});
    db.prepare('DELETE FROM auth_attempt_buckets WHERE dimension=? AND key_hash=?')
      .run('ACCOUNT',keys[0][1]);
    return issueSession(db,user,{id:bindingId,app_id:checked.appId},at);
  });
}

export function miniSessionUser(db,token,{now=Date.now()}={}){
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
  const row=db.prepare(`SELECT u.*,s.binding_id,s.app_id FROM mini_sessions s
    JOIN users u ON u.id=s.user_id JOIN wechat_bindings b ON b.id=s.binding_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND s.auth_epoch=u.auth_epoch AND u.account_state='ACTIVE'
      AND u.role='customer' AND u.must_change_password=0
      AND b.unbound_at IS NULL AND b.user_id=s.user_id AND b.app_id=s.app_id`)
    .get(sha(token),iso(normalizedNow(now)));
  return row||null;
}

export function logoutMiniSession(db,token,{now=Date.now()}={}){
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return {ok:true};
  const row=db.prepare('SELECT user_id FROM mini_sessions WHERE token_hash=? AND revoked_at IS NULL')
    .get(sha(token));
  if(row){
    db.prepare('UPDATE mini_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .run(iso(normalizedNow(now)),sha(token));
    audit(db,row.user_id,'MINI_LOGOUT','user',row.user_id,{channel:'wechat-mini'});
  }
  return {ok:true};
}

export function unbindMiniCustomer(db,user,token,{password,now=Date.now()}={}){
  const current=miniSessionUser(db,token,{now});
  if(!current||current.id!==user?.id)deny('SESSION_EXPIRED','请重新登录小程序',401);
  if(!verifyPassword(String(password||''),current.password_hash))
    deny('INVALID_CREDENTIALS','账号密码不正确',401);
  const at=iso(normalizedNow(now));
  return tx(db,()=>{
    db.prepare('UPDATE wechat_bindings SET unbound_at=?,version=version+1 WHERE id=? AND unbound_at IS NULL')
      .run(at,current.binding_id);
    db.prepare('UPDATE mini_sessions SET revoked_at=? WHERE binding_id=? AND revoked_at IS NULL')
      .run(at,current.binding_id);
    audit(db,current.id,'MINI_UNBOUND','wechat_binding',current.binding_id,{channel:'wechat-mini'});
    return {ok:true};
  });
}
