import { randomBytes,createHash } from 'node:crypto';
import { audit, notify } from './db.mjs';
import { damagePolicy } from './damage-policy.mjs';
import {depositFor,depositRule} from './catalog-upgrade.mjs';
import {customerProfile,skillLevels,freezeRate} from './master-data.mjs';
import {rentalPolicy,isFirstEffectiveRental,lateCharge,rentalLateSummary} from './rental-policy.mjs';
import {isShowcaseSource,simulated} from './simulation.mjs';

export class DomainError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();
const must = (condition, message, status = 400) => { if (!condition) throw new DomainError(message,status); };
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const payloadHash=input=>createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');

// A hold expires by time even when its historical row is retained as HOLD.
export function effectiveReservationStatus(row, at=Date.now()) {
  return row.status==='HOLD' && Number.isFinite(Date.parse(row.hold_expires_at)) && Date.parse(row.hold_expires_at)<=at
    ? 'EXPIRED' : row.status;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function normalizeWindow(pickupAt, returnAt) {
  const start = new Date(pickupAt);
  const end = new Date(returnAt);
  must(!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()),'请选择有效的取还日期');
  must(end > start,'归还时间必须晚于取货时间');
  must(end - start >= 3600000,'租期至少 1 小时');
  must(end - start <= 30*86400000,'单笔预约最多 30 天');
  must(start.getTime() >= Date.now()-300000,'取货时间不能早于现在');
  const osloClock=value=>{
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(value).map(part=>[part.type,part.value]));
    return Number(parts.hour)*60+Number(parts.minute);
  };
  must(osloClock(start)>=9*60,'起租时间须为挪威当地时间 09:00 后');
  must(osloClock(end)<=16*60,'归还时间须为挪威当地时间 16:00 前');
  return {pickupAt:start.toISOString(),returnAt:end.toISOString(),days:Math.max(1,Math.ceil((end-start)/86400000))};
}

export function policyFor(db, variantId, storeId, pickupAt) {
  return db.prepare(`SELECT * FROM price_policies WHERE variant_id=? AND store_id=?
    AND status='APPROVED' AND effective_from<=? ORDER BY effective_from DESC, version DESC LIMIT 1`)
    .get(variantId,storeId,pickupAt.slice(0,10));
}

export function availability(db, storeId, pickupAt, returnAt) {
  const units = db.prepare(`SELECT variant_id, COUNT(*) AS total FROM units
    WHERE store_id=? AND needs_cleaning=0 AND status NOT IN ('MAINTENANCE','TRANSFER','RETIRED')
    GROUP BY variant_id`).all(storeId);
  const blocked = db.prepare(`SELECT ri.variant_id, SUM(CASE WHEN r.status='ACTIVE' THEN MAX(0,ri.qty-(SELECT COUNT(*) FROM rental_units ru WHERE ru.reservation_item_id=ri.id AND ru.returned=1)) ELSE ri.qty END) AS blocked
    FROM reservation_items ri JOIN reservations r ON r.id=ri.reservation_id
    WHERE r.store_id=? AND ((r.pickup_at < ? AND r.return_at > ?)
      OR (r.status='ACTIVE' AND r.return_at < ?))
    AND (r.status IN ('CONFIRMED','READY','ACTIVE')
      OR (r.status='HOLD' AND r.hold_expires_at>?))
    GROUP BY ri.variant_id`).all(storeId,returnAt,pickupAt,now(),now());
  const reserved = new Map(blocked.map(row => [row.variant_id,row.blocked]));
  return new Map(units.map(row => [row.variant_id,Math.max(0,row.total-(reserved.get(row.variant_id)||0))]));
}

