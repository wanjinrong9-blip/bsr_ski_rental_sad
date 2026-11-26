import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  existsSync,readFileSync,readdirSync,symlinkSync,writeFileSync
} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {candidateLogin,candidateSessionUser} from '../src/identity.mjs';
import {initializeCandidate,preflightRuntime} from '../src/runtime-provenance.mjs';
import {createVerifiedBackup,verifyBackup} from '../tools/backup-verify.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const root=resolve(import.meta.dirname,'..');
const publicDir=join(root,'public');
const admin={operator:'018-restore-test',name:'Fictional Restore Admin',
  email:'restore-admin@example.test',password:'Restore#Private2026A'};
const sha256=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const request=(cookie='')=>({headers:{cookie},socket:{remoteAddress:'127.0.0.1'}});
const targetAbsent=path=>{
  for(const suffix of ['', '-wal','-shm','-journal'])
    assert.equal(existsSync(path+suffix),false,`恢复失败后不得留下目标文件 ${suffix}`);
};

// The restore module is deliberately loaded after the test body begins: T033
// must remain a runnable red test while T035/T036 have not created the command.
async function restoreShowcaseBackup(options){
  const module=await import('../tools/showcase-restore.mjs').catch(error=>{
    if(error?.code==='ERR_MODULE_NOT_FOUND')return {};
    throw error;
  });
  assert.equal(typeof module.restoreShowcaseBackup,'function',
    'T035 must export restoreShowcaseBackup');
  return module.restoreShowcaseBackup(options);
}

async function backedShowcase(fixture,{session=false}={}){
  const sourcePath=join(fixture.dir,'source-showcase.sqlite');
  const {instance}=readySyntheticSource(sourcePath);
  let cookie;
  if(session){
    const db=openDb(sourcePath,{runMode:'showcase'});
    try{
      const login=candidateLogin(db,request(),
        {email:'synthetic-admin@example.test',password:'Private#Synthetic2026'},
        {runMode:'showcase'});
      cookie=login.cookie.split(';')[0];
      assert.ok(candidateSessionUser(db,request(cookie),{runMode:'showcase'}));
    }finally{db.close();}
  }
  const backup=await createVerifiedBackup({sourcePath,outputDir:fixture.backupDir});
  return {sourcePath,instance,cookie,backup};
}

const options=(fixture,backup,overrides={})=>({env:fixture.env,
  backupPath:backup.backupPath,manifestPath:backup.manifestPath,
  operator:'018-restore-operator',...overrides});

test('SHOWCASE private backup has a verified, provenance-bound manifest without secrets',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const {sourcePath,instance,backup}=await backedShowcase(fixture);
    const manifest=JSON.parse(readFileSync(backup.manifestPath,'utf8'));
    assert.equal(resolve(backup.backupPath).startsWith(resolve(fixture.backupDir)),true);
    assert.equal(manifest.source,basename(sourcePath));
    assert.equal(manifest.file,basename(backup.backupPath));
    assert.equal(manifest.runMode,'SHOWCASE');
    assert.equal(manifest.instanceId,instance);
    assert.ok(Number.isInteger(manifest.schemaVersion)&&manifest.schemaVersion>0);
    assert.equal(manifest.datasetVersion,1);
    assert.equal(manifest.synthetic,true);
    assert.equal(manifest.sha256,sha256(backup.backupPath));
    assert.equal(manifest.integrity,'ok');
    assert.equal(manifest.foreignKeyErrors,0);
    assert.equal(manifest.restoreDrill,'PASS');
    assert.ok(manifest.counts.units>=20);
    assert.doesNotMatch(JSON.stringify(manifest),/Private#Synthetic2026|restore-admin@example\.test/);
    await verifyBackup(backup.backupPath,manifest);
    // The live source can legitimately retain WAL companions. Restoration
    // preflights a verified, isolated SQLite backup copy instead.
    assert.equal(manifest.instanceId,instance);
  }finally{fixture.cleanup();}
});

test('verified SHOWCASE restore publishes a new target, preserves source and revokes all old sessions',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const {sourcePath,instance,cookie,backup}=await backedShowcase(fixture,{session:true});
    const sourceHash=sha256(sourcePath),backupHash=sha256(backup.backupPath);
    targetAbsent(fixture.dbPath);
    const result=await restoreShowcaseBackup(options(fixture,backup));
    assert.equal(result.status,'ready');
    assert.equal(result.runMode,'showcase');
    assert.equal(result.instanceId,instance);
    assert.equal(result.revokedSessions,1);
    assert.equal(result.accounts,1);
    assert.equal(preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath},
      {requireReady:true}).instanceId,instance);
    assert.equal(sha256(sourcePath),sourceHash);
    assert.equal(sha256(backup.backupPath),backupHash);
    for(const suffix of ['-wal','-shm'])assert.equal(existsSync(backup.backupPath+suffix),false);
    const restored=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      assert.equal(candidateSessionUser(restored,request(cookie),{runMode:'showcase'}),null);
      assert.equal(restored.prepare('SELECT auth_epoch FROM users WHERE id=1').get().auth_epoch,2);
      assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM runtime_checks WHERE phase='RESTORE' AND result='PASS'").get().n,1);
      const audit=restored.prepare("SELECT detail_json FROM audit_log WHERE action='SHOWCASE_RESTORED'").get();
      assert.ok(audit);
      assert.doesNotMatch(audit.detail_json,/Private#Synthetic2026|source-showcase\.sqlite|backups[\\/]/);
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM units').get().n,20);
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM showcase_dataset WHERE synthetic=1').get().n,1);
    }finally{restored.close();}
    assert.equal(readdirSync(fixture.dir).some(name=>name.includes('.restore-')||name.endsWith('.partial')),false);
  }finally{fixture.cleanup();}
});

