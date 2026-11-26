import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {createReservation} from '../src/domain.mjs';
import {candidateProvisionAccount} from '../src/identity.mjs';
import {initializeCandidate,initializeShowcase,preflightRuntime} from '../src/runtime-provenance.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {createVerifiedBackup} from '../tools/backup-verify.mjs';
import {restoreShowcaseBackup} from '../tools/showcase-restore.mjs';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const settings={root,publicDir:join(root,'public')};
const admin={operator:'018-migration-test',name:'虚构恢复管理员',
 email:'migration-admin@example.test',password:'Private#Migration2026A'};
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const count=(db,table)=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const snapshot=db=>({
 installation:db.prepare('SELECT run_mode,instance_id,schema_version,init_state FROM runtime_installation WHERE singleton_id=1').get(),
 dataset:db.prepare('SELECT instance_id,dataset_version,synthetic FROM showcase_dataset WHERE singleton_id=1').get(),
 counts:Object.fromEntries(['stores','users','variants','units','price_policies','reservations','reservation_items','app_migrations']
  .map(table=>[table,count(db,table)])),
 policies:db.prepare('SELECT variant_id,store_id,version,daily_nok,deposit_nok FROM price_policies ORDER BY id').all(),
 quotes:db.prepare('SELECT id,status,quote_json FROM reservations ORDER BY id').all(),
 items:db.prepare('SELECT reservation_id,variant_id,qty,unit_rent_nok,unit_deposit_nok,policy_id FROM reservation_items ORDER BY id').all()
});

test('SHOWCASE 两笔合成订单经过备份、独立恢复和两次重启仍保留价目与订单快照',async()=>{
 const fixture=await makeShowcaseFixture();
 try{
  const config=validateRuntimeConfig(fixture.env,settings);
  initializeShowcase(config,admin);
  const source=openDb(fixture.dbPath,{runMode:'showcase'});
  let expected;
  try{
   const firstAdmin=source.prepare("SELECT * FROM users WHERE role='admin'").get();
   const customer=candidateProvisionAccount(source,firstAdmin,{
    name:'虚构恢复顾客',email:'migration-customer@example.test',role:'customer',
    temporaryPassword:'Private#MigrationCustomer2026',verificationRef:'FICTIONAL-MIGRATION-CUSTOMER'
   },{runMode:'showcase'});
   const period={storeId:1,pickupAt:futureDate(16),returnAt:futureDate(17),
    customerSkill:'中级',damageConsent:consent,
    customerProfile:{phone:'00000000',address:'虚构恢复测试地址',birthYear:1996,
     heightCm:172,weightKg:66,shoeSize:'EU 41'}};
   const first=createReservation(source,customer.id,{...period,items:[{variantId:1,qty:1}]},null,randomUUID());
   const second=createReservation(source,customer.id,{...period,items:[{variantId:2,qty:1}]},null,randomUUID());
   assert.notEqual(first.id,second.id);
   // Model a database whose prior migration registry was incomplete. The
   // shared schema is present, but SHOWCASE must replay only structural work.
   source.prepare("DELETE FROM app_migrations WHERE name IN ('operations-v2','service-catalog-v4','fulfillment-v5')").run();
  }finally{source.close();}
  const once=openDb(fixture.dbPath,{runMode:'showcase'});
  try{
   expected=snapshot(once);
   assert.equal(expected.counts.reservations,2);
   for(const name of ['operations-v2','service-catalog-v4','fulfillment-v5'])
    assert.ok(once.prepare('SELECT 1 FROM app_migrations WHERE name=?').get(name),name);
   assert.equal(once.prepare("SELECT COUNT(*) n FROM users WHERE email LIKE '%@bsr.demo'").get().n,0);
   assert.equal(once.prepare("SELECT COUNT(*) n FROM units WHERE inventory_no LIKE 'BSR-%'").get().n,0);
  }finally{once.close();}
  for(let attempt=0;attempt<2;attempt++){
   assert.equal(preflightRuntime(config,{requireReady:true}).instanceId,expected.installation.instance_id);
   const reopened=openDb(fixture.dbPath,{runMode:'showcase'});
   try{assert.deepEqual(snapshot(reopened),expected);}finally{reopened.close();}
  }
  const sourceHash=hash(fixture.dbPath);
  const backup=await createVerifiedBackup({sourcePath:fixture.dbPath,outputDir:fixture.backupDir});
  const manifest=JSON.parse(readFileSync(backup.manifestPath,'utf8'));
  assert.equal(manifest.runMode,'SHOWCASE');
  assert.equal(manifest.instanceId,expected.installation.instance_id);
  assert.equal(manifest.counts.reservations,2);
  const target=join(fixture.dir,'restored.sqlite');
  const result=await restoreShowcaseBackup({
   env:{...fixture.env,BSR_DB_PATH:target},backupPath:backup.backupPath,
   manifestPath:backup.manifestPath,operator:'018-migration-restore'
  });
  assert.equal(result.instanceId,expected.installation.instance_id);
  assert.equal(hash(fixture.dbPath),sourceHash,'备份与恢复不得改写来源主文件');
  assert.equal(preflightRuntime({runMode:'showcase',dbPath:target},{requireReady:true}).status,'ready');
  const restored=openDb(target,{runMode:'showcase'});
  try{
   const actual=snapshot(restored);
   assert.deepEqual(actual.installation,expected.installation);
   assert.deepEqual(actual.dataset,expected.dataset);
   assert.deepEqual(actual.policies,expected.policies);
   assert.deepEqual(actual.quotes,expected.quotes);
   assert.deepEqual(actual.items,expected.items);
   for(const table of ['stores','users','variants','units','price_policies','reservations','reservation_items','app_migrations'])
    assert.equal(actual.counts[table],expected.counts[table],table);
   assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
   assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{restored.close();}
 }finally{fixture.cleanup();}
});

test('较早候选结构的缺失列仅补结构，已有身份与来源不变',async()=>{
 const fixture=await makeShowcaseFixture();
 const candidatePath=join(fixture.dir,'old-candidate.sqlite');
 try{
  initializeCandidate({runMode:'candidate',dbPath:candidatePath},admin);
  const old=openDb(candidatePath,{runMode:'candidate'});
  let source,users;
  try{
   source=old.prepare('SELECT run_mode,instance_id FROM runtime_installation WHERE singleton_id=1').get();
   users=count(old,'users');
   old.exec('DROP TRIGGER IF EXISTS unit_skill_immutable');
   old.exec('ALTER TABLE units DROP COLUMN purchase_cost_nok');
   old.exec('ALTER TABLE units DROP COLUMN skill_code');
  }finally{old.close();}
  for(let i=0;i<2;i++){
   const reopened=openDb(candidatePath,{runMode:'candidate'});
   try{
    assert.deepEqual(reopened.prepare('SELECT run_mode,instance_id FROM runtime_installation WHERE singleton_id=1').get(),source);
    assert.equal(count(reopened,'users'),users);
    assert.equal(count(reopened,'reservations'),0);
    const columns=new Set(reopened.prepare('PRAGMA table_info(units)').all().map(column=>column.name));
    assert.ok(columns.has('purchase_cost_nok')&&columns.has('skill_code'));
   }finally{reopened.close();}
  }
 }finally{fixture.cleanup();}
});
