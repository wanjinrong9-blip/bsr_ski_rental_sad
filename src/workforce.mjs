import { audit } from './db.mjs';
import { DomainError, transaction } from './domain.mjs';

export const employeeRoles=['staff','manager','contractor','owner','admin'];
export function osloDay(value=new Date()) {return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);}
function timeText(value){return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
function need(condition,message,status=400){if(!condition)throw new DomainError(message,status);}

export function employees(db,user){
  const sql=`SELECT u.id,u.name,u.email,u.phone,u.role,u.store_id,s.name AS store_name,
    p.employee_no,p.department,p.job_title,p.expertise,p.qualification,p.joined_on,p.work_location
    FROM users u LEFT JOIN employee_profiles p ON p.user_id=u.id LEFT JOIN stores s ON s.id=u.store_id
    WHERE u.role<>'customer'`;
  if(user.role==='contractor')return db.prepare(sql+' AND u.id=? ORDER BY u.id').all(user.id);
  if(['staff','manager'].includes(user.role))return db.prepare(sql+" AND (u.store_id=? OR (u.role='contractor' AND u.store_id IS NULL)) ORDER BY u.id").all(user.store_id);
  return db.prepare(sql+' ORDER BY u.id').all();
}

export function attendanceView(db,user){
  const date=osloDay();
  const records=db.prepare(`SELECT a.*,s.name AS store_name FROM attendance a LEFT JOIN stores s ON s.id=a.store_id
    WHERE a.user_id=? ORDER BY a.work_date DESC LIMIT 31`).all(user.id);
  const shift=db.prepare(`SELECT sh.*,s.name AS store_name FROM shifts sh JOIN stores s ON s.id=sh.store_id WHERE sh.user_id=? AND sh.work_date=?`).get(user.id,date)||null;
  const today=records.find(r=>r.work_date===date)||null;
  return {date,timeZone:'Europe/Oslo',serverTime:new Date().toISOString(),shift,today,records:records.map(r=>({...r,minutes:r.clock_out_at?Math.max(0,Math.round((Date.parse(r.clock_out_at)-Date.parse(r.clock_in_at))/60000)):null})),profile:employees(db,{...user,role:'contractor'}).find(x=>x.id===user.id)};
}

export function punch(db,user,input){
  need(employeeRoles.includes(user.role),'顾客账号不能打卡',403);
  const kind=String(input.kind||'');need(['IN','OUT'].includes(kind),'打卡类型无效');
  const date=osloDay(),now=new Date().toISOString();
  return transaction(db,()=>{
    const current=db.prepare('SELECT * FROM attendance WHERE user_id=? AND work_date=?').get(user.id,date);
    if(kind==='IN') {
      need(!current,'今天已完成上班打卡',409);
      const shift=db.prepare('SELECT * FROM shifts WHERE user_id=? AND work_date=?').get(user.id,date);
      const storeId=shift?.store_id||user.store_id||Number(input.storeId)||null;
      need(!storeId||db.prepare('SELECT id FROM stores WHERE id=?').get(storeId),'打卡门店无效');
      db.prepare('INSERT INTO attendance(user_id,work_date,store_id,clock_in_at,note) VALUES(?,?,?,?,?)').run(user.id,date,storeId,now,String(input.note||'').trim().slice(0,200));
    } else {
      need(current,'请先完成上班打卡',409);need(!current.clock_out_at,'今天已完成下班打卡',409);
      db.prepare('UPDATE attendance SET clock_out_at=? WHERE id=?').run(now,current.id);
    }
    audit(db,user.id,kind==='IN'?'CLOCK_IN':'CLOCK_OUT','attendance',current?.id||Number(db.prepare('SELECT id FROM attendance WHERE user_id=? AND work_date=?').get(user.id,date).id),{date,at:now});
    return attendanceView(db,user);
  });
}

export function roster(db,user,date=osloDay(),storeId=0){
  need(validDate(date),'排班日期无效');
  if(user.role==='manager'){need(!storeId||storeId===user.store_id,'无权查看其他门店排班',403);storeId=user.store_id;}
  const directory=employees(db,user).filter(p=>user.role==='staff'?p.id===user.id:true);
  const shifts=db.prepare('SELECT * FROM shifts WHERE work_date=?').all(date);
  const punches=db.prepare('SELECT * FROM attendance WHERE work_date=?').all(date);
  const rows=directory.map(person=>{
    const shift=shifts.find(s=>s.user_id===person.id)||null,attendance=punches.find(a=>a.user_id===person.id)||null;
    let status='UNSCHEDULED';
    if(attendance?.clock_out_at)status='OFF_DUTY';else if(attendance)status='ON_DUTY';else if(shift)status='NOT_ARRIVED';
    return {...person,shift,attendance,status,late:!!(shift&&attendance&&timeText(attendance.clock_in_at)>shift.start_time),early:!!(shift&&attendance?.clock_out_at&&timeText(attendance.clock_out_at)<shift.end_time)};
  }).filter(p=>!storeId||(p.shift?.store_id||p.store_id)===storeId);
  return {date,timeZone:'Europe/Oslo',rows};
}

export function saveShift(db,user,input,id=null){
  need(user&&user.role==='manager'&&user.store_id,'仅门店经理可安排所属门店班次',403);
  const employeeId=Number(input.userId),storeId=Number(input.storeId),date=String(input.workDate||''),start=String(input.startTime||''),end=String(input.endTime||'');
  need(storeId===user.store_id,'经理只能安排所属门店班次',403);
  if(id){const old=db.prepare('SELECT sh.*,u.role,u.store_id AS employee_store_id FROM shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.id=?').get(id);need(old,'班次不存在',404);need(old.store_id===user.store_id&&(['staff','manager'].includes(old.role)?old.employee_store_id===user.store_id:old.role==='contractor'&&(old.employee_store_id==null||old.employee_store_id===user.store_id)),'不能编辑其他门店或非门店岗位班次',403);}
  const employee=db.prepare("SELECT id,role,store_id FROM users WHERE id=? AND role IN ('staff','manager','contractor')").get(employeeId);
  need(employee&&db.prepare('SELECT id FROM stores WHERE id=?').get(storeId),'员工或门店无效');
  need(employee.role==='contractor'?(employee.store_id==null||employee.store_id===user.store_id):employee.store_id===user.store_id,'不能安排其他门店员工班次',403);
  need(validDate(date)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(start)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(end)&&start>='08:00'&&end<='22:00'&&start<end,'班次应在 08:00–22:00 内，且结束晚于开始');
  const clash=db.prepare('SELECT id FROM shifts WHERE user_id=? AND work_date=?').get(employeeId,date);
  need(!clash||clash.id===id,'该员工当天已有班次，请编辑原班次',409);
  if(id) {
    need(!db.prepare('SELECT id FROM attendance WHERE user_id=? AND work_date=?').get(employeeId,date),'已有打卡记录的班次不能修改',409);
    const old=db.prepare('SELECT * FROM shifts WHERE id=?').get(id);
    need(!db.prepare('SELECT id FROM attendance WHERE user_id=? AND work_date=?').get(old.user_id,old.work_date),'已有打卡记录的班次不能修改',409);
    db.prepare('UPDATE shifts SET user_id=?,store_id=?,work_date=?,start_time=?,end_time=? WHERE id=?').run(employeeId,storeId,date,start,end,id);
  } else id=Number(db.prepare('INSERT INTO shifts(user_id,store_id,work_date,start_time,end_time) VALUES(?,?,?,?,?)').run(employeeId,storeId,date,start,end).lastInsertRowid);
  audit(db,user.id,'SHIFT_SAVED','shift',id,{employeeId,storeId,date,start,end});
  return {id};
}
