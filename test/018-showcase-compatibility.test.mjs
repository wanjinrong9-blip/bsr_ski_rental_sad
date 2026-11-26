import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate,preflightRuntime} from '../src/runtime-provenance.mjs';
import {candidateRequest,makeCandidateFixture} from './candidate-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const settings={root,publicDir:join(root,'public')};
const admin={operator:'018-compatibility',name:'Compatibility Admin',
  email:'compat-admin@example.test',password:'UniqueCompat#2026A'};
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const count=(db,table)=>db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function installation(db){
  return db.prepare('SELECT run_mode,instance_id,init_state FROM runtime_installation WHERE singleton_id=1').get();
}

function assertModeConstraint(db,expected){
  const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_installation'").get()?.sql;
  assert.ok(sql?.includes("'SHOWCASE'"),'新建数据库的运行用途约束应包括 SHOWCASE');
  db.exec('SAVEPOINT mode_constraint');
  try{
    db.prepare('UPDATE runtime_installation SET run_mode=? WHERE singleton_id=1').run('SHOWCASE');
    assert.equal(installation(db).run_mode,'SHOWCASE');
    assert.throws(()=>db.prepare('UPDATE runtime_installation SET run_mode=? WHERE singleton_id=1').run('UNKNOWN'),
      /constraint|CHECK/i);
  }finally{db.exec('ROLLBACK TO mode_constraint; RELEASE mode_constraint');}
  assert.equal(installation(db).run_mode,expected);
}

test('DEMO 与 CANDIDATE 新库保留原来源，新增 SHOWCASE 仅扩展约束白名单',async()=>{
  const fixture=await makeCandidateFixture('bsr-018-compat-source-');
  const demoPath=join(fixture.dir,'demo.sqlite');
  try{
    const demo=openDb(demoPath);
    try{
      assert.equal(installation(demo).run_mode,'DEMO');
      assert.ok(count(demo,'users')>0);
      assertModeConstraint(demo,'DEMO');
    }finally{demo.close();}

    initializeCandidate({runMode:'candidate',dbPath:fixture.dbPath},admin);
    const candidate=openDb(fixture.dbPath,{runMode:'candidate'});
    try{
      assert.equal(installation(candidate).run_mode,'CANDIDATE');
      assert.equal(count(candidate,'users'),1);
      assert.equal(count(candidate,'reservations'),0);
      assertModeConstraint(candidate,'CANDIDATE');
    }finally{candidate.close();}

    const beforeDemo=digest(demoPath),beforeCandidate=digest(fixture.dbPath);
    assert.throws(()=>preflightRuntime({runMode:'candidate',dbPath:demoPath}),{code:'SOURCE_NOT_CANDIDATE'});
    assert.throws(()=>preflightRuntime({runMode:'showcase',dbPath:demoPath}),{code:'SOURCE_NOT_SHOWCASE'});
    assert.throws(()=>preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath}),{code:'SOURCE_NOT_SHOWCASE'});
    assert.throws(()=>openDb(demoPath,{runMode:'candidate'}),/来源|用途|初始化/);
    assert.throws(()=>openDb(fixture.dbPath,{runMode:'demo'}),/来源|用途|演示/);
    assert.equal(digest(demoPath),beforeDemo,'错误用途不得修改 DEMO 源');
    assert.equal(digest(fixture.dbPath),beforeCandidate,'错误用途不得修改 CANDIDATE 源');
  }finally{fixture.cleanup();}
});

