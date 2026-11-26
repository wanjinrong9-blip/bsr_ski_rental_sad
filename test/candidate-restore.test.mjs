import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createVerifiedBackup,verifyBackup} from '../tools/backup-verify.mjs';
import {openDb} from '../src/db.mjs';
import {initializeCandidate,preflightRuntime} from '../src/runtime-provenance.mjs';
import {candidateLogin,candidateSessionUser} from '../src/identity.mjs';

const isolated=()=>mkdtempSync(join(tmpdir(),'bsr-candidate-restore-'));
function snapshot(db){
  return {
    orders:db.prepare('SELECT code,rent_nok,deposit_nok,contract_version FROM reservations ORDER BY id').all(),
    contracts:db.prepare('SELECT reservation_id,version,COALESCE(signed_at,\'\') AS signed_at FROM contracts ORDER BY id').all(),
    units:db.prepare('SELECT inventory_no,variant_id,store_id,status FROM units ORDER BY id').all()
  };
}

test('isolated demo backup restores NOK order, contract version and inventory identifiers',async()=>{
  const dir=isolated(),source=join(dir,'demo.sqlite');
  const live=openDb(source);
  try{
    const before=snapshot(live);
    assert.ok(before.orders.length>0&&before.units.length>0);
    const result=await createVerifiedBackup({sourcePath:source,outputDir:join(dir,'backups')});
    const manifest=JSON.parse(readFileSync(result.manifestPath,'utf8'));
    await verifyBackup(result.backupPath,manifest);
    const target=join(dir,'restored.sqlite');copyFileSync(result.backupPath,target);
    const restored=new DatabaseSync(target,{readOnly:true});
    try{assert.deepEqual(snapshot(restored),before);}finally{restored.close();}
    assert.deepEqual(snapshot(live),before,'恢复演练不得更改源库订单');
  }finally{live.close();rmSync(dir,{recursive:true,force:true});}
});

test('candidate restore procedure revokes all pre-restore sessions in isolated copy',async()=>{
  const dir=isolated(),source=join(dir,'candidate.sqlite');
  try{
    initializeCandidate({runMode:'candidate',dbPath:source},{operator:'restore-test',name:'Restore Admin',
      email:'restore@example.test',password:'RestoreAdmin#2026A'});
    const db=openDb(source,{runMode:'candidate'});
    const req={headers:{},socket:{remoteAddress:'127.0.0.1'}};
    const login=candidateLogin(db,req,{email:'restore@example.test',password:'RestoreAdmin#2026A'});
    const cookie=login.cookie.split(';')[0],sessionReq={headers:{cookie},socket:{remoteAddress:'127.0.0.1'}};
    assert.ok(candidateSessionUser(db,sessionReq));
    const before=snapshot(db);
    const backup=await createVerifiedBackup({sourcePath:source,outputDir:join(dir,'backups')});
    db.close();
    const target=join(dir,'restored-candidate.sqlite');copyFileSync(backup.backupPath,target);
    assert.equal(preflightRuntime({runMode:'candidate',dbPath:target},{requireReady:true}).status,'ready');
    const restored=openDb(target,{runMode:'candidate'});
    try{
      assert.ok(candidateSessionUser(restored,sessionReq),'snapshot initially contains prior session');
      restored.exec('BEGIN IMMEDIATE');
      try{
        restored.prepare('UPDATE users SET auth_epoch=auth_epoch+1').run();
        restored.prepare('UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL').run(new Date().toISOString());
        restored.exec('COMMIT');
      }catch(error){restored.exec('ROLLBACK');throw error;}
      assert.equal(candidateSessionUser(restored,sessionReq),null);
      assert.deepEqual(snapshot(restored),before);
    }finally{restored.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
