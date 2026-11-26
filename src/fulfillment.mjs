import {createHash} from 'node:crypto';
import {DomainError,transaction} from './domain.mjs';
import {audit,notify} from './db.mjs';
import {isShowcaseSource,simulated,simulationNotice} from './simulation.mjs';
const need=(ok,msg,status=400)=>{if(!ok)throw new DomainError(msg,status);};
const now=()=>new Date().toISOString();
export const preparationLabels={QUEUED:'待接单',PICKING:'正在拣货',CHECKING:'清洁与安全检查',BLOCKED:'异常待协调',READY:'装备已备妥',HANDED_OVER:'已交付',CANCELLED:'已取消'};
function access(db,user,id){const o=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);need(o&&user&&(user.role==='customer'?o.user_id===user.id:['staff','manager'].includes(user.role)&&user.store_id===o.store_id),'订单不存在或无权访问',404);return o;}
export function preparation(db,user,id){
 access(db,user,id);const p=db.prepare('SELECT p.*,u.name AS handler_name FROM preparations p LEFT JOIN users u ON u.id=p.assigned_to WHERE reservation_id=?').get(id);if(!p)return null;
 return {...p,label:preparationLabels[p.status],units:db.prepare(`SELECT pu.*,u.inventory_no,u.status AS stock_status,v.name,v.size FROM preparation_units pu JOIN units u ON u.id=pu.unit_id JOIN variants v ON v.id=u.variant_id WHERE pu.reservation_id=? AND pu.active=1 ORDER BY pu.item_id,pu.unit_id`).all(id),events:db.prepare(`SELECT e.*,u.name AS actor_name FROM preparation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE reservation_id=? ORDER BY e.id`).all(id)};
}
export function preparationList(db,user){need(user&&['staff','manager'].includes(user.role)&&user.store_id,'无权查看准备队列',403);return db.prepare("SELECT r.id,r.code,r.pickup_at,r.return_at,r.store_id,r.status AS order_status,u.name AS customer_name,s.name AS store_name FROM reservations r JOIN preparations p ON p.reservation_id=r.id JOIN users u ON u.id=r.user_id JOIN stores s ON s.id=r.store_id WHERE r.store_id=? AND p.status<>'CANCELLED' ORDER BY CASE p.status WHEN 'BLOCKED' THEN 0 WHEN 'QUEUED' THEN 1 WHEN 'PICKING' THEN 2 WHEN 'CHECKING' THEN 3 WHEN 'READY' THEN 4 ELSE 5 END,r.pickup_at").all(user.store_id).map(o=>({...o,...preparation(db,user,o.id),id:o.id,lines:db.prepare('SELECT ri.qty,v.name,v.size FROM reservation_items ri JOIN variants v ON v.id=ri.variant_id WHERE reservation_id=?').all(o.id)}));}
function prepEvent(db,id,user,status,note){db.prepare('INSERT INTO preparation_events(reservation_id,actor_id,status,note,created_at) VALUES(?,?,?,?,?)').run(id,user.id,status,note,now());audit(db,user.id,'PREPARATION_'+status,'reservation',id,{note});}
export function updatePreparation(db,user,id,input){
 need(['staff','manager'].includes(user.role),'仅租赁专员或经理可准备装备',403);
 return transaction(db,()=>{
  const o=access(db,user,id);need(['CONFIRMED','READY'].includes(o.status),'仅已付款待交付订单可准备',409);
  const p=db.prepare('SELECT * FROM preparations WHERE reservation_id=?').get(id);need(p,'准备单不存在',404);need(Number(input.version)===p.version,'准备信息已更新，请重新打开最新版本',409);
  need(!['HANDED_OVER','CANCELLED'].includes(p.status),'准备单已关闭',409);let status=p.status,note=String(input.note||'').trim().slice(0,1000);
  if(input.action==='claim'){
   need(user.role==='manager'||!p.assigned_to||p.assigned_to===user.id,'该准备单由其他同事负责，请经理重新指派',409);
   const handler=Number(input.assignedTo)||user.id;need(db.prepare("SELECT id FROM users WHERE id=? AND store_id=? AND role IN ('staff','manager')").get(handler,o.store_id),'处理人无效');need(user.role==='manager'||handler===user.id,'只有经理可转派',403);
   db.prepare('UPDATE preparations SET assigned_to=? WHERE reservation_id=?').run(handler,id);db.prepare('UPDATE reservations SET assigned_staff_id=? WHERE id=?').run(handler,id);status=p.status==='QUEUED'?'PICKING':p.status;note=note||'已接单，开始按尺码准备';
  }else{
   need(p.assigned_to===user.id||user.role==='manager','仅当前处理人或经理可更新',403);
   if(input.action==='pick'){
    need(['PICKING','BLOCKED'].includes(p.status),'请先接单或重新准备',409);db.prepare('UPDATE preparation_units SET active=0 WHERE reservation_id=?').run(id);
    for(const line of db.prepare('SELECT * FROM reservation_items WHERE reservation_id=?').all(id)){
     const units=db.prepare(`SELECT id FROM units u WHERE variant_id=? AND store_id=? AND status='AVAILABLE' AND needs_cleaning=0 AND NOT EXISTS(SELECT 1 FROM preparation_units pu WHERE pu.unit_id=u.id AND pu.active=1) ORDER BY id LIMIT ?`).all(line.variant_id,o.store_id,line.qty);
     need(units.length===line.qty,'可拣选的实物不足或需清洁，请先协调库存',409);
     for(const u of units)db.prepare(`INSERT INTO preparation_units(reservation_id,item_id,unit_id,active) VALUES(?,?,?,1) ON CONFLICT(reservation_id,unit_id) DO UPDATE SET active=1,item_id=excluded.item_id,size_checked=0,clean_checked=0,safety_checked=0`).run(id,line.id,u.id);
    }status='CHECKING';note=note||'实物拣选完成，正在逐件检查';
   }else if(input.action==='check'){
    need(p.status==='CHECKING','当前不是逐件检查阶段',409);const units=db.prepare('SELECT unit_id FROM preparation_units WHERE reservation_id=? AND active=1').all(id);
    need(Array.isArray(input.units)&&input.units.length===units.length&&new Set(input.units.map(u=>Number(u.unitId))).size===units.length,'请逐件核对全部实物');
    for(const u of units){const c=input.units.find(c=>Number(c.unitId)===u.unit_id);need(c,'实物编号不一致');db.prepare('UPDATE preparation_units SET size_checked=?,clean_checked=?,safety_checked=? WHERE reservation_id=? AND unit_id=?').run(c.size===true?1:0,c.clean===true?1:0,c.safety===true?1:0,id,u.unit_id);}note=note||'已保存尺码、清洁与安全检查记录';
   }else if(input.action==='ready'){
    need(p.status==='CHECKING','请先完成拣货和检查',409);const units=db.prepare('SELECT pu.*,u.status AS stock_status,u.needs_cleaning,u.store_id FROM preparation_units pu JOIN units u ON u.id=pu.unit_id WHERE reservation_id=? AND active=1').all(id);
    const count=db.prepare('SELECT SUM(qty) AS n FROM reservation_items WHERE reservation_id=?').get(id).n;
    need(units.length===count&&units.every(u=>u.size_checked&&u.clean_checked&&u.safety_checked&&u.stock_status==='AVAILABLE'&&!u.needs_cleaning&&u.store_id===o.store_id),'必须逐件确认尺码、清洁、安全和实物可用',409);status='READY';note=note||'装备已备妥，请按约定时间到店核验取走';
    db.prepare("UPDATE reservations SET status='READY' WHERE id=?").run(id);notify(db,o.user_id,'装备已备妥',`订单 ${o.code} 已由 ${user.name} 准备完成。请按预约时间到店出示取货码。`);
   }else if(input.action==='block'||input.action==='restart'){
    need(note.length>=3,'请填写至少3字的公开说明');status=input.action==='block'?'BLOCKED':'PICKING';db.prepare('UPDATE preparation_units SET active=0 WHERE reservation_id=?').run(id);db.prepare("UPDATE reservations SET status='CONFIRMED' WHERE id=?").run(id);
   }else throw new DomainError('准备操作无效');
  }
  const at=now();db.prepare('UPDATE preparations SET status=?,public_note=?,version=version+1,updated_at=?,ready_at=? WHERE reservation_id=?').run(status,note,at,status==='READY'?at:null,id);prepEvent(db,id,user,status,note);
  if(status!=='READY')notify(db,o.user_id,'装备准备进度',`订单 ${o.code}：${preparationLabels[status]}；${user.name}：${note}`);
  return preparation(db,user,id);
 });
}
export function blockAllocatedUnit(db,user,unitId,note){
 const p=db.prepare('SELECT pu.reservation_id,r.store_id FROM preparation_units pu JOIN reservations r ON r.id=pu.reservation_id WHERE pu.unit_id=? AND pu.active=1').get(unitId);if(!p)return;
 need(user&&['staff','manager'].includes(user.role)&&user.store_id===p.store_id,'无权修改其他门店的准备单',403);
 db.prepare('UPDATE preparation_units SET active=0 WHERE reservation_id=?').run(p.reservation_id);db.prepare("UPDATE preparations SET status='BLOCKED',public_note=?,version=version+1,updated_at=?,ready_at=NULL WHERE reservation_id=?").run(note,now(),p.reservation_id);db.prepare("UPDATE reservations SET status='CONFIRMED' WHERE id=? AND status='READY'").run(p.reservation_id);prepEvent(db,p.reservation_id,user,'BLOCKED',note);
 const o=db.prepare('SELECT user_id,code FROM reservations WHERE id=?').get(p.reservation_id);notify(db,o.user_id,'准备异常，门店正在协调',`订单 ${o.code}：${note}`);
}
export function contracts(db,user,id){access(db,user,id);const synthetic=isShowcaseSource(db);return db.prepare(`SELECT c.*,u.name AS creator_name FROM contracts c JOIN users u ON u.id=c.created_by WHERE reservation_id=? ORDER BY version DESC`).all(id).map(c=>{
  const result={...c,snapshot:JSON.parse(c.snapshot_json),snapshot_json:undefined};
  return synthetic?simulated(result):result;
});}
function contractLines(db,id){
 const lines=db.prepare('SELECT ri.*,v.name,v.size,v.serialized,p.daily_nok FROM reservation_items ri JOIN variants v ON v.id=ri.variant_id JOIN price_policies p ON p.id=ri.policy_id WHERE ri.reservation_id=?').all(id);
 return lines.flatMap(l=>{const units=db.prepare('SELECT u.id,u.inventory_no FROM units u JOIN preparation_units pu ON pu.unit_id=u.id WHERE pu.item_id=? AND pu.active=1 ORDER BY u.id').all(l.id);const handed=db.prepare('SELECT u.id,u.inventory_no FROM units u JOIN rental_units ru ON ru.unit_id=u.id WHERE ru.reservation_item_id=? ORDER BY u.id').all(l.id);const linked=handed.length?handed:units;
  return l.serialized?Array.from({length:l.qty},(_,i)=>({...l,qty:1,unitId:linked[i]?.id||null,inventoryNo:linked[i]?.inventory_no||null})): [{...l,inventoryNos:linked.map(u=>u.inventory_no)}];});
}
export function contractSnapshot(db,id,employeeId,channel='COUNTER_MANUAL'){
 const o=db.prepare(`SELECT r.*,s.name AS store_name,u.name AS customer_name,u.email,u.phone,u.address,u.birth_year,u.height_cm,u.weight_kg,u.shoe_size FROM reservations r JOIN stores s ON s.id=r.store_id JOIN users u ON u.id=r.user_id WHERE r.id=?`).get(id);
 const employee=db.prepare('SELECT id,name FROM users WHERE id=?').get(employeeId);
 const customer=o.customer_snapshot?JSON.parse(o.customer_snapshot):{name:o.customer_name,email:o.email,phone:o.phone,address:o.address,birthYear:o.birth_year,heightCm:o.height_cm,weightKg:o.weight_kg,shoeSize:o.shoe_size};
 const latePolicy=o.late_policy_version?{version:o.late_policy_version,hourlyPercent:o.late_hourly_percent,graceMinutes:o.late_grace_minutes,currency:'NOK'}:null;
 const lateTerms=latePolicy?`约定归还日 16:00 前逐件归还，本单${latePolicy.graceMinutes?'享首次有效租赁前 2 小时免费宽限':'无首租宽限'}；超出宽限后，每件按其日租金 ${latePolicy.hourlyPercent}%／开始的一小时计，不足一小时按一小时计，每连续 24 小时封顶一天日租金。实际费用按每件归还时刻核定，并与核定损坏费分别列示后合计抵扣押金。`:'本历史合同未约定新版超时收费，不自动追溯。';
 const snapshot={reservationId:id,orderCode:o.code,customerId:o.user_id,customer,skill:o.customer_skill||'历史未登记',employee,channel,store:o.store_name,pickupAt:o.pickup_at,returnAt:o.return_at,days:Math.ceil((Date.parse(o.return_at)-Date.parse(o.pickup_at))/86400000),currency:'NOK',rentNok:o.rent_nok,depositNok:o.deposit_nok,totalNok:o.total_nok,latePolicy,lines:contractLines(db,id),adjustments:db.prepare('SELECT id,rent_delta_nok,deposit_delta_nok,created_at FROM contract_adjustments WHERE reservation_id=?').all(id),terms:`课程演示合同。唯一单件逐行数量为1，非序列化同类物品可合并数量；实际编号和借还时间见交接附页。新订单押金按规格参考价值8%计，按整数NOK四舍五入。${lateTerms} 正常磨损不收费；损坏须凭照片鉴定、店员资料复核与经理核价。超押金须联系补差，不自动追加扣款。部分归还仍保留剩余押金至全单归还与异常闭环。支付、退款、签署记录均为本地演示，不代表真实银行交易或合格电子签章。`};
 return isShowcaseSource(db)?simulated({...snapshot,
   terms:snapshot.terms.replace('课程演示合同','课程合成预览模拟合同')}):snapshot;
}
export function writeContract(db,id,employeeId,originId=employeeId){
 const version=(db.prepare('SELECT contract_version FROM reservations WHERE id=?').get(id).contract_version||0)+1,
  channel=originId===employeeId?'COUNTER_MANUAL':'ONLINE_SELF_SERVICE',snapshot=contractSnapshot(db,id,employeeId,channel),json=JSON.stringify(snapshot),hash=createHash('sha256').update(json).digest('hex'),at=now();
 db.prepare('INSERT INTO contracts(reservation_id,code,version,created_by,created_at,snapshot_json,snapshot_hash) VALUES(?,?,?,?,?,?,?)').run(id,`CT-${String(id).padStart(6,'0')}-V${version}`,version,originId,at,json,hash);
 db.prepare('UPDATE reservations SET contract_version=?,created_by=COALESCE(created_by,?) WHERE id=?').run(version,originId===employeeId?employeeId:null,id);return db.prepare('SELECT id FROM contracts WHERE reservation_id=? AND version=?').get(id,version).id;
}
export function issueContract(db,user,id){need(['customer','staff','manager'].includes(user.role),'无权开具合同',403);return transaction(db,()=>{const o=access(db,user,id);need(user.role==='customer'?o.status==='HOLD':['HOLD','CONFIRMED','READY'].includes(o.status),'此状态不能首次开具合同',409);need(o.status!=='HOLD'||Date.parse(o.hold_expires_at)>Date.now(),'预约暂留已过期，请重新预约',409);need(!o.contract_version,'合同已存在；请查看当前版本',409);const employeeId=user.role==='customer'?o.assigned_staff_id:user.id;need(employeeId&&db.prepare("SELECT id FROM users WHERE id=? AND role IN ('staff','manager')").get(employeeId),'门店尚未分配经办员工，请联系门店后重试',409);writeContract(db,id,employeeId,user.id);audit(db,user.id,user.role==='customer'?'CONTRACT_REQUESTED_ONLINE':'CONTRACT_ISSUED','reservation',id,{employeeId});return contracts(db,user,id)[0];});}
export function signContract(db,user,contractId,input){return transaction(db,()=>{
 const c=db.prepare('SELECT * FROM contracts WHERE id=?').get(contractId);need(c,'合同不存在',404);const o=access(db,user,c.reservation_id);need(['HOLD','CONFIRMED','READY'].includes(o.status),'此订单已交付或关闭，不能追加签署旧合同',409);need(c.version===o.contract_version,'只能签署最新合同版本',409);need(!c.signed_at,'此合同已签署',409);need(input.accepted===true&&input.snapshotHash===c.snapshot_hash,'请阅读当前合同快照并主动确认');
 need(o.status!=='HOLD'||Date.parse(o.hold_expires_at)>Date.now(),'预约暂留已过期，不能继续签署',409);
 const method=user.role==='customer'?'CUSTOMER_ACK':'PAPER_WITNESS';need(user.role==='customer'||['staff','manager'].includes(user.role),'无权签署合同',403);const name=String(input.name||'').trim();need(name.length>=2&&name.length<=100,'请填写签署人姓名');
 if(method==='PAPER_WITNESS')need(input.paperSigned===true&&String(input.note||'').trim().length>=5,'请先见证顾客签署纸质合同，并记录见证说明');
 db.prepare('UPDATE contracts SET signed_by=?,signed_name=?,signed_at=?,signature_method=?,signature_note=? WHERE id=?').run(user.id,name,now(),method,String(input.note||'').slice(0,1000),c.id);audit(db,user.id,'CONTRACT_SIGNED','reservation',o.id,{contractId:c.id,method,hash:c.snapshot_hash});notify(db,o.user_id,'合同签署已记录',`合同 ${c.code} 已记录${method==='CUSTOMER_ACK'?'本人电子确认':'门店纸质签署见证'}，仅课程演示。`);return contracts(db,user,o.id)[0];
 });}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function printableContract(db,user,id){
 const c=db.prepare('SELECT * FROM contracts WHERE id=?').get(id);need(c,'合同不存在',404);access(db,user,c.reservation_id);const s=JSON.parse(c.snapshot_json);
 const rows=db.prepare('SELECT ru.*,u.inventory_no,v.name,st.name AS return_store FROM rental_units ru JOIN units u ON u.id=ru.unit_id JOIN variants v ON v.id=u.variant_id JOIN reservation_items ri ON ri.id=ru.reservation_item_id LEFT JOIN stores st ON st.id=ru.return_store_id WHERE ri.reservation_id=?').all(c.reservation_id);
 const syntheticBanner=isShowcaseSource(db)?`<div class="notice" style="border:2px solid #be8c45;margin:0 0 22px"><strong>合成预览 · 模拟合同</strong><br>${esc(simulationNotice)}</div>`:'';
return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(c.code)} · BSR租赁合同</title><style>body{font:14px/1.7 system-ui,sans-serif;color:#243e40;max-width:900px;margin:35px auto;padding:20px}h1{font-size:28px;border-bottom:3px solid #68a7a3}h2{font-size:18px;margin-top:26px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #d9e6e3;padding:9px}small{color:#587171}.notice{background:#edf6f3;padding:15px} @media print{body{margin:0;max-width:none;padding:0}tr{break-inside:avoid}}</style>${syntheticBanner}<h1>BSR · 滑雪装备租赁合同</h1><p>${esc(c.code)} · 合同日期 ${esc(c.created_at)} · 版本 ${c.version}</p><p>顾客 #${s.customerId} ${esc(s.customer.name)} · ${esc(s.customer.email)} · ${esc(s.customer.phone)}<br>地址：${esc(s.customer.address||'历史未登记')}<br>出生年：${esc(s.customer.birthYear||'历史未登记')} · 身高 ${esc(s.customer.heightCm||'—')} cm · 体重 ${esc(s.customer.weightKg||'—')} kg · 鞋码 ${esc(s.customer.shoeSize||'—')} · 本次滑雪水平 ${esc(s.skill)}</p><p>发起方式：${s.channel==='ONLINE_SELF_SERVICE'?'顾客线上自助':'门店人工开具'} · 门店经办：${esc(s.employee?.name||'历史未登记')} #${esc(s.employee?.id||'—')} · 门店 ${esc(s.store)}<br>租期 ${s.days} 天 · ${esc(s.pickupAt)} 至 ${esc(s.returnAt)}</p><table><thead><tr><th>装备 / 尺码</th><th>数量</th><th>日租金 NOK</th><th>本次租金 NOK</th><th>押金 NOK</th></tr></thead><tbody>${s.lines.map(l=>`<tr><td>${esc(l.name)} / ${esc(l.size)}</td><td>${l.qty}</td><td>${l.daily_nok}</td><td>${l.unit_rent_nok*l.qty}</td><td>${l.unit_deposit_nok*l.qty}</td></tr>`).join('')}</tbody></table><p>含历史增减项的当前合同净额：租金 NOK ${s.rentNok} + 可退押金 NOK ${s.depositNok} = NOK ${s.totalNok}</p>${s.adjustments.length?`<h2>累计变更收退记录</h2>${s.adjustments.map(a=>`<p>#${a.id} 租金差额 ${a.rent_delta_nok} NOK；押金差额 ${a.deposit_delta_nok} NOK；${esc(a.created_at)}</p>`).join('')}`:''}<div class="notice">${esc(s.terms)}</div><h2>签署记录</h2><p>${c.signed_at?`${esc(c.signed_name)} · ${esc(c.signature_method)} · ${esc(c.signed_at)}`:'顾客签名：__________________ 日期：____________'}</p><p>门店经办签名：__________________</p><small>不可变合同快照 SHA-256：${esc(c.snapshot_hash)}</small><h2>单件交接附页（截至打印时，非原签署快照）</h2><table><tr><th>单件编号</th><th>装备</th><th>借出</th><th>归还</th><th>归还门店</th></tr>${rows.map(r=>`<tr><td>${esc(r.inventory_no)}</td><td>${esc(r.name)}</td><td>${esc(r.out_at||'未登记')}</td><td>${esc(r.returned_at||'尚未归还')}</td><td>${esc(r.return_store||'—')}</td></tr>`).join('')}</table></html>`;
}
