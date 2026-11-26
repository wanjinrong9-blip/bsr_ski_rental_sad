import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hashPassword,openDb} from '../src/db.mjs';
import {candidateLogin,candidateSessionUser} from '../src/identity.mjs';
import {createMiniApi} from '../src/mini-api.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const previousNodeEnv=process.env.NODE_ENV;
process.env.NODE_ENV='test';
after(()=>{if(previousNodeEnv===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=previousNodeEnv;});

const appId='wx1234567890abcdef';
const key='019-private-mini-api-test-openid-digest-key';
const secret='a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
const code='miniRouteCode0123456789abcdef';
const openid='oX00000000000000000000000000';
const customerEmail='mini-api-customer@example.test';
const customerPassword='Private#MiniApi2026';
const staffEmail='mini-api-staff@example.test';
const staffPassword='Private#MiniStaff2026';
const enabledEnv={BSR_WECHAT_MINI_ENABLED:'1',BSR_WECHAT_APP_ID:appId,
  BSR_WECHAT_OPENID_KEY:key,BSR_WECHAT_APP_SECRET:secret};

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'bsr-mini-api-019-'));
  const path=join(dir,'showcase.sqlite');
  readySyntheticSource(path);
  const db=openDb(path,{runMode:'showcase'});
  const add=(name,email,password,role)=>Number(db.prepare(`INSERT INTO users
    (name,email,password_hash,role,created_at,account_state,provisioning_method,
      verified_at,must_change_password,auth_epoch)
    VALUES(?,?,?,?,'2026-11-20T10:00:00.000Z','ACTIVE','OFFLINE_ADMIN',
      '2026-11-20T10:00:00.000Z',0,1)`)
    .run(name,email,hashPassword(password),role).lastInsertRowid);
  const customerId=add('虚构小程序顾客',customerEmail,customerPassword,'customer');
  add('虚构门店员工',staffEmail,staffPassword,'staff');
  return {db,customerId,close(){db.close();rmSync(dir,{recursive:true,force:true,
    maxRetries:5,retryDelay:100});}};
}

async function invoke(api,path,{method='GET',payload,headers={},source='127.0.0.1'}={}){
  const req={method,headers,socket:{remoteAddress:source},
    bsrClientIp:source,payload};
  const result={};
  result.handled=await api.handle(req,result,new URL(path,'https://example.test'),{
    body:async r=>r.payload,
    json:(res,status,data)=>{res.status=status;res.data=data;}
  });
  return result;
}
const adapter={exchangeCode:async()=>({openid})};

test('Mini routes stay off by default and CANDIDATE cannot enable them',async()=>{
  const f=fixture();
  try{
    for(const [mode,env] of [['showcase',{}],['candidate',enabledEnv],['demo',enabledEnv]]){
      const api=createMiniApi({db:f.db,runMode:mode,env,adapter});
      assert.equal(api.enabled,false);
      const bootstrap=await invoke(api,'/api/mini/bootstrap');
      assert.equal(bootstrap.status,200);
      assert.equal(bootstrap.data.status,'off');
      assert.equal(bootstrap.data.bookingEnabled,false);
      await assert.rejects(invoke(api,'/api/mini/auth/wechat',
        {method:'POST',payload:{code}}),error=>error?.code==='MINI_NOT_READY');
    }
    assert.equal((await invoke(createMiniApi({db:f.db,runMode:'showcase',env:{},adapter}),
      '/api/unrelated')).handled,false);
  }finally{f.close();}
});

test('a fake WeChat adapter cannot be selected by a live server process',()=>{
  const f=fixture();
  try{
    process.env.NODE_ENV='production';
    assert.throws(()=>createMiniApi({db:f.db,runMode:'showcase',env:enabledEnv,adapter}),
      error=>error?.code==='WECHAT_TEST_ADAPTER_FORBIDDEN');
  }finally{process.env.NODE_ENV='test';f.close();}
});

