import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateLogin,candidateProvisionAccount,validateCandidatePassword} from '../src/identity.mjs';
import {identityFixture,fakeRequest} from './candidate-identity-fixture.mjs';

test('candidate account provisioning enforces admin, store scope and strong temporary credential',()=>{
  const db=identityFixture(),admin=db.prepare('SELECT * FROM users WHERE id=1').get();
  try{
    assert.throws(()=>candidateProvisionAccount(db,admin,{name:'No Store',email:'storeless@example.test',role:'staff',temporaryPassword:'StrongTemp123!'}),e=>e.code==='INVALID_STORE');
    assert.throws(()=>candidateProvisionAccount(db,admin,{name:'Wrong Store',email:'wrong@example.test',role:'manager',storeId:99,temporaryPassword:'StrongTemp123!'}),e=>e.code==='INVALID_STORE');
    assert.throws(()=>candidateProvisionAccount(db,admin,{name:'High Role',email:'owner@example.test',role:'owner',temporaryPassword:'StrongTemp123!'}),e=>e.code==='VERIFICATION_REQUIRED');
    assert.throws(()=>candidateProvisionAccount(db,admin,{name:'Weak',email:'weak@example.test',role:'customer',verificationRef:'checked-in-person',temporaryPassword:'Demo123!'}),e=>e.code==='WEAK_CREDENTIAL');
    const staff=candidateProvisionAccount(db,admin,{name:'Second Staff',email:'second@example.test',role:'staff',storeId:2,temporaryPassword:'StrongTemp123!'});
    assert.equal(staff.storeId,2);
    assert.equal(db.prepare('SELECT store_id FROM users WHERE id=?').get(staff.id).store_id,2);
    assert.throws(()=>candidateProvisionAccount(db,admin,{name:'Again',email:'second@example.test',role:'staff',storeId:2,temporaryPassword:'AnotherTemp123!'}),e=>e.code==='ACCOUNT_EXISTS');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,3);
    assert.throws(()=>validateCandidatePassword('Demo123!'),e=>e.code==='WEAK_CREDENTIAL');
  }finally{db.close();}
});

test('candidate disabled account cannot authenticate even with correct credential',()=>{
  const db=identityFixture();
  try{
    db.prepare("UPDATE users SET account_state='DISABLED' WHERE id=2").run();
    assert.throws(()=>candidateLogin(db,fakeRequest(),{email:'staff@example.test',password:'StrongStaff123!'}),e=>e.status===401&&e.message==='账号或密码错误');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
  }finally{db.close();}
});
