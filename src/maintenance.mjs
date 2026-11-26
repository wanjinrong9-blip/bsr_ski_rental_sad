import { audit,notify } from './db.mjs';
import { DomainError,transaction } from './domain.mjs';
import {freezeRate} from './master-data.mjs';
import {blockAllocatedUnit} from './fulfillment.mjs';
import {invalidateCandidateSessions} from './identity.mjs';

const need=(condition,message,status=400)=>{if(!condition)throw new DomainError(message,status);};
const finalStates=['COMPLETED','RETIRED'];
const transitions={ASSIGNED:['INSPECTING'],INSPECTING:['REPAIRING','WAITING_PARTS','AWAITING_REVIEW'],REPAIRING:['WAITING_PARTS','AWAITING_REVIEW'],WAITING_PARTS:['REPAIRING']};
export const safetyKeys=['appearance','fasteners','function','cleaning'];
function event(db,id,user,type,from,to,note){db.prepare('INSERT INTO maintenance_events(maintenance_id,actor_id,event,from_status,to_status,note,created_at) VALUES(?,?,?,?,?,?,?)').run(id,user.id,type,from,to,note,new Date().toISOString());}

export function maintenanceList(db,user){
  need(user&&['staff','manager','contractor'].includes(user.role),'无权查看维修工单',403);
  const sql=`SELECT m.*,u.inventory_no,u.status AS unit_status,v.name AS variant_name,v.category,v.size,v.visual,s.name AS store_name,c.name AS contractor_name,c.phone AS contractor_phone,p.employee_no
    FROM maintenance m JOIN units u ON u.id=m.unit_id JOIN variants v ON v.id=u.variant_id JOIN stores s ON s.id=m.store_id
    LEFT JOIN users c ON c.id=m.contractor_id LEFT JOIN employee_profiles p ON p.user_id=c.id`;
  const rows=user.role==='contractor'?db.prepare(sql+' WHERE m.contractor_id=? ORDER BY m.id DESC').all(user.id):db.prepare(sql+' WHERE m.store_id=? ORDER BY m.id DESC').all(user.store_id);
  return rows.map(t=>({...t,due_at:t.due_at?new Date(t.due_at.includes('T')?t.due_at:t.due_at.replace(' ','T')+'Z').toISOString():null,checklist:JSON.parse(t.checklist_json||'{}'),events:db.prepare(`SELECT e.*,u.name AS actor_name FROM maintenance_events e LEFT JOIN users u ON u.id=e.actor_id WHERE maintenance_id=? ORDER BY e.id`).all(t.id)}));
}