test('wrong run mode, candidate source and mismatched manifest provenance cannot create SHOWCASE target',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const {sourcePath,backup}=await backedShowcase(fixture);
    const sourceHash=sha256(sourcePath),backupHash=sha256(backup.backupPath);
    await assert.rejects(restoreShowcaseBackup(options(fixture,backup,
      {env:{...fixture.env,BSR_RUN_MODE:'candidate'}})),
      error=>error?.code==='RUN_MODE_INVALID');
    targetAbsent(fixture.dbPath);
    const original=readFileSync(backup.manifestPath,'utf8');
    const manifest=JSON.parse(original);
    for(const [change,code] of [
      [{runMode:'CANDIDATE'},/MODE|SHOWCASE|MANIFEST/],
      [{instanceId:'0'.repeat(32)},/INSTANCE|MANIFEST/],
      [{datasetVersion:manifest.datasetVersion+1},/DATASET|MANIFEST/]
    ]){
      writeFileSync(backup.manifestPath,JSON.stringify({...manifest,...change}));
      await assert.rejects(restoreShowcaseBackup(options(fixture,backup)),
        error=>code.test(String(error?.code)));
      targetAbsent(fixture.dbPath);
    }
    writeFileSync(backup.manifestPath,original);
    const candidatePath=join(fixture.dir,'candidate-source.sqlite');
    initializeCandidate({runMode:'candidate',dbPath:candidatePath},admin);
    const candidateBackup=await createVerifiedBackup({sourcePath:candidatePath,outputDir:fixture.backupDir});
    await assert.rejects(restoreShowcaseBackup(options(fixture,candidateBackup)),
      error=>/SOURCE_NOT_SHOWCASE|MANIFEST_MODE_MISMATCH/.test(String(error?.code)));
    targetAbsent(fixture.dbPath);
    assert.equal(sha256(sourcePath),sourceHash);
    assert.equal(sha256(backup.backupPath),backupHash);
  }finally{fixture.cleanup();}
});

test('hash damage and an existing target are refused without replacing operator data',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const {sourcePath,backup}=await backedShowcase(fixture);
    const sourceHash=sha256(sourcePath),backupHash=sha256(backup.backupPath);
    const originalManifest=readFileSync(backup.manifestPath,'utf8');
    writeFileSync(backup.manifestPath,
      JSON.stringify({...JSON.parse(originalManifest),sha256:'0'.repeat(64)}));
    await assert.rejects(restoreShowcaseBackup(options(fixture,backup)),
      error=>error?.code==='BACKUP_HASH_MISMATCH');
    targetAbsent(fixture.dbPath);
    writeFileSync(backup.manifestPath,originalManifest);
    writeFileSync(fixture.dbPath,'operator-owned-file');
    const targetHash=sha256(fixture.dbPath);
    await assert.rejects(restoreShowcaseBackup(options(fixture,backup)),
      error=>error?.code==='RESTORE_TARGET_EXISTS');
    assert.equal(sha256(fixture.dbPath),targetHash);
    assert.equal(sha256(sourcePath),sourceHash);
    assert.equal(sha256(backup.backupPath),backupHash);
  }finally{fixture.cleanup();}
});

test('public target and symlinked backup paths are refused with no target or source mutation',async t=>{
  const fixture=await makeShowcaseFixture();
  try{
    const {sourcePath,backup}=await backedShowcase(fixture);
    const sourceHash=sha256(sourcePath),backupHash=sha256(backup.backupPath);
    const publicTarget=join(publicDir,`bsr-018-restore-${process.pid}.sqlite`);
    assert.equal(existsSync(publicTarget),false);
    await assert.rejects(restoreShowcaseBackup(options(fixture,backup,
      {env:{...fixture.env,BSR_DB_PATH:publicTarget}})));
    assert.equal(existsSync(publicTarget),false);
    targetAbsent(fixture.dbPath);
    const linked=join(fixture.backupDir,'linked.sqlite');
    try{symlinkSync(backup.backupPath,linked,'file');}
    catch(error){
      if(['EPERM','EACCES','ENOTSUP'].includes(error?.code)){
        t.diagnostic(`OS disallows file symlinks: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(restoreShowcaseBackup(options(fixture,backup,
      {backupPath:linked,manifestPath:linked+'.json'})),
      error=>/BACKUP_NOT_REGULAR|BACKUP_OUTSIDE_PRIVATE_DIR|MANIFEST_PATH_INVALID|BACKUP_MISSING/.test(String(error?.code)));
    targetAbsent(fixture.dbPath);
    assert.equal(sha256(sourcePath),sourceHash);
    assert.equal(sha256(backup.backupPath),backupHash);
  }finally{fixture.cleanup();}
});
