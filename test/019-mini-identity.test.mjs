import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hashPassword,openDb} from '../src/db.mjs';
import {candidateLogin,candidateSessionUser} from '../src/identity.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const appId='wx1234567890abcdef';
const openidKey='019-private-isolated-fixture-key-with-enough-entropy';
const now=Date.parse('2026-11-20T10:00:00.000Z');
const customerPassword='Private#Customer2026';
const staffPassword='Private#Staff2026';
const customerEmail='mini-customer@example.test';
const otherEmail='other-mini-customer@example.test';
const staffEmail='mini-staff@example.test';
const firstOpenid='oX00000000000000000000000000';
const secondOpenid='oY00000000000000000000000000';
const firstCode='firstCode0123456789abcdefghijkl';
const secondCode='secondCode0123456789abcdefghijk';
const common={appId,openidKey,now};

async function identityModule(){
  const module=await import('../src/mini-identity.mjs').catch(error=>{
    if(error?.code==='ERR_MODULE_NOT_FOUND')return {};
    throw error;
  });
  for(const name of ['wechatMiniLogin','bindMiniCustomer','miniSessionUser',
    'logoutMiniSession','unbindMiniCustomer'])
    assert.equal(typeof module[name],'function',`019 identity must export ${name}`);
  return module;
}

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-identity-019-'));
  const path=join(dir,'showcase.sqlite');
  readySyntheticSource(path);
  const db=openDb(path,{runMode:'showcase'});
  const create=(name,email,password,role)=>Number(db.prepare(`INSERT INTO users
    (name,email,password_hash,role,created_at,account_state,provisioning_method,
     verified_at,must_change_password,auth_epoch)
    VALUES(?,?,?,?,'2026-11-19T09:00:00.000Z','ACTIVE','OFFLINE_ADMIN',
      '2026-11-19T09:00:00.000Z',0,1)`)
    .run(name,email,hashPassword(password),role).lastInsertRowid);
  const customerId=create('虚构顾客甲',customerEmail,customerPassword,'customer');
  const otherId=create('虚构顾客乙',otherEmail,customerPassword,'customer');
  const staffId=create('虚构租赁专员',staffEmail,staffPassword,'staff');
  return {db,customerId,otherId,staffId,close(){db.close();rmSync(dir,{recursive:true,force:true,
    maxRetries:5,retryDelay:100});}};
}

const adapterFor=openid=>({exchangeCode:async()=>({openid})});
const begin=(module,db,{code=firstCode,openid=firstOpenid,at=now}={})=>
  module.wechatMiniLogin(db,{code},{adapter:adapterFor(openid),appId,openidKey,now:at});
const bind=(module,db,challenge,{email=customerEmail,password=customerPassword,
  consent=true,at=now}={})=>module.bindMiniCustomer(db,
    {challenge,email,password,explicitConsent:consent},
    {appId,openidKey,now:at,source:'127.0.0.1'});

test('verified WeChat code creates one pending challenge; no raw platform secret or token is persisted',async()=>{
  const f=fixture();
  try{
    const module=await identityModule();
    const pending=await begin(module,f.db);
    assert.equal(pending.status,'needs_binding');
    assert.ok(typeof pending.challenge==='string'&&pending.challenge.length>=32);
    assert.ok(Date.parse(pending.expiresAt)>now);
    assert.equal('openid' in pending,false);
    assert.equal('session_key' in pending,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mini_sessions').get().n,0);
    const challenge=f.db.prepare('SELECT * FROM mini_login_challenges').get();
    assert.match(challenge.challenge_hash,/^[0-9a-f]{64}$/);
    assert.notEqual(challenge.challenge_hash,pending.challenge);
    assert.notEqual(challenge.openid_digest,firstOpenid);
    assert.equal(JSON.stringify(challenge).includes(firstCode),false);
    assert.equal(JSON.stringify(challenge).includes(firstOpenid),false);
    await assert.rejects(begin(module,f.db),error=>
      ['CODE_INVALID','CODE_REPLAYED'].includes(error?.code));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mini_login_challenges').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings').get().n,0);
  }finally{f.close();}
});

