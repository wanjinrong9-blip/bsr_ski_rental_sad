import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDb} from '../src/db.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import * as provenance from '../src/runtime-provenance.mjs';
import {makeShowcaseFixture,assertNoDemoRows} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const root=resolve(import.meta.dirname,'..'),publicDir=join(root,'public');
const admin={operator:'018-showcase-test',name:'虚构权限管理员',
  email:'showcase-admin@example.test',password:'Unique#Showcase2026A'};
const initializeShowcase=provenance.initializeShowcase;
const configFor=fixture=>validateRuntimeConfig(fixture.env,{root,publicDir});
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceFiles=file=>[file,file+'-wal',file+'-shm'].filter(existsSync);
const snapshot=file=>Object.fromEntries(sourceFiles(file).map(path=>[path,digest(path)]));
const count=(db,table)=>db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('SHOWCASE 只在全新私有来源一次性提交管理员、虚构数据集和 READY 标记',async()=>{
  assert.equal(typeof initializeShowcase,'function','T015 应导出 initializeShowcase');
  const fixture=await makeShowcaseFixture();
  try{
    const config=configFor(fixture);
    assert.deepEqual(provenance.preflightRuntime(config),{status:'needs_init',runMode:'showcase'});
    const result=initializeShowcase(config,admin);
    assert.equal(result.status,'ready');
    assert.match(result.instanceId,/^[a-f0-9]{32,}$/i);
    assert.equal(provenance.preflightRuntime(config,{requireReady:true}).instanceId,result.instanceId);
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const source=db.prepare('SELECT * FROM runtime_installation WHERE singleton_id=1').get();
      const dataset=db.prepare('SELECT * FROM showcase_dataset WHERE singleton_id=1').get();
      const first=db.prepare('SELECT * FROM users WHERE id=?').get(source.initial_admin_id);
      assert.equal(source.run_mode,'SHOWCASE');
      assert.equal(source.init_state,'READY');
      assert.equal(dataset.instance_id,source.instance_id);
      assert.equal(dataset.synthetic,1);
      assert.ok(dataset.dataset_version>=1&&dataset.created_at);
      assert.equal(first.email,admin.email);
      assert.equal(first.role,'admin');
      assert.ok(count(db,'stores')>=2);
      assert.ok(count(db,'variants')>=4);
      assert.ok(count(db,'units')>=20);
      assert.ok(count(db,'price_policies')>=4);
      assert.equal(count(db,'reservations'),0);
      assert.equal(count(db,'initial_admin_event'),1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
      for(const policy of db.prepare(`SELECT p.deposit_nok,v.retail_nok FROM price_policies p
        JOIN variants v ON v.id=p.variant_id`).all())
        assert.equal(policy.deposit_nok,Math.round(policy.retail_nok*.08));
      assertNoDemoRows(db);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});

test('弱凭据、演示域和无效管理员输入在创建数据库前拒绝',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const config=configFor(fixture);
    for(const input of [
      {...admin,password:'short'},
      {...admin,password:'Demo123!'},
      {...admin,email:'admin@bsr.demo'},
      {...admin,operator:''},
      {...admin,name:'x'}
    ]){
      assert.throws(()=>initializeShowcase(config,input));
      assert.deepEqual(sourceFiles(fixture.dbPath),[],'无效输入不得创建数据库或日志文件');
    }
  }finally{fixture.cleanup();}
});

test('重复初始化与残缺旧来源均拒绝，原文件摘要不变',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const config=configFor(fixture);
    initializeShowcase(config,admin);
    const before=snapshot(fixture.dbPath);
    assert.throws(()=>initializeShowcase(config,admin),{code:'INITIAL_ALREADY_DONE'});
    assert.deepEqual(snapshot(fixture.dbPath),before);
  }finally{fixture.cleanup();}
  const incomplete=await makeShowcaseFixture();
  try{
    readySyntheticSource(incomplete.dbPath);
    const db=openDb(incomplete.dbPath,{runMode:'showcase'});
    db.prepare('DELETE FROM showcase_dataset WHERE singleton_id=1').run();
    db.close();
    const before=snapshot(incomplete.dbPath);
    assert.throws(()=>initializeShowcase(configFor(incomplete),admin));
    assert.deepEqual(snapshot(incomplete.dbPath),before,'不得自动修补或覆盖残缺来源');
  }finally{incomplete.cleanup();}
});

