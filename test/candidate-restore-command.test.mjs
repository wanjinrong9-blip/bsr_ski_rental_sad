import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDb} from '../src/db.mjs';
import {candidateLogin,candidateSessionUser} from '../src/identity.mjs';
import {initializeCandidate,preflightRuntime} from '../src/runtime-provenance.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {createVerifiedBackup} from '../tools/backup-verify.mjs';
import {restoreCandidateBackup} from '../tools/candidate-restore.mjs';
import {fakeRequest,requestCookie} from './candidate-identity-fixture.mjs';
import {makeCandidateFixture} from './candidate-fixtures.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const admin={operator:'restore-test',name:'Restore Administrator',email:'restore@example.test',password:'RestoreAdmin#2026A'};
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

async function backedCandidate(f){
  const sourcePath=join(f.dir,'candidate-source.sqlite');
  const sourceConfig=validateRuntimeConfig({...f.env,BSR_DB_PATH:sourcePath},
    {root,publicDir:join(root,'public')});
  initializeCandidate(sourceConfig,admin);
  const db=openDb(sourcePath,{runMode:'candidate'});
  let cookie;
  try{
    const login=candidateLogin(db,fakeRequest(),{email:admin.email,password:admin.password});
    cookie=requestCookie(login.cookie);
  }finally{db.close();}
  const backup=await createVerifiedBackup({sourcePath,outputDir:f.backupDir});
  return {sourcePath,cookie,backup};
}

test('verified candidate backup restores only into a new private file and revokes old sessions',async()=>{
  const f=await makeCandidateFixture('bsr-restore-success-');
  try{
    const {sourcePath,cookie,backup}=await backedCandidate(f);
    const sourceHash=digest(sourcePath),backupHash=digest(backup.backupPath);
    assert.equal(existsSync(f.dbPath),false);
    const result=await restoreCandidateBackup({env:f.env,backupPath:backup.backupPath,
      manifestPath:backup.manifestPath,operator:'test-operator'});
    assert.equal(result.status,'ready');
    assert.equal(result.revokedSessions,1);
    assert.equal(result.accounts,1);
    assert.equal(preflightRuntime({runMode:'candidate',dbPath:f.dbPath},{requireReady:true}).status,'ready');
    assert.equal(digest(sourcePath),sourceHash);
    assert.equal(digest(backup.backupPath),backupHash);
    assert.equal(existsSync(backup.backupPath+'-wal'),false);
    assert.equal(existsSync(backup.backupPath+'-shm'),false);
    const restored=openDb(f.dbPath,{runMode:'candidate'});
    try{
      assert.equal(candidateSessionUser(restored,fakeRequest(cookie)),null);
      assert.equal(restored.prepare('SELECT auth_epoch FROM users WHERE id=1').get().auth_epoch,2);
      assert.equal(restored.prepare("SELECT COUNT(*) n FROM runtime_checks WHERE phase='RESTORE' AND result='PASS'").get().n,1);
      const audit=restored.prepare("SELECT detail_json FROM audit_log WHERE action='CANDIDATE_RESTORED'").get();
      assert.ok(audit);
      assert.equal(audit.detail_json.includes(admin.password),false);
      assert.equal(audit.detail_json.includes(backup.backupPath),false);
    }finally{restored.close();}
    await assert.rejects(restoreCandidateBackup({env:f.env,backupPath:backup.backupPath,
      manifestPath:backup.manifestPath,operator:'test-operator'}),
      error=>error.code==='RESTORE_TARGET_EXISTS');
  }finally{f.cleanup();}
});

test('wrong hash and noncandidate backup never create the configured target',async()=>{
  const f=await makeCandidateFixture('bsr-restore-refusal-');
  try{
    const {backup}=await backedCandidate(f);
    const manifest=JSON.parse(readFileSync(backup.manifestPath,'utf8'));
    writeFileSync(backup.manifestPath,JSON.stringify({...manifest,sha256:'0'.repeat(64)}));
    await assert.rejects(restoreCandidateBackup({env:f.env,backupPath:backup.backupPath,
      manifestPath:backup.manifestPath,operator:'test-operator'}),/SHA-256/);
    assert.equal(existsSync(f.dbPath),false);
    assert.equal(existsSync(f.dbPath+'-wal'),false);
    const demoPath=join(f.dir,'demo.sqlite');
    const demo=openDb(demoPath);demo.close();
    const demoBackup=await createVerifiedBackup({sourcePath:demoPath,outputDir:f.backupDir});
    await assert.rejects(restoreCandidateBackup({env:f.env,backupPath:demoBackup.backupPath,
      manifestPath:demoBackup.manifestPath,operator:'test-operator'}),
      error=>error.code==='SOURCE_NOT_CANDIDATE');
    assert.equal(existsSync(f.dbPath),false);
  }finally{f.cleanup();}
});

test('existing target is never overwritten, including failed prechecks',async()=>{
  const f=await makeCandidateFixture('bsr-restore-existing-');
  try{
    const {backup}=await backedCandidate(f);
    writeFileSync(f.dbPath,'operator-owned-file');
    const original=digest(f.dbPath);
    await assert.rejects(restoreCandidateBackup({env:f.env,backupPath:backup.backupPath,
      manifestPath:backup.manifestPath,operator:'test-operator'}),
      error=>error.code==='RESTORE_TARGET_EXISTS');
    assert.equal(digest(f.dbPath),original);
  }finally{f.cleanup();}
});
