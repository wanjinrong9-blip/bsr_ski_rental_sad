import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const command=join(root,'tools','showcase-setup.mjs');
const call=(fixture,args)=>spawnSync(process.execPath,[command,...args],{
  cwd:root,env:{...process.env,...fixture.env},input:'',encoding:'utf8',windowsHide:true
});

test('SHOWCASE 离线预检只返回非秘密状态且不创建数据库',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const result=call(fixture,['preflight']);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{
      runMode:'showcase',status:'needs_init',instanceId:null,schemaVersion:null
    });
    assert.equal(existsSync(fixture.dbPath),false);
  }finally{fixture.cleanup();}
});

test('SHOWCASE 初始化拒绝非交互终端与命令行密码',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const noTty=call(fixture,['init']);
    assert.notEqual(noTty.status,0);
    assert.doesNotMatch(noTty.stdout+noTty.stderr,/Unique#Showcase2026A/);
    assert.equal(existsSync(fixture.dbPath),false);
    const extra=call(fixture,['init','Unique#Showcase2026A']);
    assert.notEqual(extra.status,0);
    assert.equal(existsSync(fixture.dbPath),false);
  }finally{fixture.cleanup();}
});