test('binding requires explicit customer proof, consumes challenge once and enforces both uniqueness keys',async()=>{
  const f=fixture();
  try{
    const module=await identityModule();
    const first=await begin(module,f.db);
    await assert.rejects(async()=>bind(module,f.db,first.challenge,{consent:false}),
      error=>error?.code==='CONSENT_REQUIRED');
    await assert.rejects(async()=>bind(module,f.db,first.challenge,{email:staffEmail,password:staffPassword}),
      error=>error?.code==='FORBIDDEN');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings').get().n,0);
    const bound=await bind(module,f.db,first.challenge);
    assert.equal(bound.status,'authenticated');
    assert.equal(bound.user.id,f.customerId);
    assert.equal(bound.user.role,'customer');
    assert.ok(typeof bound.sessionToken==='string'&&bound.sessionToken.length>=32);
    assert.equal('openid' in bound,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings WHERE unbound_at IS NULL').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mini_login_challenges WHERE consumed_at IS NOT NULL').get().n,1);
    const stored=f.db.prepare('SELECT token_hash FROM mini_sessions').get().token_hash;
    assert.match(stored,/^[0-9a-f]{64}$/);
    assert.notEqual(stored,bound.sessionToken);
    assert.equal(module.miniSessionUser(f.db,bound.sessionToken,{now}).id,f.customerId);
    await assert.rejects(async()=>bind(module,f.db,first.challenge),error=>
      ['CODE_INVALID','CHALLENGE_USED','BINDING_CONFLICT'].includes(error?.code));
    const fresh=await begin(module,f.db,{code:secondCode,openid:secondOpenid});
    await assert.rejects(async()=>bind(module,f.db,fresh.challenge,{email:customerEmail}),
      error=>error?.code==='BINDING_CONFLICT');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings WHERE unbound_at IS NULL').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mini_sessions').get().n,1);
  }finally{f.close();}
});

test('known binding issues an independent mini session; Web cookie cannot cross-authenticate either boundary',async()=>{
  const f=fixture();
  try{
    const module=await identityModule();
    // Keep the binding primary key distinct from the customer primary key so
    // joins cannot accidentally treat one as the other.
    for(let i=1;i<=2;i++)f.db.prepare(`INSERT INTO wechat_bindings
      (app_id,openid_digest,user_id,bound_at,unbound_at,proof_method,proof_at)
      VALUES(?,?,?,?,?,'ACCOUNT_PASSWORD',?)`)
      .run(appId,String(i).repeat(64),f.otherId,new Date(now-1000).toISOString(),
        new Date(now).toISOString(),new Date(now-1000).toISOString());
    const pending=await begin(module,f.db);
    const first=await bind(module,f.db,pending.challenge);
    const activeBindingId=f.db.prepare('SELECT id FROM wechat_bindings WHERE unbound_at IS NULL').get().id;
    assert.notEqual(activeBindingId,f.customerId);
    assert.equal(f.db.prepare('SELECT binding_id FROM mini_sessions WHERE token_hash IS NOT NULL').get().binding_id,
      activeBindingId);
    const known=await begin(module,f.db,{code:secondCode,openid:firstOpenid});
    assert.equal(known.status,'authenticated');
    assert.equal(known.user.id,f.customerId);
    assert.notEqual(known.sessionToken,first.sessionToken);
    const req={headers:{cookie:''},socket:{remoteAddress:'127.0.0.1'}};
    const web=candidateLogin(f.db,req,{email:customerEmail,password:customerPassword},
      {runMode:'showcase',now});
    const cookie=web.cookie.split(';')[0];
    assert.ok(candidateSessionUser(f.db,{...req,headers:{cookie}},
      {runMode:'showcase',now}));
    assert.equal(module.miniSessionUser(f.db,cookie,{now}),null);
    assert.equal(candidateSessionUser(f.db,{...req,
      headers:{cookie:`__Host-bsr_showcase_session=${known.sessionToken}`}},
      {runMode:'showcase',now}),null);
    module.logoutMiniSession(f.db,first.sessionToken,{now});
    assert.equal(module.miniSessionUser(f.db,first.sessionToken,{now}),null);
    assert.equal(module.miniSessionUser(f.db,known.sessionToken,{now}).id,f.customerId);
    assert.ok(candidateSessionUser(f.db,{...req,headers:{cookie}},
      {runMode:'showcase',now}));
  }finally{f.close();}
});

