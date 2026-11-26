import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase,preflightRuntime} from '../src/runtime-provenance.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {assertNoDemoRows,makeShowcaseFixture} from './018-showcase-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
const admin={operator:'018-http-test',name:'虚构权限管理员',
  email:'showcase-admin@example.test',password:'Private#Admin2026A'};
const roles=[
  {role:'customer',name:'虚构顾客甲',email:'guest-a@example.test',temporaryPassword:'Private#Customer2026A'},
  {role:'staff',name:'虚构租赁专员',email:'staff-a@example.test',storeId:1,temporaryPassword:'Private#Staff2026A'},
  {role:'manager',name:'虚构门店经理',email:'manager-a@example.test',storeId:1,temporaryPassword:'Private#Manager2026A'},
  {role:'contractor',name:'虚构检修技师',email:'tech-a@example.test',storeId:1,temporaryPassword:'Private#Tech2026A'},
  {role:'owner',name:'虚构经营负责人',email:'owner-a@example.test',temporaryPassword:'Private#Owner2026A'}
];
const firstCookie=response=>{
  const value=response.headers['set-cookie'];
  return (Array.isArray(value)?value[0]:value||'').split(';')[0];
};
const writeHeaders=(fixture,cookie='')=>({Origin:fixture.origin,...(cookie?{Cookie:cookie}:{})});
async function login(fixture,email,password){
  return candidateRequest(fixture,'/api/auth/login',{
    method:'POST',headers:writeHeaders(fixture),body:{email,password}
  });
}

test('SHOWCASE 全新来源经受控 HTTP 入口开通六类账号并完成首次改密',async()=>{
  const fixture=await makeShowcaseFixture();
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    const initialized=initializeShowcase(config,admin);
    assert.equal(preflightRuntime(config,{requireReady:true}).instanceId,initialized.instanceId);
    child=spawn(process.execPath,[join(root,'src','server.mjs')],{
      cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true
    });
    let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');
    child.stderr.on('data',part=>{stderr+=part;});
    let ready=false;
    for(let attempt=0;attempt<120;attempt++){
      if(child.exitCode!==null)break;
      try{if((await candidateRequest(fixture,'/api/health')).status===200){ready=true;break;}}catch{}
      await new Promise(done=>setTimeout(done,40));
    }
    assert.equal(ready,true,stderr);
    const guestCatalog=await candidateRequest(fixture,'/api/catalog?storeId=1');
    assert.equal(guestCatalog.status,401,'虚构目录仅供登录后查看');
    const initialBoot=await candidateRequest(fixture,'/api/bootstrap');
    assert.equal(initialBoot.status,200);
    assert.equal(initialBoot.data.runMode,'showcase');
    assert.equal(initialBoot.data.synthetic,true);
    assert.equal(initialBoot.data.capabilities.bookingEnabled,true);
    assert.equal('demoLogin' in initialBoot.data,false);

    const adminLogin=await login(fixture,admin.email,admin.password);
    assert.equal(adminLogin.status,200,JSON.stringify(adminLogin.data));
    const adminCookie=firstCookie(adminLogin);
    assert.match(adminCookie,/^__Host-bsr_showcase_session=/);
    assert.equal(adminLogin.data.user.role,'admin');
    assert.equal(adminLogin.data.user.mustChangePassword,false);
    for(const [index,input] of roles.entries()){
      const created=await candidateRequest(fixture,'/api/users',{
        method:'POST',headers:writeHeaders(fixture,adminCookie),
        body:{...input,verificationRef:`FICTIONAL-ROLE-${index+1}`}
      });
      assert.equal(created.status,201,`${input.role}: ${JSON.stringify(created.data)}`);
      assert.equal(created.data.role,input.role);
      assert.equal(created.data.mustChangePassword,true);
    }
    const users=await candidateRequest(fixture,'/api/users',{headers:{Cookie:adminCookie}});
    assert.equal(users.status,200);
    assert.deepEqual(users.data.map(row=>row.role).sort(),
      ['admin','customer','staff','manager','contractor','owner'].sort());
    const customerId=users.data.find(row=>row.role==='customer').id;
    const roleSwap=await candidateRequest(fixture,`/api/users/${customerId}/role`,{
      method:'PATCH',headers:writeHeaders(fixture,adminCookie),
      body:{role:'staff',storeId:1}
    });
    assert.equal(roleSwap.status,409,'身份未重新核验时不能把顾客改为门店员工');
    const audit=await candidateRequest(fixture,'/api/audit',{headers:{Cookie:adminCookie}});
    assert.equal(audit.status,200);
    assert.ok(audit.data.some(row=>row.action==='SHOWCASE_INITIALIZED'));
    assert.equal(audit.data.filter(row=>row.action==='ACCOUNT_PROVISIONED').length,5);

    for(const [index,input] of roles.entries()){
      const first=await login(fixture,input.email,input.temporaryPassword);
      assert.equal(first.status,200,`${input.role}: ${JSON.stringify(first.data)}`);
      assert.equal(first.data.user.role,input.role);
      assert.equal(first.data.user.mustChangePassword,true);
      const temporaryCookie=firstCookie(first);
      assert.match(temporaryCookie,/^__Host-bsr_showcase_session=/);
      const beforeChange=await candidateRequest(fixture,'/api/catalog?storeId=1',{
        headers:{Cookie:temporaryCookie}
      });
      assert.equal(beforeChange.status,403,`${input.role} 必须先改密`);
      const newPassword=`Private#Rotated2026${index+1}B`;
      const changed=await candidateRequest(fixture,'/api/auth/change-password',{
        method:'POST',headers:writeHeaders(fixture,temporaryCookie),
        body:{currentPassword:input.temporaryPassword,newPassword}
      });
      assert.equal(changed.status,200,`${input.role}: ${JSON.stringify(changed.data)}`);
      const oldSession=await candidateRequest(fixture,'/api/me',{headers:{Cookie:temporaryCookie}});
      assert.equal(oldSession.status,401,`${input.role} 改密后旧会话失效`);
      if(index===0)assert.equal((await login(fixture,input.email,input.temporaryPassword)).status,401);
      const current=await login(fixture,input.email,newPassword);
      assert.equal(current.status,200,`${input.role}: ${JSON.stringify(current.data)}`);
      const currentCookie=firstCookie(current);
      const catalog=await candidateRequest(fixture,'/api/catalog?storeId=1',{
        headers:{Cookie:currentCookie}
      });
      assert.equal(catalog.status,200,`${input.role}: ${JSON.stringify(catalog.data)}`);
      assert.ok(catalog.data.items.length>=10);
      assert.ok(catalog.data.items.some(item=>item.subtype==='护目镜'));
      assert.ok(catalog.data.items.some(item=>item.subtype==='护膝'));
      const forbidden=await candidateRequest(fixture,'/api/users',{headers:{Cookie:currentCookie}});
      assert.equal(forbidden.status,403,`${input.role} 不得查看账号列表`);
      const loggedOut=await candidateRequest(fixture,'/api/auth/logout',{
        method:'POST',headers:writeHeaders(fixture,currentCookie)
      });
      assert.equal(loggedOut.status,200);
      assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:currentCookie}})).status,401);
    }
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      assertNoDemoRows(db);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,6);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_profiles').get().n,5);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n,3);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{db.close();}
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
});
