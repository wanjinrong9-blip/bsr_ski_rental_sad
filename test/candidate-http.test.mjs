import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {makeCandidateFixture,candidateRequest} from './candidate-fixtures.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeCandidate} from '../src/runtime-provenance.mjs';

const root=resolve(import.meta.dirname,'..');
const publicDir=join(root,'public');
const serverPath=join(root,'src','server.mjs');

async function startCandidate(fixture){
  const child=spawn(process.execPath,[serverPath],{
    cwd:root,env:{...process.env,...fixture.env,NODE_ENV:'local'},
    stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  let stderr='';child.stdout.resume();child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr+=part;});
  for(let i=0;i<120;i++){
    if(child.exitCode!==null)break;
    try{
      const health=await candidateRequest(fixture,'/api/health');
      if(health.status===200)return {child,health};
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  child.kill();
  throw new Error('候选服务未能通过本机 HTTPS 启动：'+stderr);
}
async function closeChild(child){
  if(!child)return;
  if(child.exitCode===null){
    const closed=new Promise(resolve=>child.once('close',resolve));
    child.kill();
    await closed;
  }
}
const cookieOf=response=>{
  const set=response.headers['set-cookie'];
  return (Array.isArray(set)?set[0]:set||'').split(';')[0];
};

test('candidate HTTPS routes isolate demo data and enforce managed identity',async()=>{
  const fixture=await makeCandidateFixture('bsr-candidate-http-');
  let child;
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir});
    initializeCandidate(config,{operator:'course-test',name:'Test Administrator',
      email:'admin@example.test',password:'StrongAdmin#2026A'});
    const started=await startCandidate(fixture);child=started.child;
    assert.equal(started.health.data.runMode,'candidate');
    const boot=await candidateRequest(fixture,'/api/bootstrap');
    assert.equal(boot.status,200);
    assert.equal(boot.data.demo,false);
    assert.equal(boot.data.runMode,'candidate');
    assert.deepEqual(boot.data.stores,[]);
    assert.equal(boot.data.capabilities.selfRegistration,false);
    assert.equal(boot.data.capabilities.bookingEnabled,false);
    assert.equal(boot.data.demoLogin,undefined);
    assert.equal((await candidateRequest(fixture,'/api/events')).status,401);

    const noOrigin=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',body:{email:'admin@example.test',password:'StrongAdmin#2026A'}});
    assert.equal(noOrigin.status,403);
    const wrong=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'admin@example.test',password:'wrong-password'}});
    assert.equal(wrong.status,401);
    assert.equal(wrong.data.code,'INVALID_CREDENTIALS');
    const login=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'admin@example.test',password:'StrongAdmin#2026A'}});
    assert.equal(login.status,200);
    assert.equal(login.data.user.role,'admin');
    assert.equal(login.data.sessionToken,undefined);
    assert.match(login.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Strict; Path=\//);
    const adminCookie=cookieOf(login);
    const me=await candidateRequest(fixture,'/api/me',{headers:{Cookie:adminCookie}});
    assert.equal(me.status,200);
    assert.equal(me.data.email,'admin@example.test');

    const register=await candidateRequest(fixture,'/api/auth/register',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{name:'Unverified',email:'unverified@example.test',password:'Strong#2026Ab'}});
    assert.equal(register.status,403);
    assert.equal(register.data.code,'SELF_REGISTRATION_DISABLED');
    const quote=await candidateRequest(fixture,'/api/quote',{
      method:'POST',headers:{Origin:fixture.origin},body:{storeId:1,items:[]}});
    assert.equal(quote.status,409);
    const policy=await candidateRequest(fixture,'/api/damage-policy');
    assert.equal(policy.status,409);
    const bundle=await candidateRequest(fixture,'/app.js');
    assert.equal(bundle.status,200);
    assert.equal(bundle.text.includes('Demo123!'),false);
    assert.equal(bundle.text.includes('customer@bsr.demo'),false);

    const provision=await candidateRequest(fixture,'/api/users',{
      method:'POST',headers:{Origin:fixture.origin,Cookie:adminCookie},
      body:{name:'Candidate Customer',email:'customer@example.test',role:'customer',
        temporaryPassword:'TempCustomer#2026A',verificationRef:'OFFLINE-CHECK-001'}});
    assert.equal(provision.status,201,JSON.stringify(provision.data));
    const first=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'customer@example.test',password:'TempCustomer#2026A'}});
    assert.equal(first.status,200);
    assert.equal(first.data.user.mustChangePassword,true);
    const tempCookie=cookieOf(first);
    assert.equal((await candidateRequest(fixture,'/api/events',{headers:{Cookie:tempCookie}})).status,401);
    assert.equal((await candidateRequest(fixture,'/api/me',{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:tempCookie},body:{phone:'12345678'}})).status,403);
    const blocked=await candidateRequest(fixture,'/api/reservations',{headers:{Cookie:tempCookie}});
    assert.equal(blocked.status,403);
    const changed=await candidateRequest(fixture,'/api/auth/change-password',{
      method:'POST',headers:{Origin:fixture.origin,Cookie:tempCookie},
      body:{currentPassword:'TempCustomer#2026A',newPassword:'NewCustomer#2026A'}});
    assert.equal(changed.status,200);
    const old=await candidateRequest(fixture,'/api/me',{headers:{Cookie:tempCookie}});
    assert.equal(old.status,401);
    const again=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'customer@example.test',password:'NewCustomer#2026A'}});
    assert.equal(again.status,200);
    assert.equal(again.data.user.mustChangePassword,false);
    const parallel=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'customer@example.test',password:'NewCustomer#2026A'}});
    assert.equal(parallel.status,200);
    const unverifiedPromotion=await candidateRequest(fixture,`/api/users/${provision.data.id}/role`,{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:adminCookie},body:{role:'owner'}});
    assert.equal(unverifiedPromotion.status,400);
    assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:cookieOf(parallel)}})).status,200);
    const changedRole=await candidateRequest(fixture,`/api/users/${provision.data.id}/role`,{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:adminCookie},
      body:{role:'owner',verificationRef:'OFFLINE-ROLE-001'}});
    assert.equal(changedRole.status,200);
    assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:cookieOf(again)}})).status,401);
    assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:cookieOf(parallel)}})).status,401);
    const accounts=await candidateRequest(fixture,'/api/users',{headers:{Cookie:adminCookie}});
    assert.equal(accounts.status,200);
    assert.equal(accounts.data.find(row=>row.email==='customer@example.test').account_state,'ACTIVE');
    assert.equal(accounts.data.find(row=>row.email==='customer@example.test').must_change_password,0);
    assert.equal((await candidateRequest(fixture,'/api/operations/return',{
      method:'POST',headers:{Origin:fixture.origin,Cookie:adminCookie},body:{reservationId:1}})).status,409);
    const reset=await candidateRequest(fixture,`/api/users/${provision.data.id}/reset-password`,{
      method:'POST',headers:{Origin:fixture.origin,Cookie:adminCookie},
      body:{temporaryPassword:'ResetCustomer#2026A',verificationRef:'OFFLINE-RESET-001'}});
    assert.equal(reset.status,200);
    assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:cookieOf(again)}})).status,401);
    const resetLogin=await candidateRequest(fixture,'/api/auth/login',{
      method:'POST',headers:{Origin:fixture.origin},
      body:{email:'customer@example.test',password:'ResetCustomer#2026A'}});
    assert.equal(resetLogin.status,200);
    assert.equal(resetLogin.data.user.mustChangePassword,true);
    const disabled=await candidateRequest(fixture,`/api/users/${provision.data.id}/state`,{
      method:'PATCH',headers:{Origin:fixture.origin,Cookie:adminCookie},body:{state:'DISABLED'}});
    assert.equal(disabled.status,200);
    assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:cookieOf(resetLogin)}})).status,401);
    const audit=await candidateRequest(fixture,'/api/audit',{headers:{Cookie:adminCookie}});
    assert.equal(audit.status,200);
    assert.ok(audit.data.some(row=>row.action==='CREDENTIAL_RESET'));
    assert.ok(audit.data.some(row=>row.action==='ACCOUNT_DISABLED'));
    assert.ok(audit.data.some(row=>row.action==='UNTRUSTED_ORIGIN'));
    assert.ok(audit.data.some(row=>row.action==='AUTH_FAILED'));
    const logout=await candidateRequest(fixture,'/api/auth/logout',{
      method:'POST',headers:{Origin:fixture.origin,Cookie:adminCookie}});
    assert.equal(logout.status,200);
    assert.equal((await candidateRequest(fixture,'/api/me',{headers:{Cookie:adminCookie}})).status,401);
  }finally{await closeChild(child);fixture.cleanup();}
});