test('Mini login and explicit binding expose a safe customer profile; logout revokes only Mini token',async()=>{
  const f=fixture();
  try{
    const api=createMiniApi({db:f.db,runMode:'showcase',env:enabledEnv,adapter});
    assert.equal(api.enabled,true);
    const login=await invoke(api,'/api/mini/auth/wechat',
      {method:'POST',payload:{code}});
    assert.equal(login.status,200);
    assert.equal(login.data.status,'needs_binding');
    assert.ok(login.data.challenge);
    await assert.rejects(invoke(api,'/api/mini/auth/bind',{method:'POST',
      payload:{challenge:'bad',email:customerEmail,password:customerPassword,
        explicitConsent:true}}),error=>error?.code==='CODE_INVALID');
    await assert.rejects(invoke(api,'/api/mini/auth/bind',{method:'POST',
      payload:{challenge:login.data.challenge,email:staffEmail,password:staffPassword,
        explicitConsent:true}}),error=>error?.code==='FORBIDDEN');
    const bound=await invoke(api,'/api/mini/auth/bind',{method:'POST',
      payload:{challenge:login.data.challenge,email:customerEmail,
        password:customerPassword,explicitConsent:true}});
    assert.equal(bound.status,200);
    assert.equal(bound.data.status,'authenticated');
    assert.equal(bound.data.user.id,f.customerId);
    const token=bound.data.sessionToken;
    assert.ok(token);
    const me=await invoke(api,'/api/mini/me',{headers:{authorization:`Bearer ${token}`}});
    assert.equal(me.status,200);
    assert.equal(me.data.id,f.customerId);
    assert.equal(me.data.role,'customer');
    const publicText=JSON.stringify({login:login.data,bound:bound.data,me:me.data});
    for(const privateValue of [code,openid,key,secret,customerPassword,staffPassword])
      assert.equal(publicText.includes(privateValue),false);
    for(const privateKey of ['password_hash','auth_epoch','openid_digest','binding_id','session_key'])
      assert.equal(privateKey in me.data,false);
    const loggedOut=await invoke(api,'/api/mini/auth/logout',
      {method:'POST',headers:{authorization:`Bearer ${token}`}});
    assert.equal(loggedOut.status,200);
    await assert.rejects(invoke(api,'/api/mini/me',
      {headers:{authorization:`Bearer ${token}`}}),error=>error?.code==='SESSION_EXPIRED');
  }finally{f.close();}
});

test('Mini routes reject Web Cookie and Web token; Mini Bearer cannot enter Web session boundary',async()=>{
  const f=fixture();
  try{
    const api=createMiniApi({db:f.db,runMode:'showcase',env:enabledEnv,adapter});
    const web=candidateLogin(f.db,
      {headers:{cookie:''},socket:{remoteAddress:'127.0.0.1'}},
      {email:customerEmail,password:customerPassword},{runMode:'showcase'});
    const webCookie=web.cookie.split(';')[0],webToken=webCookie.split('=')[1];
    await assert.rejects(invoke(api,'/api/mini/me',{headers:{cookie:webCookie}}),
      error=>error?.code==='SESSION_EXPIRED');
    await assert.rejects(invoke(api,'/api/mini/me',
      {headers:{authorization:`Bearer ${webToken}`}}),
      error=>error?.code==='SESSION_EXPIRED');
    const login=await invoke(api,'/api/mini/auth/wechat',
      {method:'POST',payload:{code}});
    const bound=await invoke(api,'/api/mini/auth/bind',{method:'POST',
      payload:{challenge:login.data.challenge,email:customerEmail,
        password:customerPassword,explicitConsent:true}});
    const miniToken=bound.data.sessionToken;
    assert.equal(candidateSessionUser(f.db,{headers:{cookie:
      `__Host-bsr_showcase_session=${miniToken}`}}, {runMode:'showcase'}),null);
    assert.ok(candidateSessionUser(f.db,{headers:{cookie:webCookie}},
      {runMode:'showcase'}));
  }finally{f.close();}
});

test('Mini code exchange is source-limited before calling the WeChat adapter',async()=>{
  const f=fixture();
  try{
    let calls=0;
    const counted={exchangeCode:async()=>{
      calls+=1;
      return {openid};
    }};
    const api=createMiniApi({db:f.db,runMode:'showcase',env:enabledEnv,
      adapter:counted});
    for(let i=0;i<30;i++){
      const result=await invoke(api,'/api/mini/auth/wechat',{
        method:'POST',payload:{code:'miniRateCode'+String(i).padStart(3,'0')},
        source:'192.0.2.10'
      });
      assert.equal(result.status,200);
    }
    assert.equal(calls,30);
    await assert.rejects(invoke(api,'/api/mini/auth/wechat',{
      method:'POST',payload:{code:'miniRateCodeBlocked'},
      source:'192.0.2.10'
    }),error=>error?.code==='RATE_LIMITED'&&error?.status===429
      &&error.retryAfter>0);
    assert.equal(calls,30,'blocked source must not reach code2Session');
    const other=await invoke(api,'/api/mini/auth/wechat',{
      method:'POST',payload:{code:'miniRateCodeOtherSource'},
      source:'192.0.2.11'
    });
    assert.equal(other.status,200);
    assert.equal(calls,31);
    const buckets=f.db.prepare(`SELECT key_hash,failed_count FROM auth_attempt_buckets
      WHERE dimension='SOURCE' AND failed_count>=1`).all();
    assert.equal(buckets.length,2);
    assert.equal(buckets.some(row=>row.failed_count===30),true);
    assert.equal(buckets.some(row=>row.key_hash.includes('192.0.2.')),false);
  }finally{f.close();}
});
