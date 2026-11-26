import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {makeCandidateFixture,noCandidateArtifacts} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';
import {createVerifiedBackup} from '../tools/backup-verify.mjs';
import {restoreCandidateBackup} from '../tools/candidate-restore.mjs';

const root=resolve(import.meta.dirname,'..'),publicDir=join(root,'public');
const externalOrigin='https://preview.example.test';
const externalHost='preview.example.test';
const proxySecret=randomBytes(32).toString('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function proxyEnvironment(fixture){
  const env={...fixture.env,BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',
    BSR_PUBLIC_ORIGIN:externalOrigin,BSR_PROXY_SECRET:proxySecret};
  delete env.BSR_TLS_CERT_PATH;
  delete env.BSR_TLS_KEY_PATH;
  return env;
}

function request(protocol,{port,path='/api/health',method='GET',body,headers={},ca}){
  const payload=body===undefined?null:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const client=protocol==='https:'?https:http;
    const req=client.request({hostname:'127.0.0.1',servername:protocol==='https:'?'':undefined,port,path,method,ca,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        let data;try{data=JSON.parse(text);}catch{data=text;}
        resolve({status:res.statusCode,headers:res.headers,data,text});
      });
    });
    req.on('error',reject);
    if(payload)req.write(payload);
    req.end();
  });
}

async function startCandidate(fixture,env){
  const child=spawn(process.execPath,[join(root,'src','server.mjs')],{
    cwd:root,env:{...process.env,...env,NODE_ENV:'local'},stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr+=part;});
  const headers={'Host':externalHost,'X-BSR-Proxy-Secret':proxySecret,
    'X-BSR-Client-IP':'198.51.100.10','X-Forwarded-Proto':'https'};
  for(let i=0;i<120;i++){
    if(child.exitCode!==null)break;
    try{const response=await request('http:',{port:fixture.port,headers});if(response.status===200)return child;}
    catch{}
    await pause(40);
  }
  child.kill();
  throw new Error('候选代理入口未能启动：'+stderr);
}

async function closeChild(child){
  if(child?.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
}

async function startLocalTlsProxy(fixture,upstreamPort,clientIp){
  const server=https.createServer({cert:readFileSync(fixture.certPath),key:readFileSync(fixture.keyPath)},(incoming,outgoing)=>{
    const headers={...incoming.headers,host:externalHost,
      'x-bsr-proxy-secret':proxySecret,'x-bsr-client-ip':clientIp,'x-forwarded-proto':'https'};
    delete headers['x-forwarded-for'];
    const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:incoming.url,
      method:incoming.method,headers},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});
    upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
    incoming.pipe(upstream);
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  return server;
}

async function closeServer(server){
  if(!server)return;
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}

test('trusted local proxy config is explicit, loopback-only and fail closed',async()=>{
  const fixture=await makeCandidateFixture('bsr-017-config-');
  try{
    const env=proxyEnvironment(fixture),config=validateRuntimeConfig(env,{root,publicDir});
    assert.equal(config.runMode,'candidate');
    assert.equal(config.transport,'trusted-local-proxy');
    assert.equal(config.host,'127.0.0.1');
    assert.equal(config.publicOrigin,externalOrigin);
    assert.equal(config.tls,null);
    assert.equal(config.proxySecret,proxySecret);
    for(const change of [
      {HOST:'0.0.0.0'},{BSR_PROXY_SECRET:''},{BSR_PROXY_SECRET:'short'},
      {BSR_PROXY_SECRET:'a'.repeat(64)},{BSR_PROXY_SECRET:'g'.repeat(64)},
      {BSR_PROXY_SECRET:'0123456789abcdef'.repeat(4)},
      {PORT:'0'},{BSR_DB_PATH:join(root,'data','bsr.sqlite')},
      {BSR_BACKUP_DIR:join(fixture.dir,'missing')},
      {BSR_CANDIDATE_TRANSPORT:'unknown'},
      {BSR_TLS_CERT_PATH:fixture.certPath},
      {BSR_PUBLIC_ORIGIN:'http://preview.example.test'},
      {BSR_PUBLIC_ORIGIN:'https://preview.example.test/path'},
      {BSR_PUBLIC_ORIGIN:'https://user:pass@preview.example.test'},
      {BSR_PUBLIC_ORIGIN:'https://127.0.0.1:443'},
      {BSR_PUBLIC_ORIGIN:'https://preview.example.test?token=1'},
      {BSR_PUBLIC_ORIGIN:'https://preview.example.test/#fragment'}
    ])assert.throws(()=>validateRuntimeConfig({...env,...change},{root,publicDir}),undefined,JSON.stringify(change));
    assert.throws(()=>validateRuntimeConfig({...env,BSR_RUN_MODE:'demo'},{root,publicDir}),
      'proxy transport must never turn the public-credential demo mode into a hosted service');
    const direct=validateRuntimeConfig(fixture.env,{root,publicDir});
    assert.equal(direct.transport,'direct-tls');
    assert.ok(direct.tls.cert.length>0);
    assert.equal(noCandidateArtifacts(fixture),true,'config validation must remain read-only');
  }finally{fixture.cleanup();}
});