test('challenge expiry, disabled account and auth epoch revoke access without altering Web orders',async()=>{
  const f=fixture();
  try{
    const module=await identityModule();
    const pending=await begin(module,f.db);
    const expiresAt=f.db.prepare('SELECT expires_at FROM mini_login_challenges').get().expires_at;
    await assert.rejects(async()=>bind(module,f.db,pending.challenge,{at:Date.parse(expiresAt)+1}),
      error=>['CODE_INVALID','CHALLENGE_EXPIRED'].includes(error?.code));
    const next=await begin(module,f.db,{code:secondCode});
    const bound=await bind(module,f.db,next.challenge);
    assert.equal(module.miniSessionUser(f.db,bound.sessionToken,{now}).id,f.customerId);
    const ordersBefore=f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
    f.db.prepare('UPDATE users SET account_state=? WHERE id=?').run('DISABLED',f.customerId);
    assert.equal(module.miniSessionUser(f.db,bound.sessionToken,{now}),null);
    f.db.prepare('UPDATE users SET account_state=?,auth_epoch=auth_epoch+1 WHERE id=?')
      .run('ACTIVE',f.customerId);
    assert.equal(module.miniSessionUser(f.db,bound.sessionToken,{now}),null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,ordersBefore);
  }finally{f.close();}
});

test('unbind requires fresh proof, revokes all mini sessions and preserves Web account',async()=>{
  const f=fixture();
  try{
    const module=await identityModule();
    const pending=await begin(module,f.db);
    const first=await bind(module,f.db,pending.challenge);
    const second=await begin(module,f.db,{code:secondCode});
    await assert.rejects(async()=>module.unbindMiniCustomer(f.db,
      {id:f.customerId,role:'customer'},second.sessionToken,
      {password:'wrong',now}),error=>error?.status===401||error?.status===403);
    assert.equal(module.miniSessionUser(f.db,first.sessionToken,{now}).id,f.customerId);
    module.unbindMiniCustomer(f.db,{id:f.customerId,role:'customer'},
      second.sessionToken,{password:customerPassword,now});
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings WHERE unbound_at IS NULL').get().n,0);
    assert.equal(module.miniSessionUser(f.db,first.sessionToken,{now}),null);
    assert.equal(module.miniSessionUser(f.db,second.sessionToken,{now}),null);
    assert.equal(f.db.prepare('SELECT account_state FROM users WHERE id=?').get(f.customerId).account_state,'ACTIVE');
    const newPending=await begin(module,f.db,{code:'rebindCode0123456789abcdef',
      openid:'oZ00000000000000000000000000'});
    const rebound=await bind(module,f.db,newPending.challenge);
    assert.equal(module.miniSessionUser(f.db,rebound.sessionToken,{now}).id,f.customerId);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings WHERE unbound_at IS NULL').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings').get().n,2,
      'historical unbound row remains while a new active binding is allowed');
  }finally{f.close();}
});

test('wrong account proof has a bounded challenge and leaves no binding or session',async()=>{
  const f=fixture();
  try{
    const module=await identityModule();
    const pending=await begin(module,f.db);
    for(let i=0;i<5;i++){
      await assert.rejects(async()=>bind(module,f.db,pending.challenge,
        {password:'Incorrect#Proof2026'}),error=>error?.code==='INVALID_CREDENTIALS');
    }
    await assert.rejects(async()=>bind(module,f.db,pending.challenge),
      error=>error?.code==='RATE_LIMITED'&&error?.status===429);
    assert.equal(f.db.prepare('SELECT attempt_count FROM mini_login_challenges').get().attempt_count,5);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_bindings').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM mini_sessions').get().n,0);
    const audits=f.db.prepare("SELECT detail_json FROM audit_log WHERE action='MINI_BIND_FAILED'").all();
    assert.equal(audits.length,5);
    assert.equal(JSON.stringify(audits).includes('Incorrect#Proof2026'),false);
    assert.equal(JSON.stringify(audits).includes(firstOpenid),false);
  }finally{f.close();}
});