export function reportFault(db,user,input,candidate=false){
  need(user&&['staff','manager'].includes(user.role),'仅门店人员可登记故障',403);
  const unitId=Number(input.unitId),unit=db.prepare('SELECT * FROM units WHERE id=?').get(unitId);
  need(unit,'装备不存在',404);need(unit.store_id===user.store_id,'无权处理其他门店装备',403);
  need(unit.status==='AVAILABLE','仅可为当前可用装备登记新故障',409);
  need(!db.prepare("SELECT id FROM maintenance WHERE unit_id=? AND status NOT IN ('COMPLETED','RETIRED')").get(unitId),'该装备已有未关闭的维修工单',409);
  const issue=String(input.issue||'').trim();need(issue.length>=3&&issue.length<=1000,'请填写 3–1000 字的故障描述');
  const priority=String(input.priority||'NORMAL');need(['LOW','NORMAL','HIGH','URGENT'].includes(priority),'优先级无效');
  const eligible=contractorId=>db.prepare("SELECT id FROM users WHERE id=? AND role='contractor' AND account_state='ACTIVE' AND (store_id=? OR store_id IS NULL)")
    .get(contractorId,unit.store_id);
  const defaultContractor=candidate?
    db.prepare("SELECT id FROM users WHERE role='contractor' AND account_state='ACTIVE' AND (store_id=? OR store_id IS NULL) ORDER BY CASE WHEN store_id=? THEN 0 ELSE 1 END,id LIMIT 1")
      .get(unit.store_id,unit.store_id)?.id:
    db.prepare("SELECT id FROM users WHERE role='contractor' ORDER BY id LIMIT 1").get()?.id;
  const contractorId=Number(input.contractorId)||defaultContractor||null;
  need(!contractorId||(candidate?eligible(contractorId):db.prepare("SELECT id FROM users WHERE id=? AND role='contractor'").get(contractorId)),
    '维修人员无效或未获此门店任务授权');
  const dueAt=input.dueAt?new Date(input.dueAt):new Date(Date.now()+2*86400000);need(!Number.isNaN(dueAt.getTime()),'预计完成时间无效');
  return transaction(db,()=>{
    const now=new Date().toISOString();
    blockAllocatedUnit(db,user,unitId,'准备实物发现故障，门店正在更换并重新检查');
    db.prepare("UPDATE units SET status='MAINTENANCE',condition_note=? WHERE id=?").run(issue,unitId);
    const id=Number(db.prepare(`INSERT INTO maintenance(unit_id,contractor_id,store_id,issue,status,priority,due_at,created_at,updated_at) VALUES(?,?,?,?,'ASSIGNED',?,?,?,?)`).run(unitId,contractorId,unit.store_id,issue,priority,dueAt.toISOString(),now,now).lastInsertRowid);
    if(candidate&&contractorId)invalidateCandidateSessions(db,contractorId);
    freezeRate(db,id);
    event(db,id,user,'CREATED',null,'ASSIGNED',issue);audit(db,user.id,'FAULT_REPORTED','maintenance',id,{unitId,issue,priority});
    if(contractorId)notify(db,contractorId,'新维修任务',`${unit.inventory_no}：${issue}`);
    return {id,status:'ASSIGNED'};
  });
}

