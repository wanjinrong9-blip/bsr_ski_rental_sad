import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {
  candidateLogin,candidateLogout,candidateSessionUser,candidateProvisionAccount,
  candidateChangePassword,candidateSetAccountState
} from '../src/identity.mjs';
import {candidateRequest} from './candidate-fixtures.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';
import {readySyntheticSource} from './018-showcase-ready-fixture.mjs';

const root=resolve(import.meta.dirname,'..');
const req=(cookie='')=>({headers:{cookie},socket:{remoteAddress:'127.0.0.1'}});
const cookie=login=>login.cookie.split(';')[0];
const initialAdmin=db=>db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
const accounts=[
  {name:'虚构顾客甲',email:'guest-a@example.test',role:'customer',temporaryPassword:'Guest#Private2026A',verificationRef:'FICTIONAL-CHECK-CUSTOMER'},
  {name:'虚构租赁专员',email:'staff-a@example.test',role:'staff',storeId:1,temporaryPassword:'Staff#Private2026A',verificationRef:'FICTIONAL-CHECK-STAFF'},
  {name:'虚构运营经理',email:'manager-a@example.test',role:'manager',storeId:1,temporaryPassword:'Manager#Private2026A',verificationRef:'FICTIONAL-CHECK-MANAGER'},
  {name:'虚构检修技师',email:'tech-a@example.test',role:'contractor',storeId:1,temporaryPassword:'Tech#Private2026A',verificationRef:'FICTIONAL-CHECK-TECH'},
  {name:'虚构经营负责人',email:'owner-a@example.test',role:'owner',temporaryPassword:'Owner#Private2026A',verificationRef:'FICTIONAL-CHECK-OWNER'}
];