export function quote(db, input) {
  const storeId = Number(input.storeId);
  must(db.prepare('SELECT id FROM stores WHERE id=?').get(storeId),'请选择有效取货门店');
  const window = normalizeWindow(input.pickupAt,input.returnAt);
  must(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 12,'请至少选择一件装备');
  const counts = new Map();
  for (const item of input.items) {
    const variantId = Number(item.variantId);
    const qty = Number(item.qty);
    must(Number.isInteger(variantId) && Number.isInteger(qty) && qty >= 1 && qty <= 5,'装备数量需为 1–5 件');
    counts.set(variantId,(counts.get(variantId)||0)+qty);
  }
  const available = availability(db,storeId,window.pickupAt,window.returnAt);
  const lines = [];
  let rentNok = 0, depositNok = 0;
  for (const [variantId,qty] of counts) {
    must(qty<=5,'同一规格合计最多5件，不可通过重复行绕过数量限制');
    const variant = db.prepare('SELECT * FROM variants WHERE id=? AND active=1').get(variantId);
    must(variant,'装备不存在或已停用');
    must(qty <= (available.get(variantId)||0),`${variant.name} ${variant.size} 在所选租期仅余 ${available.get(variantId)||0} 件`,409);
    const policy = policyFor(db,variantId,storeId,window.pickupAt);
    must(policy,`${variant.name} 暂无已批准价目，不能下单`,409);
    const unitRent = Math.round(policy.daily_nok * (1 + (window.days-1)*policy.extra_day_factor));
    const unitDeposit=depositFor(variant,unitRent);
    const lineRent = unitRent*qty, lineDeposit = unitDeposit*qty;
    rentNok += lineRent; depositNok += lineDeposit;
    lines.push({variantId,name:variant.name,category:variant.category,size:variant.size,qty,
      available:available.get(variantId),dailyNok:policy.daily_nok,unitRentNok:unitRent,
      unitDepositNok:unitDeposit,referenceValueNok:variant.retail_nok,depositRate:depositRule.rate,depositBasis:depositRule.basis,rentNok:lineRent,depositNok:lineDeposit,
      policyId:policy.id,policyVersion:policy.version});
  }
  const result={storeId,...window,lines,rentNok,depositNok,totalNok:rentNok+depositNok,
    latePolicy:rentalPolicy,
    currency:'NOK',policyNote:isShowcaseSource(db)?
      '课程合成预览按虚构门店的 NOK 示例价目计算；不代表 BSR 正式商业报价。':
      '正式订单按取货门店已批准的 NOK 价目结算；参考换算价不参与支付。',
    expiresAt:new Date(Date.now()+15*60000).toISOString()};
  return isShowcaseSource(db)?simulated(result):result;
}

export function quoteFingerprint(q){
  const basis={storeId:q.storeId,pickupAt:q.pickupAt,returnAt:q.returnAt,
    currency:q.currency,rentNok:q.rentNok,depositNok:q.depositNok,totalNok:q.totalNok,
    damagePolicyVersion:damagePolicy.version,latePolicyVersion:q.latePolicy?.version,
    lines:q.lines.map(line=>({variantId:line.variantId,qty:line.qty,
      unitRentNok:line.unitRentNok,unitDepositNok:line.unitDepositNok,
      referenceValueNok:line.referenceValueNok,policyId:line.policyId,
      policyVersion:line.policyVersion}))};
  return payloadHash(basis);
}

function randomCode(prefix) { return `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`; }

