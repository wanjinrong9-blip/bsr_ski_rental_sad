import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateLogin,candidateSessionUser,candidateSetAccountState,candidateResetPassword} from '../src/identity.mjs';
import {identityFixture,fakeRequest,requestCookie} from './candidate-identity-fixture.mjs';

function fixture(){
  const db=identityFixture();
  db.exec('ALTER TABLE runtime_installation ADD COLUMN initial_admin_id INTEGER');
  db.prepare('UPDATE runtime_installation SET initial_admin_id=1').run();
  return db;
}
const admin=db=>db.prepare('SELECT * FROM users WHERE id=1').get();
const staff=db=>db.prepare('SELECT * FROM users WHERE id=2').get();

test('admin disable and verified re-enable revoke every earlier session',()=>{
  const db=fixture();
  try{
    const login=candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'});
    const cookie=requestCookie(login.cookie);
    assert.equal(candidateSessionUser(db,fakeRequest(cookie))?.id,2);
    const disabled=candidateSetAccountState(db,admin(db),2,{state:'DISABLED'});
    assert.deepEqual(disabled,{id:2,accountState:'DISABLED',changed:true});
    assert.equal(candidateSessionUser(db,fakeRequest(cookie)),null);
    assert.throws(()=>candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'}),
      error=>error.status===401&&error.code==='INVALID_CREDENTIALS');
    assert.throws(()=>candidateSetAccountState(db,admin(db),2,{state:'ACTIVE'}),
      error=>error.code==='VERIFICATION_REQUIRED');
    assert.equal(db.prepare('SELECT account_state FROM users WHERE id=2').get().account_state,'DISABLED');
    const enabled=candidateSetAccountState(db,admin(db),2,{state:'ACTIVE',verificationRef:'offline-check-73'});
    assert.deepEqual(enabled,{id:2,accountState:'ACTIVE',changed:true});
    assert.equal(candidateSessionUser(db,fakeRequest(cookie)),null);
    assert.equal(candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'}).user.id,2);
    const detail=db.prepare("SELECT detail_json FROM audit_log WHERE action='ACCOUNT_ENABLED'").get().detail_json;
    assert.equal(detail.includes('offline-check-73'),false);
  }finally{db.close();}
});

test('initial admin and own account cannot be disabled',()=>{
  const db=fixture();
  try{
    assert.throws(()=>candidateSetAccountState(db,admin(db),1,{state:'DISABLED'}),
      error=>error.status===403&&error.code==='SELF_ACCOUNT_CHANGE');
    const second=db.prepare(`INSERT INTO users(name,email,password_hash,role,created_at)
      SELECT 'Second Admin','second@example.test',password_hash,'admin',created_at FROM users WHERE id=1`).run();
    assert.ok(second.lastInsertRowid>2);
    const actor=db.prepare('SELECT * FROM users WHERE id=?').get(Number(second.lastInsertRowid));
    assert.throws(()=>candidateSetAccountState(db,actor,1,{state:'DISABLED'}),
      error=>error.status===409&&error.code==='INITIAL_ADMIN_REQUIRED');
    assert.equal(db.prepare('SELECT account_state FROM users WHERE id=1').get().account_state,'ACTIVE');
    assert.throws(()=>candidateSetAccountState(db,staff(db),1,{state:'DISABLED'}),
      error=>error.status===403&&error.code==='FORBIDDEN');
  }finally{db.close();}
});

test('offline-verified reset rotates temporary credential and invalidates old sessions',()=>{
  const db=fixture();
  try{
    const login=candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'});
    const cookie=requestCookie(login.cookie);
    const before=db.prepare('SELECT password_hash,auth_epoch FROM users WHERE id=2').get();
    assert.throws(()=>candidateResetPassword(db,admin(db),2,{temporaryPassword:'NewStaff456!Pass'}),
      error=>error.code==='VERIFICATION_REQUIRED');
    assert.throws(()=>candidateResetPassword(db,admin(db),2,{verificationRef:'checked-in-person',temporaryPassword:'weak'}),
      error=>error.code==='WEAK_CREDENTIAL');
    assert.deepEqual(db.prepare('SELECT password_hash,auth_epoch FROM users WHERE id=2').get(),before);
    const result=candidateResetPassword(db,admin(db),2,{
      verificationRef:'checked-in-person',temporaryPassword:'NewStaff456!Pass'});
    assert.deepEqual(result,{id:2,mustChangePassword:true});
    assert.equal(candidateSessionUser(db,fakeRequest(cookie)),null);
    assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id=2').get().must_change_password,1);
    assert.throws(()=>candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'}),
      error=>error.status===401);
    assert.equal(candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'NewStaff456!Pass'}).user.must_change_password,1);
    const detail=db.prepare("SELECT detail_json FROM audit_log WHERE action='CREDENTIAL_RESET'").get().detail_json;
    assert.equal(detail.includes('checked-in-person'),false);
    assert.equal(detail.includes('NewStaff456!Pass'),false);
    assert.throws(()=>candidateResetPassword(db,admin(db),1,{verificationRef:'checked-in-person',temporaryPassword:'AnotherAdmin456!'}),
      error=>error.status===403&&error.code==='SELF_CREDENTIAL_RESET');
    assert.throws(()=>candidateResetPassword(db,staff(db),1,{verificationRef:'checked-in-person',temporaryPassword:'AnotherAdmin456!'}),
      error=>error.status===403&&error.code==='FORBIDDEN');
  }finally{db.close();}
});
