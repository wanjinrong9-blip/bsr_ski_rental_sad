import {DomainError,transaction} from './domain.mjs';
import {audit,notify} from './db.mjs';
const person=(db,id,fallback)=>id?db.prepare('SELECT id,name,role FROM users WHERE id=?').get(id)||{name:fallback}:{name:fallback};
export function staffReviewVersion(db,id){return `${id}:`+db.prepare('SELECT id,version,status FROM damage_cases WHERE reservation_id=? ORDER BY id').all(id).map(c=>`${c.id}/${c.version}/${c.status}`).join(';');}
export function orderWorkflow(db,user,order){
 const cases=db.prepare('SELECT * FROM damage_cases WHERE reservation_id=?').all(order.id),damaged=cases.length>0;
 const event=action=>db.prepare('SELECT actor_id,created_at FROM audit_log WHERE target_type=\'reservation\' AND target_id=? AND action=? ORDER BY id DESC LIMIT 1').get(order.id,action);
 const clerk=person(db,order.assigned_staff_id,'门店租赁专员（待分派）'),managerId=db.prepare("SELECT id FROM users WHERE role='manager' AND store_id=? ORDER BY id LIMIT 1").get(order.store_id)?.id;
 const manager=person(db,managerId,'门店经理（待分派）');
 const customer=user.role==='contractor'?{name:'顾客（隐去个人信息）'}:person(db,order.user_id,'预约顾客');
 const technicians=[...new Set(cases.map(c=>c.assessor_id).filter(Boolean))].map(id=>person(db,id,'装备检修技师'));
 const refund=event('DEPOSIT_DEDUCTION_APPROVED'),lastContact=event('DAMAGE_CUSTOMER_CONTACT'),paymentEvent=event('PAYMENT_DEMO_SUCCEEDED');
 const paymentActor=paymentEvent?.actor_id===order.user_id&&user.role==='contractor'?customer:person(db,paymentEvent?.actor_id,customer.name);
 const prep=db.prepare('SELECT * FROM preparations WHERE reservation_id=?').get(order.id),contract=db.prepare('SELECT * FROM contracts WHERE reservation_id=? AND version=?').get(order.id,order.contract_version);
 const partial=db.prepare('SELECT COUNT(*) AS n FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id WHERE ri.reservation_id=? AND ru.returned=0').get(order.id).n;
 const steps=[
  {key:'RESERVED',label:'创建预约 / 现场开单',done:true,actor:order.created_by?person(db,order.created_by,customer.name):customer,at:order.created_at},
  {key:'CONTRACT',label:contract?'确认当前合同':'生成并阅读合同',done:!!contract?.signed_at,skip:!order.requires_fulfillment&&!contract,actor:contract?customer:order.created_by?clerk:customer,at:contract?.signed_at},
  {key:'PAYMENT',label:'确认演示付款',done:!!order.paid_at,actor:paymentActor,at:order.paid_at},
  {key:'PREPARATION',label:prep?.status==='BLOCKED'?'备货异常待协调':prep?.status==='CHECKING'?'装备清洁与安全检查':'员工准备装备',done:!!order.picked_up_at||prep?.status==='READY',skip:!order.requires_fulfillment&&!prep,actor:person(db,prep?.assigned_to,clerk.name),at:prep?.ready_at},
  {key:'PICKUP',label:'门店核码交付',done:!!order.picked_up_at,actor:person(db,event('PICKUP_COMPLETED')?.actor_id,clerk.name),responsible:clerk,at:order.picked_up_at},
  {key:'RETURN',label:order.status==='ACTIVE'&&partial?'归还逐件验收 · 尚有'+partial+'件在租':'归还逐件验收',done:!!order.returned_at,actor:person(db,event('RETURN_INSPECTED')?.actor_id,clerk.name),responsible:clerk,at:order.returned_at},
  {key:'ASSESSMENT',label:'受损程度鉴定 / 24H反馈',skip:!!order.returned_at&&!damaged,done:damaged&&cases.every(c=>c.first_feedback_at),actor:{name:technicians.map(p=>p.name).join('、')||'装备检修技师（待指派）'},dueAt:cases.map(c=>c.feedback_due_at).filter(Boolean).sort()[0],at:cases.map(c=>c.first_feedback_at).filter(Boolean).sort().at(-1)},
  {key:'STAFF_REVIEW',label:'门店资料复核',skip:!!order.returned_at&&!damaged,done:!!order.staff_reviewed_at,actor:person(db,order.staff_reviewed_by,clerk.name),responsible:clerk,at:order.staff_reviewed_at},
  {key:'MANAGER_REVIEW',label:'经理核价与押金核算',skip:!!order.returned_at&&!damaged,done:!!refund,actor:person(db,refund?.actor_id,manager.name),responsible:manager,at:refund?.created_at},
  {key:'SETTLEMENT',label:order.status==='SETTLEMENT'?'联系顾客并核实补差':'退款 / 费用结清',done:order.status==='COMPLETED',actor:person(db,lastContact?.actor_id,clerk.name),responsible:clerk,at:order.status==='COMPLETED'?(event('DAMAGE_SUPPLEMENT_DEMO_RECORDED')?.created_at||refund?.created_at||order.returned_at):null}
 ];
 let marked=false;
 for(const s of steps){s.status=s.skip?'SKIPPED':s.done?'DONE':!marked?'CURRENT':'WAITING';if(s.status==='CURRENT')marked=true;s.handler=s.done?s.actor:(s.responsible||s.actor);delete s.done;delete s.responsible;}
 if(order.status==='CANCELLED')return {current:'已取消',handler:customer,steps:steps.map(s=>({...s,status:s.key==='RESERVED'?'DONE':'SKIPPED'})),cancelled:true};
 if(order.status==='EXPIRED')return {current:'暂留已过期 · 请重新选择租期',currentKey:'EXPIRED',handler:customer,steps:steps.map(s=>({...s,status:s.key==='RESERVED'?'DONE':'SKIPPED'})),expired:true};
 const active=steps.find(s=>s.status==='CURRENT');return {current:active?.label||'全部完成',currentKey:active?.key||'DONE',handler:active?.handler||steps.at(-1).handler,steps};
}
export function staffReview(db,user,id,input){
 if(!user||!['staff','manager'].includes(user.role))throw new DomainError('仅门店租赁专员或经理可提交门店复核',403);
 return transaction(db,()=>{
  const order=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);if(!order)throw new DomainError('订单不存在',404);
  if(order.store_id!==user.store_id)throw new DomainError('无权复核其他门店订单',403);
  if(order.status!=='REVIEW')throw new DomainError('订单不在归还复核阶段',409);
  const cases=db.prepare('SELECT status FROM damage_cases WHERE reservation_id=?').all(id);
  if(!cases.length||cases.some(c=>!['SUBMITTED','APPROVED'].includes(c.status)))throw new DomainError('请先等待所有受损件完成照片与初步鉴定',409);
  if(order.staff_reviewed_at)throw new DomainError('该订单已完成门店复核，请勿重复提交',409);
  if(!['identity','items','evidence'].every(k=>input.checks?.[k]===true)||String(input.note||'').trim().length<5)throw new DomainError('请核对顾客与合同、实物归还、照片资料并填写至少5字复核说明');
  if(input.reviewVersion!==staffReviewVersion(db,id))throw new DomainError('照片或鉴定已更新，请重新打开并复核最新资料，原说明请先保留',409);
  const at=new Date().toISOString();db.prepare('UPDATE reservations SET staff_reviewed_by=?,staff_reviewed_at=?,staff_review_note=? WHERE id=?').run(user.id,at,String(input.note).trim().slice(0,2000),id);
  audit(db,user.id,'STAFF_DAMAGE_REVIEW','reservation',id,{checks:input.checks,note:input.note});
  for(const m of db.prepare("SELECT id FROM users WHERE role='manager' AND store_id=?").all(order.store_id))notify(db,m.id,'门店已复核，待核价结算',`订单 ${order.code} 已由 ${user.name} 核对归还及照片资料。`);
  notify(db,order.user_id,'门店复核进展',`订单 ${order.code} 已由 ${user.name} 完成资料复核，下一步由门店经理核价与押金核算。`);return {ok:true};
 });
}
export function checkDamageSLA(db,now=Date.now()){
 const rows=db.prepare("SELECT c.*,u.inventory_no,r.store_id FROM damage_cases c JOIN units u ON u.id=c.unit_id JOIN reservations r ON r.id=c.reservation_id WHERE c.first_feedback_at IS NULL AND c.overdue_notified_at IS NULL AND c.feedback_due_at IS NOT NULL AND c.status<>'APPROVED'").all().filter(c=>Date.parse(c.feedback_due_at)<=now);
 for(const c of rows){const at=new Date(now).toISOString();db.prepare('UPDATE damage_cases SET overdue_notified_at=? WHERE id=? AND overdue_notified_at IS NULL').run(at,c.id);
  const recipients=new Set(db.prepare("SELECT id FROM users WHERE role IN ('manager','staff') AND store_id=?").all(c.store_id).map(u=>u.id));if(c.assessor_id)recipients.add(c.assessor_id);
  for(const id of recipients)notify(db,id,'受损鉴定超过24H未反馈',`${c.inventory_no}：请立即提交初步鉴定并向顾客反馈；此时限不是维修完工时限。`);
  audit(db,null,'DAMAGE_SLA_OVERDUE','damage_case',c.id,{dueAt:c.feedback_due_at,at});
 }
 return rows.length;
}
