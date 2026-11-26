import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {assertNoDemoMarkers,assertNoDemoRows,makeShowcaseFixture} from './018-showcase-fixtures.mjs';

test('SHOWCASE 测试夹具位于独立临时目录且没有演示标记',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    assert.equal(existsSync(fixture.dbPath),false);
    assert.equal(existsSync(fixture.backupDir),true);
    assertNoDemoMarkers(fixture.env);
    assert.match(fixture.env.BSR_RUN_MODE,/^showcase$/);
  }finally{fixture.cleanup();}
  assert.equal(existsSync(fixture.dir),false);
});

test('SHOWCASE 夹具检查拒绝演示账号、口令及订单编号',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE synthetic_rows(id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    db.prepare('INSERT INTO synthetic_rows(label) VALUES(?)').run('虚构北境门店');
    assertNoDemoRows(db);
    for(const marker of ['person@bsr.demo','Demo123!','BR-DEMO004']){
      assert.throws(()=>assertNoDemoMarkers({label:marker}),/演示数据标记/);
      db.prepare('UPDATE synthetic_rows SET label=?').run(marker);
      assert.throws(()=>assertNoDemoRows(db),/演示标记/);
    }
  }finally{db.close();}
});
