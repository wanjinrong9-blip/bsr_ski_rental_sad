import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateCookieName,candidateLogin,candidateLogout,candidateSessionUser,
  candidateProvisionAccount,candidateChangePassword,invalidateCandidateSessions
} from '../src/identity.mjs';
import {identityFixture,fakeRequest,requestCookie} from './candidate-identity-fixture.mjs';

test('candidate session is cookie-only, expires, and is revoked on logout',()=>{
  const db=identityFixture(),at=Date.parse('2026-11-16T08:00:00Z');
  try{
    const result=candidateLogin(db,fakeRequest(),{email:'admin@example.test',password:'StrongAdmin123!'},{now:at});
    assert.equal(result.user.id,1);
    assert.equal(Object.hasOwn(result.user,'password_hash'),false);
    assert.match(result.cookie,/HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800/);
    assert.ok(result.cookie.startsWith(candidateCookieName+'='));
    assert.equal(JSON.stringify(result).includes('sessionToken'),false);
    const cookie=requestCookie(result.cookie);
    assert.equal(candidateSessionUser(db,fakeRequest(cookie),{now:at+1000})?.id,1);
    assert.equal(candidateSessionUser(db,{headers:{'x-bsr-session':cookie},socket:{}},{now:at+1000}),null);
    assert.equal(candidateSessionUser(db,fakeRequest(cookie),{now:at+8*3600000+1}),null);
    const loggedOut=candidateLogout(db,fakeRequest(cookie));
    assert.match(loggedOut.cookie,/Max-Age=0/);
    assert.equal(candidateSessionUser(db,fakeRequest(cookie),{now:at+2000}),null);
  }finally{db.close();}
});

test('authorization epoch change invalidates all old candidate sessions',()=>{
  const db=identityFixture(),at=Date.parse('2026-11-16T08:00:00Z');
  try{
    const result=candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'},{now:at});
    const cookie=requestCookie(result.cookie);
    assert.equal(candidateSessionUser(db,fakeRequest(cookie),{now:at+1})?.role,'staff');
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE users SET role='manager' WHERE id=2").run();
    invalidateCandidateSessions(db,2);
    db.exec('COMMIT');
    assert.equal(candidateSessionUser(db,fakeRequest(cookie),{now:at+2}),null);
  }finally{db.close();}
});

test('admin provisions verified customer and new account must rotate first credential',()=>{
  const db=identityFixture();
  try{
    const admin=db.prepare('SELECT * FROM users WHERE id=1').get();
    assert.throws(()=>candidateProvisionAccount(db,admin,{name:'Guest',email:'guest@example.test',role:'customer',initialPassword:'StrongGuest123!'}),e=>e.code==='VERIFICATION_REQUIRED');
    const added=candidateProvisionAccount(db,admin,{name:'Guest',email:'guest@example.test',role:'customer',verificationRef:'checked-in-person',initialPassword:'StrongGuest123!'});
    assert.equal(added.mustChangePassword,true);
    assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(added.id).must_change_password,1);
    assert.throws(()=>candidateProvisionAccount(db,db.prepare('SELECT * FROM users WHERE id=2').get(),{name:'Other',email:'other@example.test',role:'customer',verificationRef:'in-person-verified',initialPassword:'StrongOther123!'}),e=>e.status===403);
    const req=fakeRequest();
    const login=candidateLogin(db,req,{email:'guest@example.test',password:'StrongGuest123!'});
    const user=candidateSessionUser(db,fakeRequest(requestCookie(login.cookie)));
    assert.equal(user.must_change_password,1);
    const changed=candidateChangePassword(db,user,{currentPassword:'StrongGuest123!',newPassword:'NewGuest456!Pass'});
    assert.equal(changed.ok,true);
    assert.equal(candidateSessionUser(db,fakeRequest(requestCookie(login.cookie))),null);
    assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(added.id).must_change_password,0);
    assert.throws(()=>candidateLogin(db,req,{email:'guest@example.test',password:'StrongGuest123!'}),e=>e.status===401);
    assert.equal(candidateLogin(db,req,{email:'guest@example.test',password:'NewGuest456!Pass'}).user.id,added.id);
  }finally{db.close();}
});
