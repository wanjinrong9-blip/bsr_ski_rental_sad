import {DomainError,transaction} from './domain.mjs';
import {audit,notify} from './db.mjs';
import {damagePolicy} from './damage-policy.mjs';
import {orderWorkflow} from './order-workflow.mjs';
const need=(ok,message,status=400)=>{if(!ok)throw new DomainError(message,status);};
const time=()=>new Date().toISOString();
const money=value=>{const n=Number(value);need(Number.isSafeInteger(n)&&n>=0&&n<=1000000,'金额须为 0–1,000,000 的整数 NOK');return n;};
const text=(value,min,max,label)=>{const s=String(value||'').trim();need(s.length>=min&&s.length<=max,`${label}须为 ${min}–${max} 字`);return s;};

function access(db,user,id){
  const row=db.prepare(`SELECT c.*,r.code,r.user_id,r.store_id,r.status AS order_status,u.inventory_no,v.name AS equipment,s.name AS store_name,
    a.name AS assessor_name FROM damage_cases c JOIN reservations r ON r.id=c.reservation_id JOIN units u ON u.id=c.unit_id
    JOIN variants v ON v.id=u.variant_id JOIN stores s ON s.id=r.store_id LEFT JOIN users a ON a.id=c.assessor_id WHERE c.id=?`).get(id);
  need(row&&user&&(user.role==='customer'?row.user_id===user.id:user.role==='contractor'?row.assessor_id===user.id:['staff','manager'].includes(user.role)&&user.store_id===row.store_id),'鉴定单不存在或无权访问',404);
  return row;
}
function editable(row,user,input){
  need(user.role==='contractor'&&row.assessor_id===user.id,'仅负责此单的维修技师可鉴定或上传照片',403);
  need(['DRAFT','RETURNED'].includes(row.status),'已提交的鉴定证据锁定，请等待经理复核',409);
  need(input.version===row.version,'鉴定单已更新，请保留草稿并重新打开最新版本',409);
  need(['ACTIVE','REVIEW'].includes(row.order_status),'订单已进入结算，鉴定单不能再修改',409);
}
function photoMetadata(db,id){return db.prepare('SELECT id,part,caption,mime,created_at FROM damage_photos WHERE case_id=? ORDER BY id').all(id);}
function event(db,row,user,action,snapshot){db.prepare('INSERT INTO damage_case_events(case_id,actor_id,action,snapshot_json,created_at) VALUES(?,?,?,?,?)').run(row.id,user.id,action,JSON.stringify(snapshot),time());audit(db,user.id,'DAMAGE_'+action,'damage_case',row.id,snapshot);}
export function damageCase(db,user,id){
  const row=access(db,user,id);
  const {user_id,...safe}=row;
  const result={...safe,photos:photoMetadata(db,id),events:db.prepare(`SELECT e.id,e.action,e.created_at,u.name AS actor_name,e.snapshot_json FROM damage_case_events e JOIN users u ON u.id=e.actor_id WHERE case_id=? ORDER BY e.id`).all(id).map(e=>({...e,snapshot:JSON.parse(e.snapshot_json),snapshot_json:undefined}))};
  // A technician does not need customer identity, contact history, deposit or payment data.
  if(user.role==='contractor')delete result.code;
  const order=db.prepare('SELECT * FROM reservations WHERE id=?').get(row.reservation_id);
  result.workflow=orderWorkflow(db,user,order);
  result.sla={dueAt:row.feedback_due_at,firstFeedbackAt:row.first_feedback_at,overdue:!row.first_feedback_at&&Date.parse(row.feedback_due_at)<Date.now(),late:!!row.first_feedback_at&&Date.parse(row.first_feedback_at)>Date.parse(row.feedback_due_at),windowHours:24};
  return result;
}
export function damageCases(db,user){
  need(user&&['contractor','staff','manager'].includes(user.role),'没有查看鉴定列表的权限',403);
  const rows=user.role==='contractor'?db.prepare('SELECT id FROM damage_cases WHERE assessor_id=? ORDER BY id DESC').all(user.id):db.prepare('SELECT c.id FROM damage_cases c JOIN reservations r ON r.id=c.reservation_id WHERE r.store_id=? ORDER BY c.id DESC').all(user.store_id);
  return rows.map(r=>damageCase(db,user,r.id));
}
export function damageOrder(db,user,id){
  const order=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
  need(order&&user&&(user.role==='customer'?order.user_id===user.id:['staff','manager'].includes(user.role)&&user.store_id===order.store_id),'订单不存在或无权访问',404);
  const ids=db.prepare('SELECT id FROM damage_cases WHERE reservation_id=? ORDER BY id').all(id);
  const consent=db.prepare('SELECT policy_version,accepted_at FROM damage_consents WHERE reservation_id=?').get(id)||null;
  return {consent,cases:ids.map(r=>damageCase(db,user,r.id)),settlement:db.prepare('SELECT * FROM damage_settlements WHERE reservation_id=?').get(id)||null,
    contacts:db.prepare(`SELECT c.*,u.name AS actor_name FROM damage_contacts c JOIN users u ON u.id=c.actor_id WHERE reservation_id=? ORDER BY c.id`).all(id),
    receipts:db.prepare('SELECT id,amount_nok,reference,created_at FROM damage_receipts WHERE reservation_id=? ORDER BY id').all(id)};
}

