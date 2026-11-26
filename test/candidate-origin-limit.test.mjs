import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateLogin,requireCandidateOrigin} from '../src/identity.mjs';
import {identityFixture,fakeRequest} from './candidate-identity-fixture.mjs';

const allowed='https://127.0.0.1:4174';
test('candidate writes need exact secure Origin',()=>{
  assert.doesNotThrow(()=>requireCandidateOrigin(fakeRequest('',allowed),allowed));
  for(const origin of ['', 'http://127.0.0.1:4174','https://127.0.0.1:4175','https://evil.example']){
    assert.throws(()=>requireCandidateOrigin(fakeRequest('',origin),allowed),e=>e.status===403&&e.code==='UNTRUSTED_ORIGIN');
  }
});

test('five failures in ten minutes pause the next attempt for fifteen minutes',()=>{
  const db=identityFixture(),req=fakeRequest('',allowed,'127.0.0.9');
  const at=Date.parse('2026-11-16T08:00:00Z');
  try{
    for(let i=0;i<5;i++)assert.throws(()=>candidateLogin(db,req,{email:'admin@example.test',password:'Wrong123!Pass'},{now:at+i*1000}),e=>e.status===401&&e.message==='账号或密码错误');
    assert.throws(()=>candidateLogin(db,req,{email:'admin@example.test',password:'StrongAdmin123!'},{now:at+6000}),e=>e.status===429&&e.code==='AUTH_RATE_LIMITED'&&e.retryAfter>0);
    const recovered=candidateLogin(db,req,{email:'admin@example.test',password:'StrongAdmin123!'},{now:at+16*60000});
    assert.equal(recovered.user.id,1);
  }finally{db.close();}
});

test('unknown and known accounts use same public error text',()=>{
  const db=identityFixture();
  try{
    let known,unknown;
    try{candidateLogin(db,fakeRequest('','','127.0.0.10'),{email:'admin@example.test',password:'wrong'});}catch(e){known=e;}
    try{candidateLogin(db,fakeRequest('','','127.0.0.11'),{email:'missing@example.test',password:'wrong'});}catch(e){unknown=e;}
    assert.equal(known.status,401);assert.equal(unknown.status,401);
    assert.equal(known.message,unknown.message);
  }finally{db.close();}
});

test('account lock applies across different request sources without revealing account existence',()=>{
  const db=identityFixture(),at=Date.parse('2026-11-16T09:00:00Z');
  try{
    for(let i=0;i<5;i++)assert.throws(()=>candidateLogin(db,fakeRequest('','',`127.0.0.${20+i}`),
      {email:'staff@example.test',password:'WrongAcrossSources#2026'},{now:at+i*1000}),
      error=>error.status===401);
    assert.throws(()=>candidateLogin(db,fakeRequest('','','127.0.0.30'),
      {email:'staff@example.test',password:'StrongStaff123!'},{now:at+6000}),
      error=>error.status===429&&error.code==='AUTH_RATE_LIMITED');
    assert.equal(candidateLogin(db,fakeRequest('','','127.0.0.31'),
      {email:'staff@example.test',password:'StrongStaff123!'},{now:at+16*60000}).user.role,'staff');
  }finally{db.close();}
});
