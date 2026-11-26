import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {makeCandidateFixture,candidateRequest} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';

const root=resolve(import.meta.dirname,'..');
const serverPath=join(root,'src','server.mjs');
const publicDir=join(root,'public');

async function startDemo(fixture){
  const env={...process.env,NODE_ENV:'local',HOST:'127.0.0.1',
    PORT:String(fixture.port),BSR_DB_PATH:join(fixture.dir,'demo.sqlite')};
  for(const key of ['BSR_RUN_MODE','BSR_BACKUP_DIR','BSR_PUBLIC_ORIGIN','BSR_TLS_CERT_PATH','BSR_TLS_KEY_PATH'])delete env[key];
  const child=spawn(process.execPath,[serverPath],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',data=>{stderr+=data;});
  const base='http://127.0.0.1:'+fixture.port;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)break;
    try{const r=await fetch(base+'/api/health');if(r.ok)return {child,base};}catch{}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  child.kill();
  throw new Error('本地演示启动失败：'+stderr);
}

test('默认演示保留旧引导、演示登录与本机服务',async()=>{
  const fixture=await makeCandidateFixture('bsr-demo-contract-');
  let child;
  try{
    const started=await startDemo(fixture);child=started.child;
    const health=await fetch(started.base+'/api/health');
    assert.equal(health.status,200);
    const boot=await (await fetch(started.base+'/api/bootstrap')).json();
    assert.equal(boot.demo,true);
    assert.ok(boot.stores.length>=1);
    const login=await fetch(started.base+'/api/auth/login',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email:'customer@bsr.demo',password:'Demo123!'})
    });
    assert.equal(login.status,200);
    const body=await login.json();
    assert.equal(body.user.role,'customer');
    assert.ok(body.sessionToken);
  }finally{
    if(child){child.kill();await new Promise(resolve=>child.once('close',resolve));}
    fixture.cleanup();
  }
});

test('隔离候选的健康与引导摘要不宣称上线或公开演示身份',async()=>{
  const fixture=await makeCandidateFixture('bsr-candidate-contract-');
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir});
    initializeCandidate(config,{operator:'contract-test',name:'Contract Admin',
      email:'contract-admin@example.test',password:'ContractAdmin#2026A'});
    child=spawn(process.execPath,[serverPath],{cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.resume();child.stderr.resume();
    let health;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)break;
      try{health=await candidateRequest(fixture,'/api/health');if(health.status===200)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.equal(health?.status,200);
    assert.equal(health.data.runMode,'candidate');
    assert.equal(JSON.stringify(health.data).includes(fixture.dir),false);
    const boot=await candidateRequest(fixture,'/api/bootstrap');
    assert.equal(boot.status,200);
    assert.equal(boot.data.demo,false);
    assert.equal(boot.data.runMode,'candidate');
    assert.equal(boot.data.demoLogin,undefined);
    assert.equal(boot.data.capabilities.bookingEnabled,false);
    assert.equal(JSON.stringify(boot.data).includes(fixture.dir),false);
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
    fixture.cleanup();
  }
});