test('CANDIDATE 仍关闭预约，DEMO 仍仅允许本机入口',async()=>{
  const fixture=await makeCandidateFixture('bsr-018-compat-http-');
  let child;
  try{
    assert.throws(()=>validateRuntimeConfig({BSR_RUN_MODE:'demo',HOST:'0.0.0.0'},settings),
      /本地演示只能监听/);
    assert.throws(()=>validateRuntimeConfig({BSR_RUN_MODE:'demo',BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy'},settings),
      {code:'DEMO_PROXY_FORBIDDEN'});
    const demo=validateRuntimeConfig({BSR_RUN_MODE:'demo',HOST:'127.0.0.1'},settings);
    assert.equal(demo.runMode,'demo');
    assert.equal(demo.host,'127.0.0.1');
    assert.equal(demo.transport,'local-http');

    const candidate=validateRuntimeConfig(fixture.env,settings);
    initializeCandidate(candidate,admin);
    child=spawn(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    let ready=false;
    for(let attempt=0;attempt<120;attempt++){
      if(child.exitCode!==null)break;
      try{if((await candidateRequest(fixture,'/api/health')).status===200){ready=true;break;}}catch{}
      await new Promise(done=>setTimeout(done,40));
    }
    assert.equal(ready,true,stderr);
    const boot=await candidateRequest(fixture,'/api/bootstrap');
    assert.equal(boot.status,200);
    assert.equal(boot.data.runMode,'candidate');
    assert.equal(boot.data.capabilities.bookingEnabled,false);
    const quote=await candidateRequest(fixture,'/api/quote',{
      method:'POST',headers:{Origin:fixture.origin},body:{storeId:1,items:[]}
    });
    assert.equal(quote.status,409,JSON.stringify(quote.data));
    const reservation=await candidateRequest(fixture,'/api/reservations',{
      method:'POST',headers:{Origin:fixture.origin},body:{storeId:1,items:[]}
    });
    assert.equal(reservation.status,409,JSON.stringify(reservation.data));
  }finally{
    if(child&&child.exitCode===null){
      const closed=new Promise(done=>child.once('close',done));child.kill();await closed;
    }
    fixture.cleanup();
  }
});

test('DEMO 与 CANDIDATE 重复打开不重播订单、价格或更改来源',async()=>{
  const fixture=await makeCandidateFixture('bsr-018-compat-upgrade-');
  const demoPath=join(fixture.dir,'demo.sqlite');
  try{
    const demo=openDb(demoPath);
    const beforeDemo={
      source:installation(demo),
      counts:Object.fromEntries(['users','stores','variants','units','price_policies','reservations','app_migrations']
        .map(table=>[table,count(demo,table)])),
      policies:demo.prepare('SELECT variant_id,store_id,version,daily_nok,deposit_nok FROM price_policies ORDER BY id').all(),
      quotes:demo.prepare('SELECT id,quote_json FROM reservations ORDER BY id').all()
    };
    demo.close();
    assert.ok(beforeDemo.counts.reservations>0);

    initializeCandidate({runMode:'candidate',dbPath:fixture.dbPath},admin);
    const candidate=openDb(fixture.dbPath,{runMode:'candidate'});
    const beforeCandidate={source:installation(candidate),
      counts:Object.fromEntries(['users','stores','variants','units','price_policies','reservations','app_migrations']
        .map(table=>[table,count(candidate,table)]))};
    candidate.close();
    assert.equal(beforeCandidate.counts.reservations,0);

    for(let attempt=0;attempt<2;attempt++){
      const reopenedDemo=openDb(demoPath);
      try{
        assert.deepEqual(installation(reopenedDemo),beforeDemo.source);
        for(const [table,n] of Object.entries(beforeDemo.counts))assert.equal(count(reopenedDemo,table),n,table);
        assert.deepEqual(reopenedDemo.prepare('SELECT variant_id,store_id,version,daily_nok,deposit_nok FROM price_policies ORDER BY id').all(),beforeDemo.policies);
        assert.deepEqual(reopenedDemo.prepare('SELECT id,quote_json FROM reservations ORDER BY id').all(),beforeDemo.quotes);
      }finally{reopenedDemo.close();}
      const reopenedCandidate=openDb(fixture.dbPath,{runMode:'candidate'});
      try{
        assert.deepEqual(installation(reopenedCandidate),beforeCandidate.source);
        for(const [table,n] of Object.entries(beforeCandidate.counts))assert.equal(count(reopenedCandidate,table),n,table);
      }finally{reopenedCandidate.close();}
    }
  }finally{fixture.cleanup();}
});
