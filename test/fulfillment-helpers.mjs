import assert from 'node:assert/strict';
export async function signBeforePay(request,id,customer){
 const detail=await request(`/api/reservations/${id}`,'GET',undefined,customer);assert.equal(detail.status,200);
 let contract=detail.data.contracts?.[0];
 if(!contract){const issued=await request(`/api/reservations/${id}/contracts`,'POST',{},customer);assert.equal(issued.status,201,JSON.stringify(issued.data));contract=issued.data;}
 if(!contract.signed_at){const signed=await request(`/api/contracts/${contract.id}/sign`,'POST',{accepted:true,snapshotHash:contract.snapshot_hash,name:'自动化测试顾客'},customer);assert.equal(signed.status,200,JSON.stringify(signed.data));}
 return contract;
}
export async function prepareAndSign(request,id,staff,customer){
 const detail=await request(`/api/reservations/${id}`,'GET',undefined,staff);assert.equal(detail.status,200);if(!detail.data.requires_fulfillment)return;
 const staffUser=(await request('/api/me','GET',undefined,staff)).data;
 const login=await request('/api/auth/login','POST',{email:'manager@bsr.demo',password:'Demo123!'}),manager=login.cookie||login.data.sessionToken;
 let p=(await request(`/api/preparations/${id}`,'GET',undefined,staff)).data;
 let r=await request(`/api/preparations/${id}`,'PATCH',{version:p.version,action:'claim',assignedTo:staffUser.id},manager);assert.equal(r.status,200,JSON.stringify(r.data));p=r.data;
 r=await request(`/api/preparations/${id}`,'PATCH',{version:p.version,action:'pick'},staff);assert.equal(r.status,200,JSON.stringify(r.data));p=r.data;
 r=await request(`/api/preparations/${id}`,'PATCH',{version:p.version,action:'check',units:p.units.map(u=>({unitId:u.unit_id,size:true,clean:true,safety:true}))},staff);assert.equal(r.status,200);p=r.data;
 r=await request(`/api/preparations/${id}`,'PATCH',{version:p.version,action:'ready'},staff);assert.equal(r.status,200,JSON.stringify(r.data));
 let c=detail.data.contracts?.[0];if(!c){r=await request(`/api/reservations/${id}/contracts`,'POST',{},staff);assert.equal(r.status,201,JSON.stringify(r.data));c=r.data;}
 if(!c.signed_at){r=await request(`/api/contracts/${c.id}/sign`,'POST',{accepted:true,snapshotHash:c.snapshot_hash,name:'自动化测试顾客'},customer);assert.equal(r.status,200,JSON.stringify(r.data));}
}
