import {createHash} from 'node:crypto';
import {DomainError,transaction,policyFor,availability} from './domain.mjs';
import {depositFor} from './catalog-upgrade.mjs';
import {writeContract,contracts} from './fulfillment.mjs';
import {audit,notify} from './db.mjs';
const need=(ok,msg,status=400)=>{if(!ok)throw new DomainError(msg,status);};
const hash=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const now=()=>new Date().toISOString();
const proposalStatus=p=>['PENDING','CONFIRMED'].includes(p.status)&&Date.parse(p.expires_at)<=Date.now()?'EXPIRED':p.status;
function proposalAccess(db,user,id){
 need(user&&['customer','staff','manager'].includes(user.role),'无权查看换装草案',403);
 const order=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
 need(order&&(user.role==='customer'?order.user_id===user.id:order.store_id===user.store_id),'订单不存在或无权访问',404);
 return order;
}
function publicProposal(db,p){
 const creator=db.prepare('SELECT name FROM users WHERE id=?').get(p.created_by);
 return {id:p.id,reservationId:p.reservation_id,status:proposalStatus(p),quote:JSON.parse(p.quote_json),
  expiresAt:p.expires_at,createdAt:p.created_at,createdByName:creator?.name||'门店人员',
  confirmedAt:p.confirmed_at||null,rejectedAt:p.rejected_at||null,consumedAt:p.consumed_at||null};
}
export function proposalList(db,user,id){
 proposalAccess(db,user,id);
 return {items:db.prepare('SELECT * FROM amendment_proposals WHERE reservation_id=? ORDER BY id DESC LIMIT 30').all(id).map(p=>publicProposal(db,p))};
}
export function proposal(db,user,id,proposalId){
 proposalAccess(db,user,id);
 const p=db.prepare('SELECT * FROM amendment_proposals WHERE id=? AND reservation_id=?').get(proposalId,id);
 need(p,'换装草案不存在',404);
 return publicProposal(db,p);
}
export function createProposal(db,user,id,input,requestKey){
 need(user&&['staff','manager'].includes(user.role),'仅本店人员可提出换装草案',403);
 need(typeof requestKey==='string'&&/^[A-Za-z0-9._:-]{16,128}$/.test(requestKey),'提出换装草案须提供有效 Idempotency-Key',428);
 need(input&&typeof input==='object'&&!Array.isArray(input),'换装草案内容应为对象');
 return transaction(db,()=>{
  const order=proposalAccess(db,user,id),returnStoreId=Number(input.returnStoreId)||order.store_id;
  need(returnStoreId===user.store_id,'换装归还门店须为当前经办门店',403);
  const normalized={removeUnitIds:input.removeUnitIds||[],addItems:input.addItems||[],effectiveAt:input.effectiveAt||null,returnStoreId};
  const payloadHash=hash({reservationId:id,...normalized});
  const prior=db.prepare('SELECT * FROM amendment_proposals WHERE created_by=? AND request_key=?').get(user.id,requestKey);
  if(prior){need(prior.payload_hash===payloadHash,'提交标识已用于不同换装草案',409);return {...publicProposal(db,prior),replayed:true};}
  const quote=amendmentQuote(db,user,id,normalized);
  const active=db.prepare("SELECT * FROM amendment_proposals WHERE reservation_id=? AND status IN ('PENDING','CONFIRMED') ORDER BY id DESC").all(id);
  need(!active.some(p=>p.status==='CONFIRMED'&&proposalStatus(p)!=='EXPIRED'),'已确认的换装草案尚有效，不能由门店直接覆盖',409);
  db.prepare("UPDATE amendment_proposals SET status='SUPERSEDED' WHERE reservation_id=? AND status='PENDING' AND expires_at>?").run(id,now());
  const createdAt=now(),expiresAt=new Date(Math.min(Date.parse(createdAt)+300000,Date.parse(quote.effectiveAt)+300000)).toISOString();
  need(Date.parse(expiresAt)>Date.parse(createdAt),'差价预览已过期，请重新计算',409);
  normalized.effectiveAt=quote.effectiveAt;
  const result=db.prepare(`INSERT INTO amendment_proposals(reservation_id,created_by,request_key,payload_hash,base_version,quote_hash,quote_json,input_json,return_store_id,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,user.id,requestKey,payloadHash,quote.baseVersion,quote.quoteHash,JSON.stringify(quote),JSON.stringify(normalized),returnStoreId,createdAt,expiresAt);
  const proposalId=Number(result.lastInsertRowid);
  audit(db,user.id,'AMENDMENT_PROPOSED','reservation',id,{proposalId,quoteHash:quote.quoteHash,baseVersion:quote.baseVersion});
  notify(db,order.user_id,'换装方案待本人确认',`订单 ${order.code} 的换装方案已提出。请在有效期内查看退增装备及 NOK 差价，确认或拒绝。`);
  return publicProposal(db,db.prepare('SELECT * FROM amendment_proposals WHERE id=?').get(proposalId));
 });
}
export function confirmProposal(db,user,id,proposalId,input){
 need(user?.role==='customer','只有订单顾客本人可确认换装草案',403);
 return transaction(db,()=>{
  const order=proposalAccess(db,user,id),p=db.prepare('SELECT * FROM amendment_proposals WHERE id=? AND reservation_id=?').get(proposalId,id);
  need(p,'换装草案不存在',404);
  need(typeof input?.accepted==='boolean','请明确确认或拒绝换装草案');
  need(Number(input.baseVersion)===p.base_version&&input.quoteHash===p.quote_hash,'换装草案版本或内容已变化，请重新查看',409);
  need(order.status==='ACTIVE'&&order.contract_version===p.base_version,'合同状态或版本已变化，请重新提出方案',409);
  need(proposalStatus(p)!=='EXPIRED','换装草案已过期，请重新提出',409);
  if(p.status==='CONFIRMED'&&input.accepted===true||p.status==='REJECTED'&&input.accepted===false)return publicProposal(db,p);
  need(p.status==='PENDING','该换装草案已处理，不能再次确认',409);
  const at=now(),status=input.accepted?'CONFIRMED':'REJECTED';
  db.prepare(`UPDATE amendment_proposals SET status=?,confirmed_by=?,confirmed_at=?,rejected_by=?,rejected_at=? WHERE id=?`)
    .run(status,input.accepted?user.id:null,input.accepted?at:null,input.accepted?null:user.id,input.accepted?null:at,p.id);
  audit(db,user.id,input.accepted?'AMENDMENT_CONFIRMED_BY_CUSTOMER':'AMENDMENT_REJECTED_BY_CUSTOMER','reservation',id,{proposalId:p.id,quoteHash:p.quote_hash,baseVersion:p.base_version});
  notify(db,p.created_by,input.accepted?'顾客已确认换装':'顾客已拒绝换装',`订单 ${order.code} 的换装草案 #${p.id} 已由顾客本人${input.accepted?'确认':'拒绝'}。`);
  return publicProposal(db,db.prepare('SELECT * FROM amendment_proposals WHERE id=?').get(p.id));
 });
}
export function amendmentQuote(db,user,id,input){
 need(user&&['staff','manager'].includes(user.role),'仅门店人员可办理换装增减项',403);const o=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);need(o&&o.store_id===user.store_id,'订单不存在或无权访问',404);need(o.status==='ACTIVE','仅有效租赁可办理换装',409);need(Date.parse(o.return_at)>Date.now(),'已逾期合同请先归还处理，不能继续换装',409);
 const floor=Math.max(Date.now(),Date.parse(o.pickup_at)),at=input.effectiveAt?Date.parse(input.effectiveAt):floor;need(Number.isFinite(at)&&Math.abs(at-floor)<5*60000,'差价预览已过期，请重新计算',409);
 const remove=Array.isArray(input.removeUnitIds)?input.removeUnitIds.map(Number):[],add=Array.isArray(input.addItems)?input.addItems:[];need(remove.length||add.length,'请至少选择一项增减');need(new Set(remove).size===remove.length&&remove.length<=30&&add.length<=12,'增减项参数无效');
 const rented=db.prepare(`SELECT ru.*,ri.variant_id,ri.unit_rent_nok,ri.unit_deposit_nok,ri.rental_from,ri.rental_to,u.inventory_no,v.name FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id JOIN units u ON u.id=ru.unit_id JOIN variants v ON v.id=ri.variant_id WHERE ri.reservation_id=? AND ru.returned=0`).all(id);
 need(remove.every(unit=>rented.some(r=>r.unit_id===unit)),'只能移除本合同尚未归还的单件',409);need(rented.length-remove.length+add.reduce((n,a)=>n+Number(a.qty||0),0)>0,'全部归还请走归还验收，不要使用换装流程');
 const removed=remove.map(id=>{const r=rented.find(r=>r.unit_id===id),span=Math.max(3600000,Date.parse(r.rental_to||o.return_at)-Date.parse(r.rental_from||o.pickup_at)),fraction=Math.min(1,Math.max(0,(Date.parse(o.return_at)-at)/span));return {unitId:id,inventoryNo:r.inventory_no,name:r.name,rentCreditNok:Math.round(r.unit_rent_nok*fraction),depositCreditNok:r.unit_deposit_nok};});
 const remainingDays=Math.max(1,Math.ceil((Date.parse(o.return_at)-at)/86400000)),available=availability(db,o.store_id,new Date(at).toISOString(),o.return_at),counts=new Map(),added=[];
 for(const a of add){const v=Number(a.variantId),qty=Number(a.qty);need(Number.isSafeInteger(v)&&Number.isSafeInteger(qty)&&qty>=1&&qty<=5,'新增数量须为1–5');counts.set(v,(counts.get(v)||0)+qty);}
 for(const[variantId,qty]of counts){const v=db.prepare('SELECT * FROM variants WHERE id=? AND active=1').get(variantId),p=policyFor(db,variantId,o.store_id,new Date(at).toISOString());need(v&&p,'规格未启用或无已批准价目',409);need(qty<=(available.get(variantId)||0),'剩余租期可订量不足',409);const rent=Math.round(p.daily_nok*(1+(remainingDays-1)*p.extra_day_factor)),deposit=depositFor(v,rent);added.push({variantId,name:v.name,size:v.size,qty,unitRentNok:rent,unitDepositNok:deposit,policyId:p.id,policyVersion:p.version,rentNok:rent*qty,depositNok:deposit*qty});}
 const rentDeltaNok=added.reduce((n,a)=>n+a.rentNok,0)-removed.reduce((n,r)=>n+r.rentCreditNok,0),depositDeltaNok=added.reduce((n,a)=>n+a.depositNok,0)-removed.reduce((n,r)=>n+r.depositCreditNok,0);
 need(o.rent_nok+rentDeltaNok>=0&&o.deposit_nok+depositDeltaNok>=0,'当前合同余额不足以办理此变更',409);
 const result={reservationId:id,baseVersion:o.contract_version,effectiveAt:new Date(at).toISOString(),remainingDays,removed,added,rentDeltaNok,depositDeltaNok,netNok:rentDeltaNok+depositDeltaNok,currency:'NOK',rule:'演示换装：完好退回项按剩余租期占原计费区间比例退租金，返还该件押金；新增项按剩余天数现行门店价目及8%参考价押金计收。任何损坏项须另走归还鉴定，不可标记完好绕过。'};return {...result,quoteHash:hash(result)};
}
export function commitAmendment(db,user,id,input){need(user&&['staff','manager'].includes(user.role),'无权办理换装',403);return transaction(db,()=>{
 const authorized=db.prepare('SELECT store_id FROM reservations WHERE id=?').get(id);need(authorized&&authorized.store_id===user.store_id,'订单不存在或无权访问',404);
 const proposalId=Number(input?.proposalId);need(Number.isSafeInteger(proposalId)&&proposalId>0,'换装前须由顾客本人确认草案',409);
 const proposal=db.prepare('SELECT * FROM amendment_proposals WHERE id=? AND reservation_id=?').get(proposalId,id);need(proposal,'换装草案不存在',404);
 const reference=String(input.reference||'').trim();need(reference.length>=5&&reference.length<=100,'请填写唯一演示收退凭证（5–100字）');const duplicate=db.prepare('SELECT * FROM contract_adjustments WHERE reservation_id=? AND reference=?').get(id,reference);if(duplicate){need(duplicate.proposal_id===proposalId&&JSON.parse(duplicate.detail_json).quoteHash===input.quoteHash,'凭证已用于不同变更',409);return {duplicate:true,id:duplicate.id};}
 need(proposal.status==='CONFIRMED'&&proposalStatus(proposal)!=='EXPIRED','请先由顾客本人确认仍有效的换装草案',409);
 const order=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
 need(proposal.confirmed_by===order.user_id&&order.contract_version===proposal.base_version,'顾客确认或合同版本已变化，请重新提出草案',409);
 const frozen=JSON.parse(proposal.input_json);
 need((input.quoteHash===undefined||input.quoteHash===proposal.quote_hash)&&
   (input.baseVersion===undefined||Number(input.baseVersion)===proposal.base_version)&&
   (input.effectiveAt===undefined||input.effectiveAt===frozen.effectiveAt)&&
   (input.returnStoreId===undefined||Number(input.returnStoreId)===frozen.returnStoreId)&&
   (input.removeUnitIds===undefined||JSON.stringify(input.removeUnitIds)===JSON.stringify(frozen.removeUnitIds))&&
   (input.addItems===undefined||JSON.stringify(input.addItems)===JSON.stringify(frozen.addItems)),
   '提交内容与顾客确认的草案不一致',409);
 const q=amendmentQuote(db,user,id,frozen);
 need(q.baseVersion===proposal.base_version&&q.quoteHash===proposal.quote_hash,'合同或差价已变化，请重新预览并请顾客确认',409);
 need(input.paperSigned===true&&input.goodReturnConfirmed===true&&(!q.added.length||input.newItemsChecked===true),'请确认退回项完好、新增项检查完成，并先取得顾客纸质变更签署');const signedName=String(input.customerName||'').trim(),note=String(input.note||'').trim();need(signedName.length>=2&&note.length>=5,'请填写顾客签署姓名及办理说明');
 const o=db.prepare('SELECT * FROM reservations WHERE id=?').get(id),at=new Date().toISOString(),returnStore=Number(input.returnStoreId)||o.store_id;need(returnStore===user.store_id,'换装归还门店须为当前经办门店',403);need(db.prepare('SELECT id FROM stores WHERE id=?').get(returnStore),'归还门店无效');
 for(const r of q.removed){db.prepare('UPDATE rental_units SET returned=1,returned_at=?,return_store_id=? WHERE unit_id=? AND reservation_item_id IN(SELECT id FROM reservation_items WHERE reservation_id=?)').run(at,returnStore,r.unitId,id);db.prepare("UPDATE units SET status='AVAILABLE',store_id=?,condition_note='合同换装：完好验收退回' WHERE id=?").run(returnStore,r.unitId);db.prepare("INSERT INTO inspections(reservation_id,unit_id,condition,note,fee_nok,approved,inspected_by,created_at) VALUES(?,?,'GOOD','换装退回，已逐件核对完好',0,1,?,?)").run(id,r.unitId,user.id,at);}
 for(const a of q.added){const units=db.prepare(`SELECT u.id FROM units u WHERE variant_id=? AND store_id=? AND status='AVAILABLE' AND needs_cleaning=0 AND NOT EXISTS(SELECT 1 FROM preparation_units pu WHERE pu.unit_id=u.id AND pu.active=1) AND NOT EXISTS(SELECT 1 FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id WHERE ri.reservation_id=? AND ru.unit_id=u.id) ORDER BY u.id LIMIT ?`).all(a.variantId,o.store_id,id,a.qty);need(units.length===a.qty,'新增实物不足或正在为其他订单准备，请重新协调',409);
  const line=Number(db.prepare('INSERT INTO reservation_items(reservation_id,variant_id,qty,unit_rent_nok,unit_deposit_nok,policy_id,rental_from,rental_to) VALUES(?,?,?,?,?,?,?,?)').run(id,a.variantId,a.qty,a.unitRentNok,a.unitDepositNok,a.policyId,q.effectiveAt,o.return_at).lastInsertRowid);
  for(const u of units){db.prepare("UPDATE units SET status='RENTED',condition_note='合同变更新增交付，已现场检查' WHERE id=?").run(u.id);db.prepare('INSERT INTO rental_units(reservation_item_id,unit_id,out_at) VALUES(?,?,?)').run(line,u.id,at);}
 }
 const result=db.prepare('INSERT INTO contract_adjustments(reservation_id,reference,base_version,rent_delta_nok,deposit_delta_nok,detail_json,created_by,created_at,proposal_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id,reference,q.baseVersion,q.rentDeltaNok,q.depositDeltaNok,JSON.stringify(q),user.id,at,proposalId);
 db.prepare('UPDATE reservations SET rent_nok=rent_nok+?,deposit_nok=deposit_nok+?,total_nok=total_nok+? WHERE id=?').run(q.rentDeltaNok,q.depositDeltaNok,q.netNok,id);
 const contractId=writeContract(db,id,user.id);db.prepare("UPDATE contracts SET signed_by=?,signed_name=?,signed_at=?,signature_method='PAPER_WITNESS',signature_note=? WHERE id=?").run(user.id,signedName,at,note,contractId);
 db.prepare("UPDATE amendment_proposals SET status='CONSUMED',consumed_at=?,consumed_adjustment_id=? WHERE id=?").run(at,Number(result.lastInsertRowid),proposalId);
 audit(db,user.id,'CONTRACT_AMENDED','reservation',id,{adjustmentId:Number(result.lastInsertRowid),proposalId,quote:q,reference,signatureWitness:note});notify(db,o.user_id,'租赁变更与差价已登记',`订单 ${o.code} 已办理增减/换装，${q.netNok>=0?'演示补收':'演示退回'} NOK ${Math.abs(q.netNok)}。原合同保留，最新版本可在订单查看。`);return {id:Number(result.lastInsertRowid),quote:q,contract:contracts(db,user,id)[0],demo:true};
 });}
