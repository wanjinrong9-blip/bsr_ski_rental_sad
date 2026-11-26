import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {createReservation} from '../src/domain.mjs';
import {candidateChangePassword,candidateProvisionAccount} from '../src/identity.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {consent} from './damage-helpers.mjs';
import {futureDate} from './future-date.mjs';

const root=resolve(import.meta.dirname,'..');
const admin={operator:'018-access-test',name:'虚构权限管理员',
  email:'access-admin@example.test',password:'Private#AccessAdmin2026'};
const identities=[
  {key:'customerA',role:'customer',name:'虚构顾客甲',email:'access-customer-a@example.test'},
  {key:'customerB',role:'customer',name:'虚构顾客乙',email:'access-customer-b@example.test'},
  {key:'staffA',role:'staff',name:'虚构北店店员',email:'access-staff-a@example.test',storeId:1},
  {key:'staffB',role:'staff',name:'虚构南店店员',email:'access-staff-b@example.test',storeId:2},
  {key:'manager',role:'manager',name:'虚构北店经理',email:'access-manager@example.test',storeId:1},
  {key:'contractor',role:'contractor',name:'虚构检修技师',email:'access-tech@example.test',storeId:1},
  {key:'owner',role:'owner',name:'虚构经营负责人',email:'access-owner@example.test'}
];
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const firstCookie=response=>{
  const value=response.headers['set-cookie'];
  return (Array.isArray(value)?value[0]:value||'').split(';')[0];
};

async function withDirectShowcase(run){
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    initializeShowcase(config,admin);
    const ids={},passwords={};
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const administrator=db.prepare("SELECT * FROM users WHERE role='admin'").get();
      ids.admin=administrator.id;
      for(const [index,identity] of identities.entries()){
        const temporaryPassword=`Private#AccessTemp${index+1}A`;
        const password=`Private#AccessReady${index+1}B`;
        const created=candidateProvisionAccount(db,administrator,{
          ...identity,temporaryPassword,verificationRef:`FICTIONAL-ACCESS-${index+1}`
        },{runMode:'showcase'});
        ids[identity.key]=created.id;passwords[identity.key]=password;
        const account=db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
        candidateChangePassword(db,account,{currentPassword:temporaryPassword,newPassword:password},
          {runMode:'showcase'});
      }
      const customerProfile={phone:'000-000-000',address:'虚构测试地址',birthYear:1998,
        heightCm:173,weightKg:69,shoeSize:'EU 42'};
      const input=(storeId,variantId)=>({storeId,pickupAt:futureDate(22),returnAt:futureDate(23),
        customerSkill:'中级',items:[{variantId,qty:1}],damageConsent:consent,
        customerProfile});
      ids.orderA=createReservation(db,ids.customerA,input(1,1),null,randomUUID()).id;
      ids.orderB=createReservation(db,ids.customerB,input(2,1),null,randomUUID()).id;
    }finally{db.close();}
    child=spawn(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
    child.stderr.on('data',part=>{stderr+=part;});
    let ready=false;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)break;
      try{if((await candidateRequest(fixture,'/api/health')).status===200){ready=true;break;}}catch{}
      await pause(40);
    }
    assert.equal(ready,true,stderr);
    const sessions={};
    for(const identity of [{key:'admin',email:admin.email},...identities]){
      const password=identity.key==='admin'?admin.password:passwords[identity.key];
      const login=await candidateRequest(fixture,'/api/auth/login',{
        method:'POST',headers:{Origin:fixture.origin},body:{email:identity.email,password}
      });
      assert.equal(login.status,200,`${identity.key}: ${JSON.stringify(login.data)}`);
      sessions[identity.key]=firstCookie(login);
    }
    const request=(path,identity='customerA',options={})=>candidateRequest(fixture,path,{
      method:options.method||'GET',body:options.body,
      headers:{Cookie:sessions[identity],...(options.method&&options.method!=='GET'?{
        Origin:options.origin??fixture.origin}:{}),...options.headers}
    });
    return await run({fixture,ids,sessions,request});
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
}

