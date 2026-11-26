import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {makeCandidateFixture,candidateRequest} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';
import {openDb} from '../src/db.mjs';
import {upgradeFulfillment} from '../src/fulfillment-schema.mjs';

const root=resolve(import.meta.dirname,'..');

test('016 candidate starts with empty repeatable proposal schema and blocks its mutation routes',async()=>{
  const fixture=await makeCandidateFixture('bsr-016-candidate-');
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    initializeCandidate(config,{operator:'016-test',name:'016 Admin',
      email:'admin016@example.test',password:'CandidateAdmin#2026A'});
    const db=openDb(fixture.dbPath,{runMode:'candidate'});
    try{
      upgradeFulfillment(db,'candidate');upgradeFulfillment(db,'candidate');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM amendment_proposals').get().n,0);
      assert.ok(db.prepare('PRAGMA table_info(contract_adjustments)').all().some(c=>c.name==='proposal_id'));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);
    }finally{db.close();}

    child=spawn(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    let ready=false;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)break;
      try{if((await candidateRequest(fixture,'/api/health')).status===200){ready=true;break;}}catch{}
      await new Promise(done=>setTimeout(done,40));
    }
    assert.equal(ready,true,stderr);
    const login=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'admin016@example.test',password:'CandidateAdmin#2026A'}
    });
    assert.equal(login.status,200,JSON.stringify(login.data));
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const paths=[
      '/api/reservations/1/amendments/quote',
      '/api/reservations/1/amendments/proposals',
      '/api/reservations/1/amendments/proposals/1/confirm',
      '/api/reservations/1/amendments'
    ];
    for(const path of paths){
      const response=await candidateRequest(fixture,path,{
        method:'POST',headers:{Origin:fixture.origin,Cookie:cookie,'Idempotency-Key':'candidate-016-gate-001'},
        body:{accepted:true,baseVersion:1,quoteHash:'none'}
      });
      assert.equal(response.status,409,`${path}: ${response.status} ${JSON.stringify(response.data)}`);
    }
    const after=openDb(fixture.dbPath,{runMode:'candidate'});
    try{
      assert.equal(after.prepare('SELECT COUNT(*) n FROM amendment_proposals').get().n,0);
      assert.equal(after.prepare('SELECT COUNT(*) n FROM contract_adjustments').get().n,0);
    }finally{after.close();}
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
});