export function createReservation(db, userId, input,createdBy=null,requestKey) {
  must(requestKey!==undefined,'创建预约须提供 Idempotency-Key 提交标识',428);
  must(typeof requestKey==='string'&&/^[A-Za-z0-9._:-]{16,128}$/.test(requestKey),'Idempotency-Key 格式不正确：须为16–128位字母、数字或 . _ : -',400);
  must(input&&typeof input==='object'&&!Array.isArray(input),'预约内容应为对象',400);
  const actorId=createdBy||userId,channel=createdBy?'COUNTER':'ONLINE',hash=payloadHash(input);
  return transaction(db, () => {
    const prior=db.prepare('SELECT r.id,r.code,r.status,r.hold_expires_at,r.quote_json,q.payload_hash FROM reservation_requests q JOIN reservations r ON r.id=q.reservation_id WHERE q.actor_id=? AND q.channel=? AND q.request_key=?').get(actorId,channel,requestKey);
    if(prior){must(prior.payload_hash===hash,'提交标识已用于不同预约内容，请核对内容后重新发起',409);
      return {id:prior.id,code:prior.code,status:effectiveReservationStatus(prior),quote:JSON.parse(prior.quote_json),replayed:true};}
    must(input.damageConsent?.accepted===true&&input.damageConsent?.readToEnd===true&&input.damageConsent?.version===damagePolicy.version,
      '请先完整阅读并勾选同意当前版本的装备损坏与押金结算规则',422);
    const skill=typeof input.customerSkill==='string'?input.customerSkill.trim():'';
    must(skillLevels.includes(skill),'顾客本次滑雪水平请选择初级、中级、高级或专家+',422);
    const q = quote(db,input);
    if(input.expectedQuoteFingerprint&&quoteFingerprint(q)!==input.expectedQuoteFingerprint){
      const error=new DomainError('报价或库存已变化，请重新确认',409);
      error.code='QUOTE_EXPIRED';throw error;
    }
    const customer=db.prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(userId);must(customer,'顾客不存在',404);
    const profile=customerProfile(customer,input.customerProfile||{},true);
    const code = randomCode('BR');
    const pickupCode = randomBytes(3).toString('hex').toUpperCase();
    const result = db.prepare(`INSERT INTO reservations
      (code,user_id,store_id,pickup_at,return_at,status,rent_nok,deposit_nok,total_nok,
       pickup_code,quote_json,hold_expires_at,created_at)
      VALUES(?,?,?,?,?,'HOLD',?,?,?,?,?,?,?)`).run(code,userId,q.storeId,q.pickupAt,q.returnAt,
       q.rentNok,q.depositNok,q.totalNok,pickupCode,JSON.stringify(q),q.expiresAt,now());
    const id = Number(result.lastInsertRowid);
    db.prepare('UPDATE reservations SET customer_skill=?,customer_snapshot=?,requires_fulfillment=1,created_by=?,late_policy_version=?,late_hourly_percent=?,late_grace_minutes=? WHERE id=?')
      .run(skill,JSON.stringify(profile),createdBy,rentalPolicy.version,rentalPolicy.lateHourlyPercent,
        isFirstEffectiveRental(db,userId,id)?rentalPolicy.firstRentalGraceMinutes:0,id);
    db.prepare(`UPDATE reservations SET assigned_staff_id=(SELECT id FROM users
      WHERE role IN ('staff','manager') AND store_id=?
      ORDER BY CASE role WHEN 'staff' THEN 0 ELSE 1 END,id LIMIT 1)
      WHERE id=?`).run(q.storeId,id);
    db.prepare('INSERT INTO damage_consents(reservation_id,user_id,policy_version,policy_json,accepted_at) VALUES(?,?,?,?,?)')
      .run(id,userId,damagePolicy.version,JSON.stringify(damagePolicy),now());
    const insertLine = db.prepare(`INSERT INTO reservation_items
      (reservation_id,variant_id,qty,unit_rent_nok,unit_deposit_nok,policy_id) VALUES(?,?,?,?,?,?)`);
    for (const line of q.lines) insertLine.run(id,line.variantId,line.qty,line.unitRentNok,line.unitDepositNok,line.policyId);
    db.prepare('UPDATE reservation_items SET rental_from=?,rental_to=? WHERE reservation_id=?').run(q.pickupAt,q.returnAt,id);
    db.prepare('INSERT INTO reservation_requests(actor_id,channel,request_key,payload_hash,reservation_id,created_at) VALUES(?,?,?,?,?,?)').run(actorId,channel,requestKey,hash,id,now());
    audit(db,actorId,'RESERVATION_CREATED','reservation',id,{code,quote:q,customerId:userId,channel});
    if(createdBy)audit(db,actorId,'COUNTER_ORDER_CREATED','reservation',id,{customerId:userId});
    notify(db,userId,'预约已暂留',`订单 ${code} 已暂留 15 分钟，请先生成并确认当前合同，再完成演示支付。`);
    return {id,code,status:'HOLD',quote:q,replayed:false};
  });
}