test('DEMO 与 CANDIDATE 旧库不能转换为 SHOWCASE，拒绝前后摘要一致',async()=>{
  for(const mode of ['demo','candidate']){
    const fixture=await makeShowcaseFixture();
    try{
      if(mode==='demo')openDb(fixture.dbPath,{runMode:'demo'}).close();
      else provenance.initializeCandidate({runMode:'candidate',dbPath:fixture.dbPath},{
        operator:'018-candidate-fixture',name:'候选测试管理员',
        email:'candidate-admin@example.test',password:'Unique#Candidate2026A'
      });
      const before=snapshot(fixture.dbPath);
      assert.throws(()=>initializeShowcase(configFor(fixture),admin));
      assert.deepEqual(snapshot(fixture.dbPath),before);
    }finally{fixture.cleanup();}
  }
});

test('合成数据写入后若初始化中断，整笔事务回滚且来源不得启动',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const config=configFor(fixture);
    assert.throws(()=>initializeShowcase(config,admin,{beforeReady(){throw new Error('forced failure');}}),
      {code:'INITIAL_FAILED'});
    assert.equal(existsSync(fixture.dbPath),true,'结构文件可保留供排查，但不得成为 READY 来源');
    assert.throws(()=>provenance.preflightRuntime(config,{requireReady:true}),
      error=>['SOURCE_UNMARKED','SOURCE_NOT_READY'].includes(error?.code));
    const db=new DatabaseSync(fixture.dbPath,{readOnly:true});
    try{
      for(const table of ['users','runtime_installation','showcase_dataset','stores','variants',
        'units','price_policies','initial_admin_event','reservations'])
        assert.equal(count(db,table),0,`${table} 应随事务回滚`);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});

const workerScript=`
import {initializeShowcase} from ${JSON.stringify(pathToFileURL(join(root,'src','runtime-provenance.mjs')).href)};
import {validateRuntimeConfig} from ${JSON.stringify(pathToFileURL(join(root,'src','runtime-config.mjs')).href)};
let raw='';for await(const chunk of process.stdin)raw+=chunk;
try{const config=validateRuntimeConfig(process.env,{root:${JSON.stringify(root)},publicDir:${JSON.stringify(publicDir)}});
  const result=initializeShowcase(config,JSON.parse(raw));
  process.stdout.write(JSON.stringify({ok:true,result}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code||error.name}));process.exitCode=1;}
`;
function initializeInChild(env,input){
  return new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',workerScript],{
      cwd:root,env:{...process.env,...env},stdio:['pipe','pipe','pipe'],windowsHide:true
    });
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',part=>{stdout+=part;});
    child.stderr.on('data',part=>{stderr+=part;});
    child.once('error',reject);
    child.once('close',code=>{
      let data;try{data=JSON.parse(stdout);}catch{data={ok:false,stdout};}
      resolveResult({code,data,stderr});
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('两个进程并发初始化仅一方成功，没有重复数据或第二个实例',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const results=await Promise.all([
      initializeInChild(fixture.env,admin),initializeInChild(fixture.env,admin)
    ]);
    assert.equal(results.filter(item=>item.data.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(item=>!item.data.ok).length,1,JSON.stringify(results));
    assert.equal(provenance.preflightRuntime(configFor(fixture),{requireReady:true}).status,'ready');
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      assert.equal(count(db,'runtime_installation'),1);
      assert.equal(count(db,'showcase_dataset'),1);
      assert.equal(count(db,'initial_admin_event'),1);
      assert.equal(count(db,'users'),1);
      assert.ok(count(db,'units')>=20);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});