test('SHOWCASE 六角色只读自己或本店订单，经营与权限岗位不得取得逐单',async()=>{
  await withDirectShowcase(async({fixture,ids,request})=>{
    const own=await request(`/api/reservations/${ids.orderA}`,'customerA');
    assert.equal(own.status,200,JSON.stringify(own.data));
    assert.equal(own.data.user_id,ids.customerA);
    for(const identity of ['customerB','staffB']){
      const hidden=await request(`/api/reservations/${ids.orderA}`,identity);
      assert.equal(hidden.status,404,`${identity} 不得读取北店顾客甲订单`);
      const nonexistent=await request('/api/reservations/999999',identity);
      assert.equal(hidden.data.error,nonexistent.data.error,'越权与不存在对象返回一致');
    }
    for(const identity of ['staffA','manager']){
      assert.equal((await request(`/api/reservations/${ids.orderA}`,identity)).status,200);
      assert.equal((await request(`/api/reservations/${ids.orderB}`,identity)).status,404);
    }
    for(const identity of ['contractor','owner','admin']){
      assert.equal((await request(`/api/reservations/${ids.orderA}`,identity)).status,403,
        `${identity} 不能读取逐单顾客资料`);
    }
    const guest=await candidateRequest(fixture,`/api/reservations/${ids.orderA}`);
    assert.equal(guest.status,401);
    assert.deepEqual((await request('/api/reservations','customerA')).data.map(row=>row.id),
      [ids.orderA]);
    assert.deepEqual((await request('/api/reservations','staffA')).data.map(row=>row.id),
      [ids.orderA]);
    assert.equal((await request('/api/users','manager')).status,403);
    assert.equal((await request('/api/users','admin')).status,200);
    assert.equal((await request('/api/reports','owner')).status,200);
  });
});

test('SHOWCASE 错误 Origin 不开通账号；停用后旧 Cookie 不再访问任何业务对象',async()=>{
  await withDirectShowcase(async({fixture,ids,sessions,request})=>{
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    let before;
    try{before=db.prepare('SELECT COUNT(*) AS n FROM users').get().n;}
    finally{db.close();}
    const rejected=await request('/api/users','admin',{method:'POST',
      origin:'https://other.example.test',body:{name:'不应创建',email:'blocked@example.test',
        role:'customer',temporaryPassword:'Private#Blocked2026',verificationRef:'FICTIONAL-REJECTED'}});
    assert.equal(rejected.status,403);
    const afterDb=openDb(fixture.dbPath,{runMode:'showcase'});
    try{assert.equal(afterDb.prepare('SELECT COUNT(*) AS n FROM users').get().n,before);}
    finally{afterDb.close();}
    const disabled=await request(`/api/users/${ids.staffA}/state`,'admin',{
      method:'PATCH',body:{state:'DISABLED'}
    });
    assert.equal(disabled.status,200,JSON.stringify(disabled.data));
    assert.equal((await request('/api/me','staffA')).status,401);
    const stale=await candidateRequest(fixture,`/api/reservations/${ids.orderA}`,{
      headers:{Cookie:sessions.staffA}
    });
    assert.equal(stale.status,401,'停用账号的旧 Cookie 不得读取旧业务对象');
    const finalDb=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      assert.equal(finalDb.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,2);
      assert.equal(finalDb.prepare('SELECT account_state FROM users WHERE id=?').get(ids.staffA).account_state,
        'DISABLED');
    }finally{finalDb.close();}
  });
});

test('SHOWCASE 可信本机代理拒绝伪造 Host、来源、协议或密钥，业务行不变',async()=>{
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    const secret=randomBytes(32).toString('hex');
    const externalHost='showcase.example.test';
    const env={...fixture.env,BSR_CANDIDATE_TRANSPORT:'trusted-local-proxy',
      BSR_PUBLIC_ORIGIN:`https://${externalHost}`,BSR_PROXY_SECRET:secret};
    delete env.BSR_TLS_CERT_PATH;delete env.BSR_TLS_KEY_PATH;
    const config=validateRuntimeConfig(env,{root,publicDir:join(root,'public')});
    initializeShowcase(config,admin);
    child=spawn(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    const base={'Host':externalHost,'X-BSR-Proxy-Secret':secret,
      'X-BSR-Client-IP':'198.51.100.42','X-Forwarded-Proto':'https'};
    const send=(path,headers={})=>new Promise((done,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:fixture.port,path,headers:{...base,...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          const raw=Buffer.concat(chunks).toString('utf8');
          let data;try{data=JSON.parse(raw);}catch{data=raw;}
          done({status:res.statusCode,data});
        });
      });
      req.on('error',reject);req.end();
    });
    let ready=false;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)break;
      try{if((await send('/api/health')).status===200){ready=true;break;}}catch{}
      await pause(40);
    }
    assert.equal(ready,true);
    const miniOff=await send('/api/mini/bootstrap');
    assert.equal(miniOff.status,200);
    assert.equal(miniOff.data.status,'off');
    for(const changed of [
      {Host:'foreign.example.test'},
      {'X-BSR-Proxy-Secret':'wrong'},
      {'X-Forwarded-Proto':'http'},
      {'X-BSR-Client-IP':'198.51.100.42,203.0.113.9'}
    ]){
      const refused=await send('/api/health',changed);
      assert.equal(refused.status,403,JSON.stringify(changed));
      assert.equal((await send('/api/mini/bootstrap',changed)).status,403,
        '小程序专属路由也必须先经过可信代理边界');
    }
    assert.equal((await send('/app.js',{Host:'foreign.example.test'})).status,403);
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
    }finally{db.close();}
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
});