export function payReservation(db, userId, id,actorId=userId) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM reservations WHERE id=? AND user_id=?').get(id,userId);
    must(row,'预约不存在',404);
    must(row.status==='HOLD','只有待支付预约可以付款',409);
    must(row.hold_expires_at>now(),'暂留已过期，请重新预约',409);
    const currentContract=db.prepare('SELECT id,signed_at FROM contracts WHERE reservation_id=? AND version=?').get(id,row.contract_version);
    if(row.requires_fulfillment)must(currentContract?.signed_at,'请先生成并签署当前版本合同，再进行演示付款',409);
    const grace=isFirstEffectiveRental(db,userId,id)?rentalPolicy.firstRentalGraceMinutes:0;
    if(currentContract?.signed_at&&row.late_grace_minutes!==grace)
      throw new DomainError('首次租赁宽限资格已变化，请重新预约并签署新合同',409);
    // 演示支付适配器：不连接真实支付服务、不扣款。
    const ref = randomCode('DEMO-PAY');
    const payment = db.prepare(`INSERT INTO payments(reservation_id,type,amount_nok,status,provider_ref,idempotency_key,created_at)
      VALUES(?,?,?,'SUCCEEDED',?,?,?)`);
    payment.run(id,'RENT',row.rent_nok,ref,`rent:${id}`,now());
    payment.run(id,'DEPOSIT',row.deposit_nok,ref,`deposit:${id}`,now());
    db.prepare('UPDATE reservations SET late_grace_minutes=? WHERE id=?').run(grace,id);
    db.prepare("UPDATE reservations SET status='CONFIRMED',paid_at=? WHERE id=?").run(now(),id);
    db.prepare("INSERT OR IGNORE INTO preparations(reservation_id,status,assigned_to,created_at,updated_at) VALUES(?,'QUEUED',?,?,?)").run(id,row.assigned_staff_id,now(),now());
    audit(db,actorId,'PAYMENT_DEMO_SUCCEEDED','reservation',id,{ref,totalNok:row.total_nok});
    notify(db,userId,'预约已确认',`订单 ${row.code} 已完成演示支付。到店请出示取货码。`);
    return {id,status:'CONFIRMED',pickupCode:row.pickup_code,providerRef:ref};
  });
}

export function cancelReservation(db, userId, id) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM reservations WHERE id=? AND user_id=?').get(id,userId);
    must(row,'预约不存在',404);
    must(['HOLD','CONFIRMED','READY'].includes(row.status),'此状态不可自行取消，请联系门店',409);
    must(effectiveReservationStatus(row)!=='EXPIRED','暂留已过期，无需取消；请重新预约',409);
    const hours = (new Date(row.pickup_at)-Date.now())/3600000;
    must(hours > 0,'取货时间已到，请联系门店',409);
    const fee = ['CONFIRMED','READY'].includes(row.status) && hours<24 ? Math.round(row.rent_nok*0.2) : 0;
    const refund = ['CONFIRMED','READY'].includes(row.status) ? row.total_nok-fee : 0;
    if (refund>0) db.prepare(`INSERT INTO payments(reservation_id,type,amount_nok,status,provider_ref,idempotency_key,created_at)
      VALUES(?,'CANCELLATION_REFUND',?,'SUCCEEDED',?,?,?)`).run(id,refund,randomCode('DEMO-REFUND'),`cancel:${id}`,now());
    db.prepare("UPDATE reservations SET status='CANCELLED',cancellation_fee_nok=?,refund_status=? ,refund_nok=? WHERE id=?")
      .run(fee,refund>0?'REFUNDED':'NOT_DUE',refund,id);
    audit(db,userId,'RESERVATION_CANCELLED','reservation',id,{fee,refund});
    db.prepare('UPDATE preparation_units SET active=0 WHERE reservation_id=?').run(id);db.prepare("UPDATE preparations SET status='CANCELLED',version=version+1,updated_at=? WHERE reservation_id=?").run(now(),id);
    notify(db,userId,'预约已取消',`订单 ${row.code} 已取消。演示退款 NOK ${refund}，取消费用 NOK ${fee}。`);
    return {id,status:'CANCELLED',feeNok:fee,refundNok:refund};
  });
}

