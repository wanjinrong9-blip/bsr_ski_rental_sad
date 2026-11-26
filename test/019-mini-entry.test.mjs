import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {effectiveMiniEntry,loadMiniEntry,miniEntryPublic} from '../src/mini-entry.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';

const appId='wx1234567890abcdef',key='4'.repeat(64);
const logo=fileURLToPath(new URL('../public/bsr-logo.png',import.meta.url));
const stateVars=['BSR_MINI_ENTRY_STATE','BSR_MINI_APP_ID','BSR_MINI_RELEASE_QR_FILE',
  'BSR_MINI_RELEASE_RECEIPT_FILE','BSR_MINI_RELEASE_ATTEST_KEY',
  'BSR_MINI_RELEASE_CONFIRMED','BSR_WECHAT_MINI_ENABLED','BSR_WECHAT_APP_ID'];
function receipt(f,overrides={}){
  const now=Date.now();
  const payload={version:1,source:'operator-attested',appId,page:'pages/catalog/index',
    scene:'home',imageSha256:createHash('sha256').update(readFileSync(f.qrFile)).digest('hex'),
    approvedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+86400000).toISOString(),
    ...overrides};
  const mac=createHmac('sha256',Buffer.from(key,'hex'))
    .update(JSON.stringify(payload)).digest('hex');
  writeFileSync(f.receiptFile,JSON.stringify({...payload,mac}));
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-entry-'));
  const publicDir=join(dir,'site','public');mkdirSync(publicDir,{recursive:true});
  const qrFile=join(dir,'locally-attested-test-code.png');
  const receiptFile=join(dir,'private-receipt.json');
  // Deliberately a BSR logo, not a WeChat-issued code. A keyed local receipt
  // tests the READY branch but is never evidence of real platform issuance.
  copyFileSync(logo,qrFile);
  const f={dir,publicDir,qrFile,receiptFile};
  receipt(f);
  f.env={BSR_MINI_ENTRY_STATE:'READY',BSR_MINI_APP_ID:appId,
    BSR_MINI_RELEASE_QR_FILE:qrFile,BSR_MINI_RELEASE_RECEIPT_FILE:receiptFile,
    BSR_MINI_RELEASE_ATTEST_KEY:key,BSR_MINI_RELEASE_CONFIRMED:'1',
    BSR_WECHAT_MINI_ENABLED:'1',BSR_WECHAT_APP_ID:appId};
  return f;
}
function clean(f){rmSync(f.dir,{recursive:true,force:true});}

test('OFF and PAUSED disclose no image and legacy PNG cannot silently become READY',()=>{
  const f=fixture();
  try{
    assert.deepEqual(miniEntryPublic(loadMiniEntry({}, {runMode:'demo',publicDir:f.publicDir})),
      {status:'off',qrUrl:null});
    const paused=loadMiniEntry({...f.env,BSR_MINI_ENTRY_STATE:'PAUSED'},
      {runMode:'showcase',publicDir:f.publicDir});
    assert.deepEqual(miniEntryPublic(paused),{status:'paused',qrUrl:null});
    assert.equal(paused.qrBytes,undefined);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_ENTRY_STATE:undefined},
      {runMode:'showcase',publicDir:f.publicDir}),/旧版发布配置/);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_ENTRY_STATE:'READY'},
      {runMode:'demo',publicDir:f.publicDir}),/只允许在独立/);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_ENTRY_STATE:'READY'},
      {runMode:'candidate',publicDir:f.publicDir}),/只允许在独立/);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_ENTRY_STATE:'LIVE'},
      {runMode:'showcase',publicDir:f.publicDir}),/须为 OFF/);
  }finally{clean(f);}
});

test('READY is keyed to private PNG digest, AppID, public home scene and release switch',()=>{
  const f=fixture();
  try{
    const ready=loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir});
    assert.equal(ready.status,'ready');
    assert.deepEqual(miniEntryPublic(ready),{status:'ready',qrUrl:'/api/mini-entry/code'});
    assert.equal(effectiveMiniEntry(ready,ready.expiresAtMs-1).status,'ready');
    assert.deepEqual(miniEntryPublic(ready,ready.expiresAtMs),
      {status:'paused',qrUrl:null});
    assert.equal(effectiveMiniEntry(ready,ready.expiresAtMs).qrBytes,undefined);
    assert.equal(JSON.stringify(miniEntryPublic(ready)).includes(appId),false);
    assert.equal(JSON.stringify(miniEntryPublic(ready)).includes(f.dir),false);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_RELEASE_CONFIRMED:'0'},
      {runMode:'showcase',publicDir:f.publicDir}),/配置不完整/);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_WECHAT_APP_ID:'wx0000000000000000'},
      {runMode:'showcase',publicDir:f.publicDir}),/AppID 不一致/);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_RELEASE_ATTEST_KEY:'0'.repeat(64)},
      {runMode:'showcase',publicDir:f.publicDir}),/来源凭据/);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_RELEASE_RECEIPT_FILE:join(f.publicDir,'r.json')},
      {runMode:'showcase',publicDir:f.publicDir}),/项目目录之外/);
    const publicImage=join(f.publicDir,'code.png');copyFileSync(f.qrFile,publicImage);
    assert.throws(()=>loadMiniEntry({...f.env,BSR_MINI_RELEASE_QR_FILE:publicImage},
      {runMode:'showcase',publicDir:f.publicDir}),/项目目录之外/);
    receipt(f,{scene:'user=1'});
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),/来源凭据/);
    receipt(f,{source:'unknown-source'});
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),/来源凭据/);
    receipt(f,{expiresAt:new Date(Date.now()-1000).toISOString()});
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),/过期/);
    receipt(f);
    writeFileSync(f.qrFile,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(120)]));
    receipt(f);
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),/完整 PNG/);
  }finally{clean(f);}
});

