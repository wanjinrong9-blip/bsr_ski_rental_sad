import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate,preflightRuntime} from '../src/runtime-provenance.mjs';
import {openDb} from '../src/db.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const publicDir=join(root,'public');
const paths={root,publicDir};
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const noDatabase=fixture=>
  !existsSync(fixture.dbPath)&&!existsSync(fixture.dbPath+'-wal')&&!existsSync(fixture.dbPath+'-shm');

function assertSourceUnchanged(file,before){
  assert.equal(hash(file),before,'拒绝来源后原数据库字节不能改变');
  assert.equal(existsSync(file+'-wal'),false,'拒绝来源不能创建 WAL');
  assert.equal(existsSync(file+'-shm'),false,'拒绝来源不能创建 SHM');
}

test('SHOWCASE 是显式第三用途；省略模式仍是回环 DEMO',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    assert.equal(validateRuntimeConfig({},paths).runMode,'demo');
    for(const mode of ['', 'production', 'SHOWCASE', 'candidate,showcase']){
      assert.throws(()=>validateRuntimeConfig({...fixture.env,BSR_RUN_MODE:mode},paths),{code:'RUN_MODE_INVALID'});
      assert.equal(noDatabase(fixture),true);
    }
    const config=validateRuntimeConfig(fixture.env,paths);
    assert.equal(config.runMode,'showcase');
    assert.equal(config.transport,'direct-tls');
    assert.equal(config.publicOrigin,fixture.origin);
    assert.ok(config.tls.cert.length>0&&config.tls.key.length>0);
    assert.deepEqual(preflightRuntime(config),{status:'needs_init',runMode:'showcase'});
    assert.throws(()=>preflightRuntime(config,{requireReady:true}),{code:'SOURCE_NEEDS_INIT'});
    assert.equal(noDatabase(fixture),true,'预检不能创建数据库或日志文件');
  }finally{fixture.cleanup();}
});

test('SHOWCASE 直连 HTTPS 配置拒绝公开、备份与无效入口且不建库',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    assert.equal(validateRuntimeConfig(fixture.env,paths).runMode,'showcase');
    const publicDb=join(publicDir,'showcase-unsafe-'+randomBytes(6).toString('hex')+'.sqlite');
    const backupDb=join(fixture.backupDir,'showcase-unsafe.sqlite');
    const mutations=[
      {HOST:'0.0.0.0'},
      {PORT:'0'},
      {BSR_DB_PATH:publicDb},
      {BSR_DB_PATH:backupDb},
      {BSR_DB_PATH:join(root,'data','bsr.sqlite')},
      {BSR_BACKUP_DIR:join(fixture.dir,'missing-backups')},
      {BSR_PUBLIC_ORIGIN:'http://127.0.0.1:'+fixture.port},
      {BSR_PUBLIC_ORIGIN:'https://127.0.0.1:1'},
      {BSR_PUBLIC_ORIGIN:fixture.origin+'/extra'},
      {BSR_TLS_CERT_PATH:''},
      {BSR_TLS_KEY_PATH:fixture.certPath},
      {BSR_PROXY_SECRET:randomBytes(32).toString('hex')}
    ];
    for(const mutation of mutations){
      assert.throws(()=>validateRuntimeConfig({...fixture.env,...mutation},paths),
        error=>error?.code!=='RUN_MODE_INVALID',JSON.stringify(mutation));
      assert.equal(noDatabase(fixture),true,JSON.stringify(mutation));
      assert.equal(existsSync(publicDb),false,'配置拒绝不能创建公开数据库');
      assert.equal(existsSync(backupDb),false,'配置拒绝不能在备份目录创建数据库');
    }
  }finally{fixture.cleanup();}
});

test('SHOWCASE 可信本机代理沿用受控来源与强随机密钥门槛',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const secret=randomBytes(32).toString('hex');
    const env={...fixture.env,BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',
      BSR_PUBLIC_ORIGIN:'https://showcase.example.test',BSR_PROXY_SECRET:secret};
    delete env.BSR_TLS_CERT_PATH;
    delete env.BSR_TLS_KEY_PATH;
    const config=validateRuntimeConfig(env,paths);
    assert.equal(config.runMode,'showcase');
    assert.equal(config.transport,'trusted-local-proxy');
    assert.equal(config.proxySecret,secret);
    assert.equal(config.tls,null);
    for(const mutation of [
      {HOST:'0.0.0.0'},
      {BSR_PROXY_SECRET:'short'},
      {BSR_PROXY_SECRET:'a'.repeat(64)},
      {BSR_PROXY_SECRET:'0123456789abcdef'.repeat(4)},
      {BSR_CANDIDATE_TRANSPORT:'unknown'},
      {BSR_PUBLIC_ORIGIN:'https://127.0.0.1'},
      {BSR_PUBLIC_ORIGIN:'https://showcase.example.test/path'},
      {BSR_TLS_CERT_PATH:fixture.certPath}
    ]){
      assert.throws(()=>validateRuntimeConfig({...env,...mutation},paths),
        error=>error?.code!=='RUN_MODE_INVALID',JSON.stringify(mutation));
      assert.equal(noDatabase(fixture),true,JSON.stringify(mutation));
    }
  }finally{fixture.cleanup();}
});

test('SHOWCASE 来源预检拒绝未标记、DEMO 与 CANDIDATE 文件且字节不变',async()=>{
  for(const sourceMode of ['unmarked','demo','candidate']){
    const fixture=await makeShowcaseFixture();
    try{
      if(sourceMode==='unmarked'){
        const db=new DatabaseSync(fixture.dbPath);
        db.exec('CREATE TABLE old_records(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        db.prepare('INSERT INTO old_records(value) VALUES(?)').run('historical fixture');
        db.close();
      }else if(sourceMode==='demo'){
        openDb(fixture.dbPath,{runMode:'demo'}).close();
      }else{
        initializeCandidate({runMode:'candidate',dbPath:fixture.dbPath},{
          operator:'showcase-startup-test',name:'Candidate Fixture Admin',
          email:'candidate-fixture@example.test',password:'CandidateFixture#2026A'
        });
      }
      const before=hash(fixture.dbPath);
      const expected=sourceMode==='unmarked'?'SOURCE_UNMARKED':'SOURCE_NOT_SHOWCASE';
      assert.throws(()=>preflightRuntime({runMode:'showcase',dbPath:fixture.dbPath}),{code:expected});
      assertSourceUnchanged(fixture.dbPath,before);
    }finally{fixture.cleanup();}
  }
});

test('未初始化的 SHOWCASE 服务在监听前拒绝且不产生数据库副作用',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const config=validateRuntimeConfig(fixture.env,paths);
    assert.throws(()=>preflightRuntime(config,{requireReady:true}),{code:'SOURCE_NEEDS_INIT'});
    const result=spawnSync(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env},encoding:'utf8',timeout:5000,windowsHide:true
    });
    assert.notEqual(result.status,0,'未初始化的 SHOWCASE 不能提供服务');
    assert.equal(noDatabase(fixture),true,'启动拒绝不能创建库、WAL 或 SHM');
  }finally{fixture.cleanup();}
});
