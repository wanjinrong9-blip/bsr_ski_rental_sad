import assert from 'node:assert/strict';
import {damagePolicy} from '../src/damage-policy.mjs';
export const consent={version:damagePolicy.version,accepted:true,readToEnd:true};
// Synthetic one-pixel PNG for isolated automated tests, not a real damage photograph.
export const testPhoto='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
export async function approveCase(request,id,tech,manager,fee=180){
  let result=await request(`/api/damage-cases/${id}`,'GET',undefined,tech);assert.equal(result.status,200);
  result=await request(`/api/damage-cases/${id}/photos`,'POST',{version:result.data.version,part:'板面边缘',caption:'自动化测试合成照片',mime:'image/png',base64:testPhoto},tech);assert.equal(result.status,201,JSON.stringify(result.data));
  result=await request(`/api/damage-cases/${id}`,'PATCH',{version:result.data.version,action:'submit',grade:fee?'MODERATE':'NONE',part:'板面边缘',diagnosis:fee?'测试：板面边缘存在可修复损伤':'测试：仅有正常使用磨损，无损坏费用',laborNok:fee,partsNok:0,replacementNok:fee?Math.max(fee,1000):0,valueBasis:fee?'自动化测试折旧估值依据，不代表真实业务':''},tech);assert.equal(result.status,200,JSON.stringify(result.data));
  result=await request(`/api/damage-cases/${id}/review`,'POST',{version:result.data.version,decision:'approve',note:'自动化测试：照片与成本依据核对通过'},manager);assert.equal(result.status,200,JSON.stringify(result.data));
  const order=(await request(`/api/reservations/${result.data.reservation_id}`,'GET',undefined,manager)).data;
  if(!order.staff_reviewed_at&&order.damage.cases.every(c=>['SUBMITTED','APPROVED'].includes(c.status))){const review=await request(`/api/reservations/${order.id}/staff-review`,'POST',{reviewVersion:order.staffReviewVersion,checks:{identity:true,items:true,evidence:true},note:'自动化测试：逐件核对合同、归还与照片资料'},manager);assert.equal(review.status,200);}
  return result.data;
}