test('changed code bytes or receipt MAC fail closed; local attestation does not prove issuer',()=>{
  const f=fixture();
  try{
    const image=readFileSync(f.qrFile);
    image[image.length-16]^=1;writeFileSync(f.qrFile,image);
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),
      /PNG 校验失败|来源凭据/);
    copyFileSync(logo,f.qrFile);receipt(f);
    const value=JSON.parse(readFileSync(f.receiptFile,'utf8'));
    value.mac='0'.repeat(64);writeFileSync(f.receiptFile,JSON.stringify(value));
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),/来源凭据/);
  }finally{clean(f);}
});

test('private operator tool signs a fresh receipt only after explicit local review',()=>{
  const f=fixture();
  try{
    rmSync(f.receiptFile);
    const tool=fileURLToPath(new URL('../tools/attest-mini-entry.mjs',import.meta.url));
    const env={...process.env,...f.env,BSR_RUN_MODE:'showcase',
      BSR_MINI_CODE_PLATFORM_REVIEWED:'0'};
    const denied=spawnSync(process.execPath,[tool],{env,encoding:'utf8'});
    assert.notEqual(denied.status,0);
    assert.equal(readFileSync(f.qrFile).length>0,true);
    assert.throws(()=>loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}),
      /不可读取/);
    env.BSR_MINI_CODE_PLATFORM_REVIEWED='1';
    const signed=spawnSync(process.execPath,[tool],{env,encoding:'utf8'});
    assert.equal(signed.status,0,signed.stderr);
    assert.match(signed.stdout,/真实微信签发和手机扫码仍待独立验收/);
    assert.equal(loadMiniEntry(f.env,{runMode:'showcase',publicDir:f.publicDir}).status,'ready');
    assert.notEqual(spawnSync(process.execPath,[tool],{env,encoding:'utf8'}).status,0);
  }finally{clean(f);}
});

test('本地网站 OFF 状态不返回图片并保持原网页可用',async()=>{
  const f=fixture();
  const names=['NODE_ENV','BSR_DB_PATH','BSR_RUN_MODE',...stateVars];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  let server,db;
  try{
    process.env.NODE_ENV='test';process.env.BSR_DB_PATH=join(f.dir,'test.sqlite');
    process.env.BSR_RUN_MODE='demo';
    for(const name of stateVars)delete process.env[name];
    ({server,db}=await import('../src/server.mjs'));
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base='http://127.0.0.1:'+server.address().port;
    const entry=await fetch(base+'/api/mini-entry');
    assert.equal(entry.status,200);
    assert.deepEqual(await entry.json(),{status:'off',qrUrl:null});
    assert.equal((await fetch(base+'/api/mini-entry/code')).status,404);
    const page=await fetch(base+'/#/mini');
    assert.equal(page.status,200);
    assert.match(await page.text(),/mini-entry\.css/);
  }finally{
    if(server?.listening){server.close();await once(server,'close');}
    db?.close();
    for(const [name,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
    clean(f);
  }
});

test('READY 凭据跨过期限后无需重启即转 PAUSED，图片路由拒绝访问',async()=>{
  const f=fixture(),showcase=await makeShowcaseFixture();
  const names=[...new Set(['NODE_ENV',...stateVars,
    'BSR_WECHAT_APP_SECRET','BSR_WECHAT_OPENID_KEY',...Object.keys(showcase.env)])];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const originalNow=Date.now;
  const expiryMs=originalNow()+60000;
  let server,db;
  try{
    receipt(f,{expiresAt:new Date(expiryMs).toISOString()});
    readySyntheticSource(showcase.dbPath);
    Object.assign(process.env,showcase.env,f.env,{
      NODE_ENV:'test',
      BSR_WECHAT_APP_SECRET:'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      BSR_WECHAT_OPENID_KEY:'019-expiry-test-openid-key-32-chars-long'
    });
    ({server,db}=await import('../src/server.mjs?mini-entry-expiry-test=1'));
    server.listen(showcase.port,'127.0.0.1');await once(server,'listening');
    const before=await candidateRequest(showcase,'/api/mini-entry');
    assert.deepEqual(before.data,{status:'ready',qrUrl:'/api/mini-entry/code'});
    assert.equal((await candidateRequest(showcase,'/api/mini-entry/code')).status,200);

    Date.now=()=>expiryMs;
    assert.equal(server.listening,true);
    const after=await candidateRequest(showcase,'/api/mini-entry');
    assert.deepEqual(after.data,{status:'paused',qrUrl:null});
    assert.equal((await candidateRequest(showcase,'/api/mini-entry/code')).status,404);
    assert.equal(server.listening,true);
  }finally{
    Date.now=originalNow;
    if(server?.listening){
      server.closeAllConnections();
      server.close();await once(server,'close');
    }
    db?.close();
    for(const [name,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
    clean(f);showcase.cleanup();
  }
});