export function assessDamage(db,user,id,input){
  return transaction(db,()=>{
    const row=access(db,user,id);editable(row,user,input);
    need(['save','submit'].includes(input.action),'鉴定操作无效');
    const grade=String(input.grade||'');need(damagePolicy.grades.some(g=>g.code===grade),'请选择受损等级');
    const part=text(input.part,2,100,'受损部位'),diagnosis=text(input.diagnosis,5,3000,'鉴定依据');
    const labor=money(input.laborNok),parts=money(input.partsNok),replacement=money(input.replacementNok);
    const valueBasis=String(input.valueBasis||'').trim();need(valueBasis.length<=2000,'估值依据过长');
    if(grade==='NONE')need(labor===0&&parts===0&&replacement===0,'无损或正常磨损不得计入损坏费用');
    else{need(replacement>0&&valueBasis.length>=5,'受损收费必须填写折旧后重置估值及至少 5 字依据');need(grade==='TOTAL_LOSS'||labor+parts>0,'可修复损坏须填写工时或配件费用');}
    const fee=grade==='NONE'?0:grade==='TOTAL_LOSS'?replacement:Math.min(labor+parts,replacement);
    const photos=photoMetadata(db,id);if(input.action==='submit')need(photos.length>0,'提交鉴定前必须上传至少一张对应部位照片');
    const status=input.action==='submit'?'SUBMITTED':'DRAFT';
    db.prepare(`UPDATE damage_cases SET grade=?,part=?,diagnosis=?,labor_nok=?,parts_nok=?,replacement_nok=?,value_basis=?,fee_nok=?,status=?,version=version+1,submitted_at=? WHERE id=?`)
      .run(grade,part,diagnosis,labor,parts,replacement,valueBasis,fee,status,input.action==='submit'?time():null,id);
    db.prepare('UPDATE reservations SET staff_reviewed_at=NULL,staff_reviewed_by=NULL,staff_review_note=NULL WHERE id=?').run(row.reservation_id);
    if(input.action==='submit'){
      db.prepare('UPDATE damage_cases SET first_feedback_at=COALESCE(first_feedback_at,?) WHERE id=?').run(time(),id);
      notify(db,row.user_id,'受损程度初步鉴定已反馈',`订单 ${row.code}：${row.inventory_no} 初评为 ${damagePolicy.grades.find(g=>g.code===grade).label}，建议费用 NOK ${fee}，待门店复核与经理核定。`);
    }
    event(db,row,user,input.action==='submit'?'SUBMITTED':'DRAFT_SAVED',{grade,part,diagnosis,laborNok:labor,partsNok:parts,replacementNok:replacement,valueBasis,feeNok:fee,photoIds:photos.map(p=>p.id),version:row.version+1});
    if(input.action==='submit')for(const manager of db.prepare("SELECT id FROM users WHERE role='manager' AND store_id=?").all(row.store_id))notify(db,manager.id,'损坏鉴定待复核',`${row.inventory_no} 已提交照片与受损鉴定，建议费用 NOK ${fee}。`);
    return damageCase(db,user,id);
  });
}
export function reviewDamage(db,user,id,input){
  return transaction(db,()=>{
    const row=access(db,user,id);need(user.role==='manager','仅经理可复核鉴定',403);
    need(row.status==='SUBMITTED'&&['ACTIVE','REVIEW'].includes(row.order_status),'鉴定尚未提交或已完成复核',409);
    need(input.version===row.version,'鉴定版本已变化，请重新打开',409);
    need(['approve','reject'].includes(input.decision),'请选择复核结论');
    const note=text(input.note,3,2000,'复核意见'),status=input.decision==='approve'?'APPROVED':'RETURNED';
    need(photoMetadata(db,id).length>0,'缺少鉴定照片，不能复核通过',409);
    db.prepare('UPDATE damage_cases SET status=?,review_note=?,approved_by=?,approved_at=?,version=version+1 WHERE id=?')
      .run(status,note,status==='APPROVED'?user.id:null,status==='APPROVED'?time():null,id);
    if(status==='APPROVED')db.prepare('UPDATE inspections SET fee_nok=? WHERE id=?').run(row.fee_nok,row.inspection_id);
    else db.prepare('UPDATE reservations SET staff_reviewed_at=NULL,staff_reviewed_by=NULL,staff_review_note=NULL WHERE id=?').run(row.reservation_id);
    event(db,row,user,status,{note,feeNok:row.fee_nok,grade:row.grade,version:row.version+1});
    if(row.assessor_id)notify(db,row.assessor_id,'损坏鉴定复核结果',`${row.inventory_no}：${status==='APPROVED'?'已通过':'退回补充证据'}。${note}`);
    notify(db,row.user_id,'损坏鉴定进展',`订单 ${row.code} 的 ${row.inventory_no} 鉴定${status==='APPROVED'?'已由经理复核通过':'需补充证据'}，可在订单中查看。`);
    return damageCase(db,user,id);
  });
}

