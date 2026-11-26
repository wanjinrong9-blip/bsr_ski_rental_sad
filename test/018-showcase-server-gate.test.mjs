import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const root=resolve(import.meta.dirname,'..');

test('SHOWCASE 受控 HTTP 入口不暴露演示凭据，无效业务请求不写订单',async()=>{
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    readySyntheticSource(fixture.dbPath);
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
    assert.equal(boot.data.runMode,'showcase');
    assert.equal(boot.data.synthetic,true);
    assert.equal(boot.data.demo,false);
    assert.equal(boot.data.capabilities.bookingEnabled,true);
    assert.equal('demoLogin' in boot.data,false);
    const login=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'synthetic-admin@example.test',password:'Private#Synthetic2026'}
    });
    assert.equal(login.status,200,JSON.stringify(login.data));
    assert.match(login.headers['set-cookie']?.[0]||'',/^__Host-bsr_showcase_session=/);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const me=await candidateRequest(fixture,'/api/me',{headers:{Cookie:cookie}});
    assert.equal(me.status,200,JSON.stringify(me.data));
    for(const [path,status] of [['/api/quote',403],['/api/reservations',403]]){
      const blocked=await candidateRequest(fixture,path,{
        method:'POST',headers:{Origin:fixture.origin,Cookie:cookie},body:{storeId:1,items:[]}
      });
      assert.equal(blocked.status,status,JSON.stringify(blocked.data));
    }
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);}
    finally{db.close();}
  }finally{
    if(child&&child.exitCode===null){
      const closed=new Promise(done=>child.once('close',done));child.kill();await closed;
    }
    fixture.cleanup();
  }
});