export function pickup(db, staffId, code) {
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM reservations WHERE pickup_code=? OR code=?").get(code,code);
    must(row,'未找到对应预约',404);
    must(['CONFIRMED','READY'].includes(row.status),'预约不是待取货状态',409);
    const prep=db.prepare('SELECT * FROM preparations WHERE reservation_id=?').get(row.id);
    if(row.requires_fulfillment){must(prep?.status==='READY','请先在装备准备工作台完成拣货、清洁与安全检查',409);must(db.prepare('SELECT signed_at FROM contracts WHERE reservation_id=? AND version=?').get(row.id,row.contract_version)?.signed_at,'请先开具并签署当前版本租赁合同',409);}
    const lines = db.prepare('SELECT * FROM reservation_items WHERE reservation_id=?').all(row.id);
    const assigned = [];
    for (const line of lines) {
      const units=prep?.status==='READY'?db.prepare(`SELECT u.id,u.inventory_no FROM preparation_units pu JOIN units u ON u.id=pu.unit_id WHERE pu.reservation_id=? AND pu.item_id=? AND pu.active=1 AND u.status='AVAILABLE' AND u.needs_cleaning=0 AND u.store_id=?`).all(row.id,line.id,row.store_id):db.prepare(`SELECT id,inventory_no FROM units u WHERE variant_id=? AND store_id=? AND status='AVAILABLE' AND needs_cleaning=0 AND NOT EXISTS(SELECT 1 FROM preparation_units pu WHERE pu.unit_id=u.id AND pu.active=1) ORDER BY id LIMIT ?`).all(line.variant_id,row.store_id,line.qty);
      must(units.length===line.qty,'门店可交付单件不足，请先调拨或更换装备',409);
      for (const unit of units) {
        db.prepare("UPDATE units SET status='RENTED' WHERE id=?").run(unit.id);
        db.prepare('INSERT INTO rental_units(reservation_item_id,unit_id,out_at) VALUES(?,?,?)').run(line.id,unit.id,now());
        assigned.push({unitId:unit.id,inventoryNo:unit.inventory_no});
      }
    }
    db.prepare("UPDATE reservations SET status='ACTIVE',picked_up_at=?,assigned_staff_id=? WHERE id=?").run(now(),staffId,row.id);
    db.prepare('UPDATE preparation_units SET active=0 WHERE reservation_id=?').run(row.id);db.prepare("UPDATE preparations SET status='HANDED_OVER',version=version+1,updated_at=? WHERE reservation_id=?").run(now(),row.id);
    audit(db,staffId,'PICKUP_COMPLETED','reservation',row.id,{units:assigned});
    notify(db,row.user_id,'装备已交付',`订单 ${row.code} 已逐件核验交付，应于约定时间前归还。`);
    return {id:row.id,status:'ACTIVE',units:assigned};
  });
}