function imageDimensions(buffer,mime){
  if(mime==='image/png'&&buffer.length>=33&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&buffer.toString('ascii',12,16)==='IHDR'&&buffer.toString('ascii',buffer.length-8,buffer.length-4)==='IEND')return [buffer.readUInt32BE(16),buffer.readUInt32BE(20)];
  if(mime==='image/jpeg'&&buffer[0]===255&&buffer[1]===216&&buffer.at(-2)===255&&buffer.at(-1)===217){
    let i=2;while(i+8<buffer.length){if(buffer[i++]!==255)continue;const marker=buffer[i++];if(marker===255)continue;if(marker===217||marker===218)break;const length=buffer.readUInt16BE(i);if(length<2||i+length>buffer.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return [buffer.readUInt16BE(i+5),buffer.readUInt16BE(i+3)];i+=length;}
  }
  if(mime==='image/webp'&&buffer.length>=30&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'&&buffer.readUInt32LE(4)+8===buffer.length){
    const kind=buffer.toString('ascii',12,16);
    if(kind==='VP8X')return [1+buffer.readUIntLE(24,3),1+buffer.readUIntLE(27,3)];
    if(kind==='VP8 '&&buffer.subarray(23,26).equals(Buffer.from([157,1,42])))return [buffer.readUInt16LE(26)&16383,buffer.readUInt16LE(28)&16383];
    if(kind==='VP8L'&&buffer[20]===47){const bits=buffer.readUInt32LE(21);return [1+(bits&16383),1+((bits>>>14)&16383)];}
  }
  return null;
}
export function uploadDamagePhoto(db,user,id,input){
  return transaction(db,()=>{
    const row=access(db,user,id);editable(row,user,input);
    need(photoMetadata(db,id).length<6,'每件装备最多保留 6 张鉴定照片');
    const mime=String(input.mime||''),part=text(input.part,2,100,'照片对应部位'),caption=text(input.caption,3,500,'照片说明');
    need(['image/jpeg','image/png','image/webp'].includes(mime),'只接受 JPEG、PNG 或 WebP，不接受 SVG');
    need(typeof input.base64==='string'&&input.base64.length<=4194304&&/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64),'图片数据无效或超出 3 MB');
    const bytes=Buffer.from(input.base64,'base64');need(bytes.length>0&&bytes.length<=3*1024*1024,'图片不能超过 3 MB');
    const size=imageDimensions(bytes,mime);need(size&&size.every(v=>v>0&&v<=4096)&&size[0]*size[1]<=16000000,'图片内容与格式不匹配，或尺寸超过 4096px / 1600 万像素');
    const result=db.prepare('INSERT INTO damage_photos(case_id,uploaded_by,part,caption,mime,image,created_at) VALUES(?,?,?,?,?,?,?)').run(id,user.id,part,caption,mime,bytes,time());
    db.prepare('UPDATE damage_cases SET version=version+1 WHERE id=?').run(id);
    event(db,row,user,'PHOTO_UPLOADED',{photoId:Number(result.lastInsertRowid),part,caption,mime,bytes:bytes.length});
    return damageCase(db,user,id);
  });
}
export function damagePhoto(db,user,id){
  const photo=db.prepare('SELECT * FROM damage_photos WHERE id=?').get(id);need(photo,'图片不存在',404);access(db,user,photo.case_id);return photo;
}

