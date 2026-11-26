import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb,hashPassword} from '../src/db.mjs';
import {wechatMiniLogin,bindMiniCustomer,miniSessionUser} from '../src/mini-identity.mjs';
import {candidateLogin,candidateSessionUser} from '../src/identity.mjs';
import {createVerifiedBackup} from '../tools/backup-verify.mjs';
import {restoreShowcaseBackup} from '../tools/showcase-restore.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const appId='wx1234567890abcdef';
const openidKey='019-private-recovery-test-key-with-enough-entropy';
const password='Private#Recovery2026';
const now=Date.now();
const adapter=openid=>({exchangeCode:async()=>({openid})});
const login=(db,code,openid)=>wechatMiniLogin(db,{code},
  {adapter:adapter(openid),appId,openidKey,now});

test('older DEMO database gains 019 private tables without changing historical orders or prices',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bsr-019-old-db-'));
  const path=join(dir,'older-demo.sqlite');
  try{
    const old=openDb(path);
    const originalOrders=old.prepare('SELECT id,status,quote_json,rent_nok,deposit_nok,total_nok FROM reservations ORDER BY id').all();
    const originalPrices=old.prepare('SELECT * FROM price_policies ORDER BY id').all();
    try{
      old.exec('DROP TABLE mini_sessions; DROP TABLE mini_login_challenges; DROP TABLE mini_code_uses; DROP TABLE mini_quotes; DROP TABLE wechat_bindings; DROP TABLE customer_cart_lines; DROP TABLE customer_carts;');
    }finally{old.close();}
    for(let pass=0;pass<2;pass++){
      const upgraded=openDb(path);
      try{
        for(const table of ['wechat_bindings','mini_login_challenges','mini_code_uses','mini_sessions','mini_quotes','customer_carts','customer_cart_lines']){
          assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),table);
        }
        assert.deepEqual(upgraded.prepare('SELECT id,status,quote_json,rent_nok,deposit_nok,total_nok FROM reservations ORDER BY id').all(),originalOrders);
        assert.deepEqual(upgraded.prepare('SELECT * FROM price_policies ORDER BY id').all(),originalPrices);
        assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
        assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length,0);
      }finally{upgraded.close();}
    }
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('verified SHOWCASE restore explicitly revokes mini sessions and consumes pending bind challenges',async()=>{
  const fixture=await makeShowcaseFixture();
  const sourcePath=join(fixture.dir,'source-showcase.sqlite');
  try{
    readySyntheticSource(sourcePath);
    const source=openDb(sourcePath,{runMode:'showcase'});
    let token,challenge,customerId,webCookie;
    try{
      customerId=Number(source.prepare(`INSERT INTO users
        (name,email,password_hash,role,created_at,account_state,provisioning_method,
         verified_at,must_change_password,auth_epoch)
        VALUES('虚构恢复顾客','mini-recovery@example.test',?,'customer',?,
          'ACTIVE','OFFLINE_ADMIN',?,0,1)`)
        .run(hashPassword(password),new Date(now).toISOString(),new Date(now).toISOString())
        .lastInsertRowid);
      const first=await login(source,'firstRecoveryCode0123456789',
        'oR00000000000000000000000000');
      token=bindMiniCustomer(source,{challenge:first.challenge,
        email:'mini-recovery@example.test',password,explicitConsent:true},
        {appId,openidKey,now,source:'127.0.0.1'}).sessionToken;
      const web=candidateLogin(source,{headers:{},socket:{remoteAddress:'127.0.0.1'}},
        {email:'mini-recovery@example.test',password},{runMode:'showcase',now});
      webCookie=web.cookie.split(';',1)[0];
      const webRequest={headers:{cookie:webCookie}};
      assert.equal(candidateSessionUser(source,webRequest,{runMode:'showcase',now}).id,customerId);
      const pending=await login(source,'otherRecoveryCode0123456789',
        'oS00000000000000000000000000');
      challenge=pending.challenge;
      assert.equal(miniSessionUser(source,token,{now}).id,customerId);
      assert.equal(source.prepare('SELECT COUNT(*) AS n FROM mini_login_challenges WHERE consumed_at IS NULL').get().n,1);
      assert.equal(source.prepare('SELECT COUNT(*) AS n FROM mini_sessions WHERE revoked_at IS NULL').get().n,1);
      assert.equal(source.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').get().n,1);
    }finally{source.close();}
    const backup=await createVerifiedBackup({sourcePath,outputDir:fixture.backupDir});
    await restoreShowcaseBackup({env:fixture.env,backupPath:backup.backupPath,
      manifestPath:backup.manifestPath,operator:'019-recovery-test'});
    const restored=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      assert.equal(miniSessionUser(restored,token,{now}),null);
      assert.equal(candidateSessionUser(restored,{headers:{cookie:webCookie}},
        {runMode:'showcase',now}),null);
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM mini_sessions WHERE revoked_at IS NULL').get().n,0);
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL').get().n,0);
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM mini_login_challenges WHERE consumed_at IS NULL').get().n,0);
      await assert.rejects(async()=>bindMiniCustomer(restored,
        {challenge,email:'mini-recovery@example.test',password,explicitConsent:true},
        {appId,openidKey,now,source:'127.0.0.1'}),
        error=>['CHALLENGE_USED','CHALLENGE_EXPIRED'].includes(error?.code));
      const competing=await login(restored,'competingRecoveryCode0123456789',
        'oT00000000000000000000000000');
      assert.equal(competing.status,'needs_binding');
      assert.throws(()=>bindMiniCustomer(restored,
        {challenge:competing.challenge,email:'mini-recovery@example.test',password,
          explicitConsent:true},{appId,openidKey,now,source:'127.0.0.1'}),
        error=>error?.code==='BINDING_CONFLICT');
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM wechat_bindings WHERE unbound_at IS NULL').get().n,1);
      const restoredWeb=candidateLogin(restored,
        {headers:{},socket:{remoteAddress:'127.0.0.1'}},
        {email:'mini-recovery@example.test',password},{runMode:'showcase',now});
      assert.equal(candidateSessionUser(restored,
        {headers:{cookie:restoredWeb.cookie.split(';',1)[0]}},
        {runMode:'showcase',now}).id,customerId);
      const restoredMini=await login(restored,'restoredRecoveryCode0123456789',
        'oR00000000000000000000000000');
      assert.equal(restoredMini.status,'authenticated');
      assert.equal(miniSessionUser(restored,restoredMini.sessionToken,{now}).id,customerId);
      assert.equal(restored.prepare('SELECT id,account_state FROM users WHERE id=?').get(customerId).account_state,'ACTIVE');
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{restored.close();}
  }finally{fixture.cleanup();}
});