export function returnRental(db, staffId, id, inspectedItems,returnStoreId=null) {
  return transaction(db, () => {
    const returnedAt=now();
    const row = db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
    must(row,'订单不存在',404);
    must(row.status==='ACTIVE','订单不是租赁中状态',409);
    const units = db.prepare(`SELECT ru.unit_id, u.inventory_no, u.store_id, p.daily_nok,
      COALESCE(ri.rental_to,r.return_at) AS due_at FROM rental_units ru
      JOIN reservation_items ri ON ri.id=ru.reservation_item_id
      JOIN reservations r ON r.id=ri.reservation_id JOIN price_policies p ON p.id=ri.policy_id
      JOIN units u ON u.id=ru.unit_id
      WHERE ri.reservation_id=? AND ru.returned=0`).all(id);
    must(Array.isArray(inspectedItems) && inspectedItems.length>0&&inspectedItems.length<=units.length,'请选择本批实际归还的装备并逐件验收');
    const byId = new Map(inspectedItems.map(item => [Number(item.unitId),item]));
    must(byId.size===inspectedItems.length&&[...byId.keys()].every(id=>units.some(u=>u.unit_id===id)),'验收单件与未归还记录不一致');
    const returnStore=Number(returnStoreId)||row.store_id;must(db.prepare('SELECT id FROM stores WHERE id=?').get(returnStore),'归还门店无效');
    let damaged = 0;
    const contractor = isShowcaseSource(db)?
      db.prepare("SELECT id FROM users WHERE role='contractor' AND account_state='ACTIVE' AND (store_id=? OR store_id IS NULL) ORDER BY CASE WHEN store_id=? THEN 0 ELSE 1 END,id LIMIT 1")
        .get(returnStore,returnStore):
      db.prepare("SELECT id FROM users WHERE role='contractor' LIMIT 1").get();
    for (const unit of units) {
      const item = byId.get(unit.unit_id);
      if(!item)continue;
      must(['GOOD','CLEANING','DAMAGED'].includes(item.condition),'请选择每件装备的验收结果');
      const fee = Number(item.feeNok || 0);
      must(fee===0,'前台仅登记归还现象，损坏费须由维修技师鉴定并经经理复核');
      must(item.condition!=='DAMAGED' || String(item.note||'').trim().length>=3,'损坏项须说明依据');
      if(item.condition==='DAMAGED')damaged++;
      const inspectionId=Number(db.prepare(`INSERT INTO inspections(reservation_id,unit_id,condition,note,fee_nok,inspected_by,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id,unit.unit_id,item.condition,String(item.note||''),0,staffId,now()).lastInsertRowid);
      const late=row.late_policy_version?
        lateCharge(unit.daily_nok,unit.due_at,returnedAt,row.late_grace_minutes||0,row.late_hourly_percent):
        {lateMinutes:0,billableHours:0,feeNok:0};
      db.prepare('UPDATE rental_units SET returned=1,returned_at=?,return_store_id=?,late_minutes=?,late_billable_hours=?,late_fee_nok=? WHERE unit_id=? AND reservation_item_id IN (SELECT id FROM reservation_items WHERE reservation_id=?)')
        .run(returnedAt,returnStore,late.lateMinutes,late.billableHours,late.feeNok,unit.unit_id,id);
      db.prepare('UPDATE units SET status=?,condition_note=?,store_id=?,needs_cleaning=? WHERE id=?').run(item.condition==='DAMAGED'?'MAINTENANCE':'AVAILABLE',String(item.note||''),returnStore,item.condition==='CLEANING'?1:0,unit.unit_id);
      if (item.condition==='DAMAGED') {
        const taskId=Number(db.prepare(`INSERT INTO maintenance(unit_id,contractor_id,store_id,issue,status,priority,due_at,created_at,updated_at)
          VALUES(?,?,?,?,'ASSIGNED','HIGH',?,?,?)`).run(unit.unit_id,contractor?.id||null,returnStore,String(item.note),new Date(Date.now()+2*86400000).toISOString(),now(),now()).lastInsertRowid);
        freezeRate(db,taskId);
        const caseCreatedAt=now();
        db.prepare(`INSERT INTO damage_cases(inspection_id,reservation_id,unit_id,maintenance_id,assessor_id,created_at) VALUES(?,?,?,?,?,?)`)
          .run(inspectionId,id,unit.unit_id,taskId,contractor?.id||null,caseCreatedAt);
        db.prepare("UPDATE damage_cases SET feedback_due_at=? WHERE inspection_id=?")
          .run(new Date(Date.parse(caseCreatedAt)+24*3600000).toISOString(),inspectionId);
        db.prepare(`INSERT INTO maintenance_events(maintenance_id,actor_id,event,to_status,note,created_at) VALUES(?,?,'CREATED','ASSIGNED',?,?)`).run(taskId,staffId,`归还验收发现异常：${String(item.note)}`,now());
        if(contractor)notify(db,contractor.id,'归还异常维修任务',`${unit.inventory_no||unit.unit_id}：${String(item.note)}`);
      }
    }
    const remaining=units.length-inspectedItems.length,totalDamaged=db.prepare('SELECT COUNT(*) AS n FROM damage_cases WHERE reservation_id=?').get(id).n;
    const lateFee=rentalLateSummary(db,id,returnedAt).assessedNok;
    const supplement=Math.max(0,lateFee-row.deposit_nok);
    const status = remaining?'ACTIVE':totalDamaged?'REVIEW':supplement?'SETTLEMENT':'COMPLETED';
    const refundStatus = remaining?'NOT_DUE':totalDamaged?'REVIEW':lateFee>=row.deposit_nok&&lateFee>0?'DEDUCTED':'REFUNDED';
    const refund = remaining||totalDamaged?0:Math.max(0,row.deposit_nok-lateFee);
    db.prepare('UPDATE reservations SET status=?,returned_at=?,refund_status=?,refund_nok=? WHERE id=?')
      .run(status,remaining?null:returnedAt,refundStatus,refund,id);
    if(!remaining&&!totalDamaged&&lateFee>0)
      db.prepare('INSERT INTO damage_settlements(reservation_id,total_fee_nok,deducted_nok,refund_nok,supplement_nok,status,approved_by,created_at,settled_at,damage_fee_nok,late_fee_nok) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,lateFee,Math.min(row.deposit_nok,lateFee),refund,supplement,supplement?'AWAITING_CONTACT':'SETTLED',staffId,returnedAt,supplement?null:returnedAt,0,lateFee);
    if (!remaining&&!totalDamaged && refund>0) db.prepare(`INSERT INTO payments(reservation_id,type,amount_nok,status,provider_ref,idempotency_key,created_at)
      VALUES(?,'REFUND',?,'SUCCEEDED',?,?,?)`).run(id,refund,randomCode('DEMO-REFUND'),`refund:deposit:${id}`,now());
    audit(db,staffId,'RETURN_INSPECTED','reservation',id,{damaged,status,remaining,lateFeeNok:lateFee,returnStoreId:returnStore,items:inspectedItems});
    if(remaining){notify(db,row.user_id,'部分装备已归还',`订单 ${row.code} 本批归还 ${inspectedItems.length} 件，尚有 ${remaining} 件在租；目前已核定超时费 NOK ${lateFee}，全单归还后结算押金。`);return {id,status,remaining,refundStatus,refundNok:0,lateFeeNok:lateFee,feesNok:lateFee};}
    notify(db,row.user_id,damaged?'归还待损坏鉴定':supplement?'超时费待联系补差':'押金已发起演示退款',damaged?
      `订单 ${row.code} 有 ${damaged} 件装备疑似受损；已核定超时费 NOK ${lateFee}，损坏费须照片鉴定与经理复核后合并结算。`:
      `订单 ${row.code} 已完成逐件验收，超时费 NOK ${lateFee}，抵扣押金后演示退款 NOK ${refund}。${supplement?'员工将联系说明补差 NOK '+supplement+'，不自动扣款。':''}`);
    if(supplement)for(const staff of db.prepare("SELECT id FROM users WHERE role IN ('staff','manager') AND store_id=?").all(row.store_id))
      notify(db,staff.id,'请联系顾客补差',`订单 ${row.code} 超时费超出押金 NOK ${supplement}，请联系顾客并记录核实凭证。`);
    return {id,status,refundStatus,refundNok:refund,lateFeeNok:lateFee,feesNok:lateFee,supplementNok:supplement};
  });
}

export function approveRefund(db, managerId, id) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
    must(row,'订单不存在',404);
    must(row.status==='REVIEW','订单不在待审批状态',409);
    must(row.staff_reviewed_at,'请先由门店租赁专员完成归还与鉴定资料复核',409);
    const cases=db.prepare('SELECT * FROM damage_cases WHERE reservation_id=?').all(id);
    const count=db.prepare("SELECT COUNT(*) AS n FROM inspections WHERE reservation_id=? AND condition='DAMAGED'").get(id).n;
    must(count>0&&cases.length===count&&cases.every(c=>c.status==='APPROVED'),'必须逐件完成照片鉴定和经理复核，不能直接扣款或退款',409);
    const contact=db.prepare('SELECT outcome FROM damage_contacts WHERE reservation_id=? ORDER BY id DESC LIMIT 1').get(id);
    must(contact?.outcome!=='DISPUTED','顾客已提出异议，请先沟通解决并记录确认结果',409);
    const consent=db.prepare('SELECT 1 FROM damage_consents WHERE reservation_id=?').get(id);
    must(consent||contact?.outcome==='REACHED','历史订单没有新规则同意记录，须先联系顾客协商并记录确认结果',409);
    const damageFee = db.prepare('SELECT COALESCE(SUM(fee_nok),0) AS total FROM inspections WHERE reservation_id=?').get(id).total;
    const lateFee=rentalLateSummary(db,id).assessedNok;
    const fee=damageFee+lateFee;
    const refund = Math.max(0,row.deposit_nok-fee);
    const deduction=Math.min(row.deposit_nok,fee),supplement=Math.max(0,fee-row.deposit_nok);
    db.prepare('UPDATE inspections SET approved=1 WHERE reservation_id=?').run(id);
    db.prepare('INSERT INTO damage_settlements(reservation_id,total_fee_nok,deducted_nok,refund_nok,supplement_nok,status,approved_by,created_at,settled_at,damage_fee_nok,late_fee_nok) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,fee,deduction,refund,supplement,supplement?(contact?.outcome==='REACHED'?'CONTACTED':'AWAITING_CONTACT'):'SETTLED',managerId,now(),supplement?null:now(),damageFee,lateFee);
    db.prepare('UPDATE reservations SET status=?,refund_status=?,refund_nok=? WHERE id=?')
      .run(supplement?'SETTLEMENT':'COMPLETED',refund>0?'REFUNDED':'DEDUCTED',refund,id);
    if (refund>0) db.prepare(`INSERT INTO payments(reservation_id,type,amount_nok,status,provider_ref,idempotency_key,created_at)
      VALUES(?,'REFUND',?,'SUCCEEDED',?,?,?)`).run(id,refund,randomCode('DEMO-REFUND'),`refund:deposit:${id}`,now());
    audit(db,managerId,'DEPOSIT_DEDUCTION_APPROVED','reservation',id,{damageFee,lateFee,fee,refund,deduction,supplement});
    notify(db,row.user_id,supplement?'费用待联系补差':'押金结算已完成',`订单 ${row.code} 核定损坏费 NOK ${damageFee}、超时费 NOK ${lateFee}，合计抵扣押金 NOK ${deduction}，演示退款 NOK ${refund}。${supplement?`另需补差 NOK ${supplement}，员工将联系说明，不会自动追加扣款。`:''}`);
    if(supplement)for(const staff of db.prepare("SELECT id FROM users WHERE role IN ('staff','manager') AND store_id=?").all(row.store_id))notify(db,staff.id,'请联系顾客补差',`订单 ${row.code} 费用超出押金 NOK ${supplement}，请联系顾客并记录核实凭证。`);
    return {id,status:supplement?'SETTLEMENT':'COMPLETED',damageFeeNok:damageFee,lateFeeNok:lateFee,feeNok:fee,refundNok:refund,deductedNok:deduction,supplementNok:supplement};
  });
}