export function contactDamageCustomer(db,user,id,input){
  return transaction(db,()=>{
    need(['staff','manager'].includes(user?.role),'仅门店人员可登记联系结果',403);
    const order=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);need(order&&order.store_id===user.store_id,'订单不存在或无权访问',404);need(['REVIEW','SETTLEMENT'].includes(order.status),'订单不在损坏复核或补差阶段',409);
    need(['PHONE','EMAIL','IN_PERSON'].includes(input.channel)&&['REACHED','NO_ANSWER','DISPUTED'].includes(input.outcome),'联系渠道或结果无效');
    const note=text(input.note,5,2000,'沟通说明');
    db.prepare('INSERT INTO damage_contacts(reservation_id,actor_id,channel,outcome,note,created_at) VALUES(?,?,?,?,?,?)').run(id,user.id,input.channel,input.outcome,note,time());
    const status=input.outcome==='DISPUTED'?'DISPUTED':input.outcome==='REACHED'?'CONTACTED':'AWAITING_CONTACT';
    db.prepare("UPDATE damage_settlements SET status=?,version=version+1 WHERE reservation_id=? AND status<>'SETTLED'").run(status,id);
    audit(db,user.id,'DAMAGE_CUSTOMER_CONTACT','reservation',id,{channel:input.channel,outcome:input.outcome,note});
    notify(db,order.user_id,'损坏结算沟通记录',`订单 ${order.code}：${note}。可在订单中查看完整鉴定及补差明细。`);
    return damageOrder(db,user,id);
  });
}
export function recordDamageSupplement(db,user,id,input){
  return transaction(db,()=>{
    need(['staff','manager'].includes(user?.role),'仅门店人员可登记核实后的补差凭证',403);
    const order=db.prepare('SELECT user_id,code,store_id FROM reservations WHERE id=?').get(id);need(order&&order.store_id===user.store_id,'订单不存在或无权访问',404);
    const settlement=db.prepare('SELECT * FROM damage_settlements WHERE reservation_id=?').get(id);need(settlement,'尚未核定损坏结算',409);
    const reference=text(input.reference,3,100,'补差核实凭证'),amount=money(input.amountNok);need(amount>0,'补差金额须大于 0');
    const existing=db.prepare('SELECT * FROM damage_receipts WHERE reservation_id=? AND reference=?').get(id,reference);
    if(existing){need(existing.amount_nok===amount,'同一凭证已登记不同金额',409);return {ok:true,duplicate:true,damage:damageOrder(db,user,id)};}
    need(input.confirmed===true,'请确认已联系顾客并核实演示补差凭证');
    need(input.version===settlement.version,'补差记录已更新，请重新打开订单',409);
    need(settlement.status==='CONTACTED','须先联系顾客确认；未接通或存在异议时不能结清',409);
    need(amount<=settlement.supplement_nok-settlement.paid_nok,'登记金额不能超过剩余补差',409);
    const paid=settlement.paid_nok+amount,done=paid===settlement.supplement_nok;
    db.prepare('INSERT INTO damage_receipts(reservation_id,amount_nok,reference,recorded_by,created_at) VALUES(?,?,?,?,?)').run(id,amount,reference,user.id,time());
    db.prepare('UPDATE damage_settlements SET paid_nok=?,status=?,version=version+1,settled_at=? WHERE reservation_id=?').run(paid,done?'SETTLED':'CONTACTED',done?time():null,id);
    if(done)db.prepare("UPDATE reservations SET status='COMPLETED' WHERE id=? AND status='SETTLEMENT'").run(id);
    audit(db,user.id,'DAMAGE_SUPPLEMENT_DEMO_RECORDED','reservation',id,{amountNok:amount,reference,done});
    notify(db,order.user_id,'补差演示登记',`订单 ${order.code} 已登记补差 NOK ${amount}，${done?'本次损坏结算已完成':'剩余待补差 NOK '+(settlement.supplement_nok-paid)}。演示不产生真实扣款。`);
    return {ok:true,duplicate:false,damage:damageOrder(db,user,id)};
  });
}