test('SHOWCASE 管理员开通五类独立账号，岗位档案和首班次属于虚构数据',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    readySyntheticSource(fixture.dbPath);
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const admin=initialAdmin(db),ids=[];
      for(const input of accounts){
        const created=candidateProvisionAccount(db,admin,input,{runMode:'showcase'});
        ids.push(created.id);
        assert.equal(created.role,input.role);
        assert.equal(created.mustChangePassword,true);
        const row=db.prepare('SELECT role,email,must_change_password FROM users WHERE id=?').get(created.id);
        assert.equal(row.role,input.role);
        assert.equal(row.email,input.email);
        assert.equal(row.must_change_password,1);
      }
      assert.equal(new Set(ids).size,5);
      assert.deepEqual(db.prepare('SELECT DISTINCT role FROM users ORDER BY role').all().map(row=>row.role),
        ['admin','contractor','customer','manager','owner','staff']);
      for(const role of ['staff','manager','contractor','owner']){
        const employee=db.prepare('SELECT u.id FROM users u WHERE u.role=?').get(role);
        const profile=db.prepare('SELECT * FROM employee_profiles WHERE user_id=?').get(employee.id);
        assert.ok(profile?.employee_no&&profile?.job_title,`${role} 缺少虚构员工档案`);
        assert.match(profile.qualification,/演示|虚构|合成/);
      }
      for(const role of ['staff','manager','contractor']){
        const employee=db.prepare('SELECT u.id FROM users u WHERE u.role=?').get(role);
        assert.ok(db.prepare('SELECT 1 FROM shifts WHERE user_id=? LIMIT 1').get(employee.id),
          `${role} 缺少初始排班`);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@bsr.demo'").get().n,0);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});

test('SHOWCASE 首次改密、停用与退出立即撤销各自的管理会话',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    readySyntheticSource(fixture.dbPath);
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const admin=initialAdmin(db),input=accounts[0];
      const customer=candidateProvisionAccount(db,admin,input,{runMode:'showcase'});
      const first=candidateLogin(db,req(),{email:input.email,password:input.temporaryPassword},{runMode:'showcase'});
      const firstReq=req(cookie(first));
      assert.match(first.cookie,/^__Host-bsr_showcase_session=/);
      assert.equal(candidateSessionUser(db,firstReq,{runMode:'showcase'})?.must_change_password,1);
      const changed=candidateChangePassword(db,candidateSessionUser(db,firstReq,{runMode:'showcase'}),
        {currentPassword:input.temporaryPassword,newPassword:'Guest#Rotated2026B'},{runMode:'showcase'});
      assert.equal(changed.ok,true);
      assert.equal(candidateSessionUser(db,firstReq,{runMode:'showcase'}),null);
      assert.throws(()=>candidateLogin(db,req(),{email:input.email,password:input.temporaryPassword},
        {runMode:'showcase'}),error=>error?.status===401);
      const second=candidateLogin(db,req(),{email:input.email,password:'Guest#Rotated2026B'},
        {runMode:'showcase'});
      const secondReq=req(cookie(second));
      assert.equal(candidateSessionUser(db,secondReq,{runMode:'showcase'})?.id,customer.id);
      const disabled=candidateSetAccountState(db,admin,customer.id,{state:'DISABLED'},
        {runMode:'showcase'});
      assert.equal(disabled.accountState,'DISABLED');
      assert.equal(candidateSessionUser(db,secondReq,{runMode:'showcase'}),null);
      assert.throws(()=>candidateLogin(db,req(),{email:input.email,password:'Guest#Rotated2026B'},
        {runMode:'showcase'}),error=>error?.status===401);
      const adminLogin=candidateLogin(db,req(),
        {email:'synthetic-admin@example.test',password:'Private#Synthetic2026'},
        {runMode:'showcase'});
      const adminReq=req(cookie(adminLogin));
      assert.equal(candidateSessionUser(db,adminReq,{runMode:'showcase'})?.id,admin.id);
      assert.match(candidateLogout(db,adminReq,{runMode:'showcase'}).cookie,/Max-Age=0/);
      assert.equal(candidateSessionUser(db,adminReq,{runMode:'showcase'}),null);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});

test('SHOWCASE 拒绝课程演示账号、已知口令和非管理员开通员工',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    readySyntheticSource(fixture.dbPath);
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const admin=initialAdmin(db);
      assert.throws(()=>candidateProvisionAccount(db,admin,
        {...accounts[0],email:'visitor@bsr.demo'},{runMode:'showcase'}),
        error=>error?.status===400);
      assert.throws(()=>candidateProvisionAccount(db,admin,
        {...accounts[0],temporaryPassword:'Demo123!'},{runMode:'showcase'}),
        error=>error?.code==='WEAK_CREDENTIAL');
      assert.throws(()=>candidateLogin(db,req(),
        {email:'customer@bsr.demo',password:'Demo123!'},{runMode:'showcase'}),
        error=>error?.status===401);
      assert.throws(()=>candidateLogin(db,req(),
        {email:'synthetic-admin@example.test',password:'Demo123!'},{runMode:'showcase'}),
        error=>error?.status===401);
      const customer=candidateProvisionAccount(db,admin,accounts[0],{runMode:'showcase'});
      const actor=db.prepare('SELECT * FROM users WHERE id=?').get(customer.id);
      assert.throws(()=>candidateProvisionAccount(db,actor,accounts[1],{runMode:'showcase'}),
        error=>error?.status===403);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@bsr.demo'").get().n,0);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});

test('SHOWCASE HTTP 顾客自助注册拒绝且不创建账号',async()=>{
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
    const response=await candidateRequest(fixture,'/api/auth/register',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{name:'未授权访客',email:'visitor@example.test',password:'Visitor#Private2026'}
    });
    assert.equal(response.status,403,JSON.stringify(response.data));
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);}
    finally{db.close();}
  }finally{
    if(child&&child.exitCode===null){const closed=new Promise(done=>child.once('close',done));child.kill();await closed;}
    fixture.cleanup();
  }
});