test('local HTTPS proxy gates every request and keeps candidate identity and booking closed',async()=>{
  const fixture=await makeCandidateFixture('bsr-017-http-');
  let child,proxyA,proxyB;
  try{
    const direct=validateRuntimeConfig(fixture.env,{root,publicDir});
    initializeCandidate(direct,{operator:'017-local-test',name:'Proxy Candidate Admin',
      email:'proxy-admin@example.test',password:'ProxyAdmin#2026Strong'});
    const env=proxyEnvironment(fixture);
    child=await startCandidate(fixture,env);
    const baseHeaders={'Host':externalHost,'X-BSR-Proxy-Secret':proxySecret,
      'X-BSR-Client-IP':'198.51.100.10','X-Forwarded-Proto':'https'};
    const internal=extra=>request('http:',{port:fixture.port,headers:{...baseHeaders,...extra}});
    assert.equal((await request('http:',{port:fixture.port})).status,403,'direct local request lacks proxy identity');
    assert.equal((await request('http:',{port:fixture.port,path:'/app.js'})).status,403,'static assets are also proxy-gated');
    for(const omitted of ['Host','X-BSR-Proxy-Secret','X-BSR-Client-IP','X-Forwarded-Proto']){
      const headers={...baseHeaders};delete headers[omitted];
      assert.equal((await request('http:',{port:fixture.port,headers})).status,403,`missing ${omitted}`);
    }
    const rejectedHeaders=[
      ['wrong secret',{'X-BSR-Proxy-Secret':'wrong'}],
      ['blank secret',{'X-BSR-Proxy-Secret':''}],
      ['blank host',{'Host':''}],
      ['wrong host',{'Host':'evil.example.test'}],
      ['host with port',{'Host':externalHost+':443'}],
      ['trailing-dot host',{'Host':externalHost+'.'}],
      ['http forwarding',{'X-Forwarded-Proto':'http'}],
      ['uppercase forwarding',{'X-Forwarded-Proto':'HTTPS'}],
      ['blank forwarding',{'X-Forwarded-Proto':''}],
      ['blank client IP',{'X-BSR-Client-IP':''}],
      ['comma-separated IPs',{'X-BSR-Client-IP':'198.51.100.10, 203.0.113.9'}],
      ['space-separated IPs',{'X-BSR-Client-IP':'198.51.100.10 203.0.113.9'}],
      ['IP with port',{'X-BSR-Client-IP':'198.51.100.10:443'}],
      ['bracketed IPv6',{'X-BSR-Client-IP':'[2001:db8::1]'}],
      ['invalid IP',{'X-BSR-Client-IP':'invalid-address'}],
      ['duplicate proxy secret',{'X-BSR-Proxy-Secret':[proxySecret,'wrong']}],
      ['duplicate client IP',{'X-BSR-Client-IP':['198.51.100.10','203.0.113.9']}],
      ['duplicate proto',{'X-Forwarded-Proto':['https','http']}]
    ];
    for(const [label,headers] of rejectedHeaders)
      assert.equal((await internal(headers)).status,403,label);
    const rejectedPaths=[
      'https://evil.example.test/api/health',
      'http://preview.example.test/api/health',
      '//evil.example.test/api/health',
      '/api/health#fragment',
      '/api/health\\evil'
    ];
    for(const path of rejectedPaths)
      assert.equal((await request('http:',{port:fixture.port,path,headers:baseHeaders})).status,403,path);
    assert.ok(rejectedHeaders.length+rejectedPaths.length+6>=20,'cover at least twenty forged/direct requests');
    proxyA=await startLocalTlsProxy(fixture,fixture.port,'198.51.100.10');
    proxyB=await startLocalTlsProxy(fixture,fixture.port,'198.51.100.11');
    const from=(proxy,options={})=>request('https:',{port:proxy.address().port,
      ca:readFileSync(fixture.certPath),...options,headers:{Host:externalHost,...options.headers}});
    const health=await from(proxyA);assert.equal(health.status,200);
    const boot=await from(proxyA,{path:'/api/bootstrap'});
    assert.equal(boot.status,200);assert.equal(boot.data.runMode,'candidate');
    assert.equal(boot.data.demo,false);assert.equal(boot.data.capabilities.bookingEnabled,false);
    const wrongOrigin=await from(proxyA,{path:'/api/auth/login',method:'POST',
      headers:{Origin:'https://evil.example.test'},body:{email:'proxy-admin@example.test',password:'ProxyAdmin#2026Strong'}});
    assert.equal(wrongOrigin.status,403);
    const login=await from(proxyA,{path:'/api/auth/login',method:'POST',
      headers:{Origin:externalOrigin,'X-BSR-Client-IP':'203.0.113.42','X-BSR-Proxy-Secret':'spoofed'},
      body:{email:'proxy-admin@example.test',password:'ProxyAdmin#2026Strong'}});
    assert.equal(login.status,200,JSON.stringify(login.data));
    assert.match(login.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Strict; Path=\//);
    assert.equal(login.data.sessionToken,undefined);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const me=await from(proxyA,{path:'/api/me',headers:{Cookie:cookie}});
    assert.equal(me.status,200);assert.equal(me.data.role,'admin');
    const quote=await from(proxyA,{path:'/api/quote',method:'POST',headers:{Origin:externalOrigin},body:{storeId:1,items:[]}});
    assert.equal(quote.status,409,'hosted candidate still cannot book unapproved catalog');

    const badBody={email:'missing@example.test',password:'Wrong#2026Strong'};
    assert.equal((await from(proxyA,{path:'/api/auth/login',method:'POST',headers:{Origin:externalOrigin,'X-Forwarded-For':'203.0.113.90','X-BSR-Client-IP':'203.0.113.42'},body:badBody})).status,401);
    assert.equal((await from(proxyB,{path:'/api/auth/login',method:'POST',headers:{Origin:externalOrigin,'X-Forwarded-For':'203.0.113.90'},body:badBody})).status,401);
    for(let attempt=0;attempt<4;attempt++)assert.equal((await from(proxyA,{path:'/api/auth/login',method:'POST',
      headers:{Origin:externalOrigin},body:{...badBody,email:`missing-${attempt}@example.test`}})).status,401);
    const validAdmin={email:'proxy-admin@example.test',password:'ProxyAdmin#2026Strong'};
    const limited=await from(proxyA,{path:'/api/auth/login',method:'POST',headers:{Origin:externalOrigin},body:validAdmin});
    assert.equal(limited.status,429,'client A reaches its own SOURCE limit');
    assert.equal(limited.data.code,'AUTH_RATE_LIMITED');
    assert.equal((await from(proxyB,{path:'/api/auth/login',method:'POST',
      headers:{Origin:externalOrigin},body:validAdmin})).status,200,'client B remains able to log in');
    const probe=new DatabaseSync(fixture.dbPath,{readOnly:true});
    try{
      const instance=probe.prepare('SELECT instance_id FROM runtime_installation WHERE singleton_id=1').get().instance_id;
      const sourceKey=ip=>createHash('sha256').update([instance,'source',ip].join('|')).digest('hex');
      const actual=probe.prepare("SELECT key_hash FROM auth_attempt_buckets WHERE dimension='SOURCE'").all().map(row=>row.key_hash).sort();
      assert.deepEqual(actual,[sourceKey('198.51.100.10'),sourceKey('198.51.100.11')].sort(),
        'only proxy-provided client IPs enter source buckets; client-sent headers are ignored');
    }
    finally{probe.close();}
  }finally{
    await closeServer(proxyA);await closeServer(proxyB);await closeChild(child);fixture.cleanup();
  }
});

test('proxy candidate survives a restart and restores into a new private file with old sessions revoked',async()=>{
  const fixture=await makeCandidateFixture('bsr-017-restore-');
  let child;
  try{
    const env=proxyEnvironment(fixture),admin={operator:'017-restore',name:'Proxy Restore Admin',
      email:'proxy-restore@example.test',password:'ProxyRestore#2026Strong'};
    initializeCandidate(validateRuntimeConfig(env,{root,publicDir}),admin);
    const headers={'Host':externalHost,'X-BSR-Proxy-Secret':proxySecret,
      'X-BSR-Client-IP':'198.51.100.21','X-Forwarded-Proto':'https'};
    const from=(path,options={})=>request('http:',{port:fixture.port,path,...options,
      headers:{...headers,...options.headers}});
    child=await startCandidate(fixture,env);
    const login=await from('/api/auth/login',{method:'POST',headers:{Origin:externalOrigin},
      body:{email:admin.email,password:admin.password}});
    assert.equal(login.status,200);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await from('/api/me',{headers:{Cookie:cookie}})).status,200);
    await closeChild(child);child=null;
    const backup=await createVerifiedBackup({sourcePath:fixture.dbPath,outputDir:fixture.backupDir});
    assert.equal(backup.integrity,'ok');
    const restoredPath=join(fixture.dir,'restored.sqlite');
    const restored=await restoreCandidateBackup({env:{...env,BSR_DB_PATH:restoredPath},
      backupPath:backup.backupPath,manifestPath:backup.manifestPath,operator:'017-restore-test'});
    assert.equal(restored.status,'ready');
    assert.equal(restored.revokedSessions,1);
    child=await startCandidate(fixture,{...env,BSR_DB_PATH:restoredPath});
    assert.equal((await from('/api/me',{headers:{Cookie:cookie}})).status,401);
    const fresh=await from('/api/auth/login',{method:'POST',headers:{Origin:externalOrigin},
      body:{email:admin.email,password:admin.password}});
    assert.equal(fresh.status,200);
    assert.equal((await from('/api/bootstrap')).data.capabilities.bookingEnabled,false);
  }finally{await closeChild(child);fixture.cleanup();}
});
