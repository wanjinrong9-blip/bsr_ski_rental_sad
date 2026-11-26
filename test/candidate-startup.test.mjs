import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {preflightRuntime} from '../src/runtime-provenance.mjs';
import {makeCandidateFixture,noCandidateArtifacts} from './candidate-fixtures.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const publicDir=join(root,'public');
const settings={root,publicDir};

test('candidate setup CLI is read-only and unsafe server startup leaves no database',async()=>{
  const fixture=await makeCandidateFixture('bsr-candidate-cli-');
  try{
    const ready=spawnSync(process.execPath,[join(root,'tools','candidate-setup.mjs'),'preflight'],{
      cwd:root,env:{...process.env,...fixture.env},encoding:'utf8',timeout:5000,windowsHide:true
    });
    assert.equal(ready.status,0,ready.stderr);
    assert.equal(JSON.parse(ready.stdout).status,'needs_init');
    assert.equal(noCandidateArtifacts(fixture),true);
    const denied=spawnSync(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env,BSR_PUBLIC_ORIGIN:'https://127.0.0.1:1'},
      encoding:'utf8',timeout:5000,windowsHide:true
    });
    assert.notEqual(denied.status,0);
    assert.equal(noCandidateArtifacts(fixture),true);
  }finally{fixture.cleanup();}
});

test('candidate config and preflight are read-only before initialization',async()=>{
  const fixture=await makeCandidateFixture();
  try{
    const config=validateRuntimeConfig(fixture.env,settings);
    assert.equal(config.runMode,'candidate');
    assert.equal(config.publicOrigin,fixture.origin);
    assert.ok(config.tls.cert.length>0&&config.tls.key.length>0);
    assert.deepEqual(preflightRuntime(config),{status:'needs_init',runMode:'candidate'});
    assert.throws(()=>preflightRuntime(config,{requireReady:true}),/尚未初始化/);
    assert.equal(noCandidateArtifacts(fixture),true);
  }finally{fixture.cleanup();}
});

test('eight unsafe candidate config classes fail before database creation',async()=>{
  const fixture=await makeCandidateFixture();
  try{
    const mutations=[
      {BSR_RUN_MODE:''},
      {BSR_RUN_MODE:'production'},
      {HOST:'0.0.0.0'},
      {PORT:'0'},
      {BSR_PUBLIC_ORIGIN:''},
      {BSR_PUBLIC_ORIGIN:'https://127.0.0.1:4999'},
      {BSR_TLS_CERT_PATH:''},
      {BSR_TLS_KEY_PATH:fixture.certPath},
      {BSR_BACKUP_DIR:join(fixture.dir,'absent')},
      {BSR_DB_PATH:join(publicDir,'candidate-unsafe.sqlite')}
    ];
    for(const mutation of mutations){
      const env={...fixture.env,...mutation};
      assert.throws(()=>validateRuntimeConfig(env,settings),undefined,JSON.stringify(Object.keys(mutation)));
      assert.equal(noCandidateArtifacts(fixture),true,JSON.stringify(Object.keys(mutation)));
    }
  }finally{fixture.cleanup();}
});

test('default demo configuration remains valid and distinct from candidate',()=>{
  const config=validateRuntimeConfig({},settings);
  assert.equal(config.runMode,'demo');
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.port,4173);
  assert.equal(config.tls,null);
});