export function updateMaintenance(db,user,id,input,candidate=false){
  return transaction(db,()=>{
    const task=db.prepare('SELECT * FROM maintenance WHERE id=?').get(id);need(task,'维修任务不存在',404);
    need(user&&(user.role==='manager'&&user.store_id===task.store_id||user.role==='contractor'&&task.contractor_id===user.id),'无权处理此维修任务',403);
    need(Number(input.version)===task.version,'工单已被其他人更新，请关闭并重新打开最新工单',409);
    need(!finalStates.includes(task.status),'已关闭的工单不能再次修改',409);
    const action=input.action||'progress',note=String(input.note||'').trim();let status=task.status;
    if(action==='assign') {
      need(user.role==='manager','仅经理可调整分配',403);
      const contractorId=Number(input.contractorId),priority=String(input.priority||task.priority),due=new Date(input.dueAt||task.due_at);
      need(db.prepare(candidate?
        "SELECT id FROM users WHERE id=? AND role='contractor' AND account_state='ACTIVE' AND (store_id=? OR store_id IS NULL)":
        "SELECT id FROM users WHERE id=? AND role='contractor'")
        .get(...(candidate?[contractorId,task.store_id]:[contractorId])),'请选择有此门店任务权限的维修技师');
      need(['LOW','NORMAL','HIGH','URGENT'].includes(priority)&&!Number.isNaN(due.getTime()),'优先级或截止时间无效');
      db.prepare('UPDATE maintenance SET contractor_id=?,priority=?,due_at=? WHERE id=?').run(contractorId,priority,due.toISOString(),id);
      if(contractorId!==task.contractor_id){db.prepare("UPDATE maintenance SET rate_id=NULL,hourly_rate_nok=0,rate_source='待冻结新指派费率' WHERE id=?").run(id);freezeRate(db,id);}
      db.prepare("UPDATE damage_cases SET assessor_id=?,version=version+1 WHERE maintenance_id=? AND status IN ('DRAFT','RETURNED')").run(contractorId,id);
      if(candidate&&contractorId!==task.contractor_id){
        if(task.contractor_id)invalidateCandidateSessions(db,task.contractor_id);
        invalidateCandidateSessions(db,contractorId);
      }
      event(db,id,user,'ASSIGNED',status,status,note||'调整负责人、优先级与计划时间');notify(db,contractorId,'维修安排已更新',`工单 MT-${String(id).padStart(4,'0')} 的处理安排已更新`);
    } else if(action==='review') {
      need(user.role==='manager','仅经理可验收维修结果',403);need(task.status==='AWAITING_REVIEW','工单尚未提交验收',409);
      need(['accept','reject','retire'].includes(input.decision),'请选择验收结论');need(note.length>=3,'请填写至少 3 字的验收意见');
      status=input.decision==='accept'?'COMPLETED':input.decision==='retire'?'RETIRED':'REPAIRING';
      if(status==='COMPLETED') {
        const checks=JSON.parse(task.checklist_json||'{}');need(safetyKeys.every(k=>checks[k]===true),'安全检查尚未全部通过');
        need(!db.prepare("SELECT id FROM maintenance WHERE unit_id=? AND id<>? AND status NOT IN ('COMPLETED','RETIRED')").get(task.unit_id,id),'该装备仍有其他未关闭维修工单',409);
      }
      db.prepare('UPDATE maintenance SET review_note=?,completed_at=? WHERE id=?').run(note,finalStates.includes(status)?new Date().toISOString():null,id);
      if(finalStates.includes(status))db.prepare('UPDATE units SET status=?,condition_note=? WHERE id=?').run(status==='COMPLETED'?'AVAILABLE':'RETIRED',status==='COMPLETED'?'维修已验收通过':note,task.unit_id);
      event(db,id,user,'REVIEWED',task.status,status,note);
      if(task.contractor_id)notify(db,task.contractor_id,'维修验收结果',`MT-${String(id).padStart(4,'0')}：${status==='COMPLETED'?'验收通过，已恢复库存':status==='RETIRED'?'装备报废':'退回继续维修'}。${note}`);
    } else if(action==='note') {
      need(note.length>=3&&note.length<=2000,'工作记录请填写 3–2000 字');event(db,id,user,'NOTE',status,status,note);
    } else {
      need(action==='progress','操作无效');status=String(input.status||task.status);
      need(status===task.status||(transitions[task.status]||[]).includes(status),'请按接单、检查、维修、提交验收的顺序处理',409);
      const diagnosis=String(input.diagnosis??task.diagnosis).trim(),result=String(input.result??task.result).trim(),parts=String(input.parts??task.parts).trim();
      const hours=Number(input.hours??task.hours),cost=Number(input.costNok??task.cost_nok),checks=input.checklist||JSON.parse(task.checklist_json||'{}');
      need(Number.isFinite(hours)&&hours>=0&&hours<=1000&&Number.isInteger(cost)&&cost>=0&&cost<=1000000,'工时或材料费用无效');
      need(Math.abs(hours*4-Math.round(hours*4))<1e-8,'维修工时须以15分钟（0.25小时）为单位记录');
      need([diagnosis,result,parts].every(v=>v.length<=3000),'文字记录过长');
      if(status==='AWAITING_REVIEW')need(diagnosis.length>=3&&result.length>=3&&hours>0&&safetyKeys.every(k=>checks[k]===true),'提交验收前须填写故障诊断、处理结果、工时，并完成全部安全检查');
      if(status==='WAITING_PARTS')need(parts.length>=3,'请说明所需配件及等待原因');
      const cleanChecks=Object.fromEntries(safetyKeys.map(k=>[k,checks[k]===true]));
      db.prepare('UPDATE maintenance SET diagnosis=?,result=?,parts=?,hours=?,cost_nok=?,checklist_json=? WHERE id=?').run(diagnosis,result,parts,hours,cost,JSON.stringify(cleanChecks),id);
      event(db,id,user,'PROGRESS',task.status,status,note||result||diagnosis||'接单并开始检查');
      if(status==='AWAITING_REVIEW')for(const m of db.prepare("SELECT id FROM users WHERE role='manager' AND store_id=?").all(task.store_id))notify(db,m.id,'维修待验收',`${task.unit_id} 号装备已完成维修，请检查后恢复库存。`);
    }
    db.prepare('UPDATE maintenance SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,new Date().toISOString(),id);
    audit(db,user.id,'MAINTENANCE_UPDATED','maintenance',id,{action,from:task.status,to:status,version:task.version+1});
    return {id,status,version:task.version+1};
  });
}
