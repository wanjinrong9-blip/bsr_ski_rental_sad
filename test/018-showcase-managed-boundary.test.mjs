import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openDb,hashPassword,SHOWCASE_SCHEMA_VERSION} from '../src/db.mjs';
import {assertTrustedProxyRequest} from '../src/proxy-boundary.mjs';
import {candidateLogin,candidateLogout,candidateSessionUser} from '../src/identity.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';

test('SHOWCASE 可信代理必须逐项核验主机、密钥和原始来源',()=>{
  const secret=randomBytes(32).toString('hex');
  const startup={runMode:'showcase',transport:'trusted-local-proxy',
    publicOrigin:'https://showcase.example.test',proxySecret:secret};
  const request={url:'/api/health',socket:{remoteAddress:'127.0.0.1'},
    headers:{host:'showcase.example.test','x-forwarded-proto':'https',
      'x-bsr-proxy-secret':secret,'x-bsr-client-ip':'203.0.113.27'}};
  assert.equal(assertTrustedProxyRequest(request,startup),'203.0.113.27');
  for(const changed of [
    {headers:{...request.headers,host:'other.example.test'}},
    {headers:{...request.headers,'x-bsr-proxy-secret':'wrong'}},
    {headers:{...request.headers,'x-forwarded-proto':'http'}},
    {socket:{remoteAddress:'203.0.113.27'}},
    {url:'//other.example.test/api/health'}
  ])assert.throws(()=>assertTrustedProxyRequest({...request,...changed},startup),
    error=>error?.code==='UNTRUSTED_PROXY');
});

test('SHOWCASE 管理 Cookie 与候选用途隔离，退出撤销会话',async()=>{
  const fixture=await makeShowcaseFixture();
  const db=openDb(fixture.dbPath,{runMode:'showcase',initialize:true});
  try{
    const now=new Date().toISOString(),instance=randomBytes(16).toString('hex');
    const userId=Number(db.prepare(`INSERT INTO users
      (name,email,password_hash,role,created_at,account_state,provisioning_method,verified_at)
      VALUES(?,?,?,'admin',?,'ACTIVE','OFFLINE_ADMIN',?)`)
      .run('虚构管理员','showcase-admin@example.test',hashPassword('Unique#Showcase2026'),now,now).lastInsertRowid);
    db.prepare(`INSERT INTO runtime_installation
      (singleton_id,run_mode,instance_id,schema_version,init_state,initialized_at,initial_admin_id)
      VALUES(1,'SHOWCASE',? ,? ,'READY',?,?)`).run(instance,SHOWCASE_SCHEMA_VERSION,now,userId);
    const login=candidateLogin(db,{socket:{remoteAddress:'127.0.0.1'}},
      {email:'showcase-admin@example.test',password:'Unique#Showcase2026'},
      {runMode:'showcase'});
    assert.match(login.cookie,/^__Host-bsr_showcase_session=[a-f0-9]+; HttpOnly; Secure; SameSite=Strict;/);
    const request={headers:{cookie:login.cookie.split(';')[0]}};
    assert.equal(candidateSessionUser(db,request,{runMode:'showcase'})?.id,userId);
    assert.equal(candidateSessionUser(db,request,{runMode:'candidate'}),null);
    const logout=candidateLogout(db,request,{runMode:'showcase'});
    assert.match(logout.cookie,/Max-Age=0/);
    assert.equal(candidateSessionUser(db,request,{runMode:'showcase'}),null);
    assert.throws(()=>candidateLogin(db,{socket:{remoteAddress:'127.0.0.1'}},
      {email:'showcase-admin@example.test',password:'Unique#Showcase2026'},
      {runMode:'candidate'}),error=>error?.code==='CANDIDATE_NOT_READY');
  }finally{db.close();fixture.cleanup();}
});
