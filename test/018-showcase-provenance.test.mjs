import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb,hashPassword,SHOWCASE_SCHEMA_VERSION} from '../src/db.mjs';
import {preflightRuntime} from '../src/runtime-provenance.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

test('SHOWCASE 只接受完整且标记为合成的独立来源',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const source=readySyntheticSource(fixture.dbPath);
    assert.deepEqual(preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath},{requireReady:true}),
      {status:'ready',runMode:'showcase',instanceId:source.instance,schemaVersion:SHOWCASE_SCHEMA_VERSION});
    let db=openDb(fixture.dbPath,{runMode:'showcase'});
    db.prepare('DELETE FROM showcase_dataset WHERE singleton_id=1').run();
    db.close();
    assert.throws(()=>preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath}),{code:'SOURCE_INCOMPLETE'});
  }finally{fixture.cleanup();}
});

test('SHOWCASE 来源拒绝课程演示通用密码和库存编号',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const source=readySyntheticSource(fixture.dbPath);
    let db=openDb(fixture.dbPath,{runMode:'showcase'});
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword('Demo123!'),source.adminId);
    db.close();
    assert.throws(()=>preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath}),{code:'SOURCE_DEMO_MIXED'});
    db=openDb(fixture.dbPath,{runMode:'showcase'});
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword('Private#Synthetic2026'),source.adminId);
    db.prepare("UPDATE units SET inventory_no='BSR-DEMO-001' WHERE id=(SELECT MIN(id) FROM units)").run();
    db.close();
    assert.throws(()=>preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath}),{code:'SOURCE_DEMO_MIXED'});
  }finally{fixture.cleanup();}
});
