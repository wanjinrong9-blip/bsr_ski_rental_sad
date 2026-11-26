import { DomainError,transaction } from './domain.mjs';

export const orderAlertRoles=['staff','manager','contractor','owner','admin'];
const need=(ok,message,status=400)=>{if(!ok)throw new DomainError(message,status);};
const repairLabels={ASSIGNED:'待接单',INSPECTING:'检查诊断',REPAIRING:'维修中',WAITING_PARTS:'等待配件',AWAITING_REVIEW:'待经理验收'};
const asTime=value=>Date.parse(value?.includes('T')?value:value?.replace(' ','T')+'Z');

// Read state and business state are deliberately independent: reading never closes an order.
export function reservationSignal(db,user,order,now=Date.now()) {
  if(!user||!['staff','manager','owner','admin'].includes(user.role))return null;
  const unresolved=['CONFIRMED','READY','ACTIVE','REVIEW','SETTLEMENT'].includes(order.status)||
    (order.status==='HOLD'&&asTime(order.hold_expires_at)>now);
  const overdue=order.status==='ACTIVE'&&asTime(order.return_at)<now;
  const latePickup=['CONFIRMED','READY'].includes(order.status)&&asTime(order.pickup_at)<now;
  const pendingFeedback=db.prepare('SELECT MIN(feedback_due_at) AS due FROM damage_cases WHERE reservation_id=? AND first_feedback_at IS NULL').get(order.id).due;
  const feedbackOverdue=!!pendingFeedback&&asTime(pendingFeedback)<=now;
  const urgent=unresolved&&(['REVIEW','SETTLEMENT'].includes(order.status)||overdue||latePickup||feedbackOverdue);
  const isNew=unresolved&&!db.prepare('SELECT 1 FROM order_alert_reads WHERE user_id=? AND reservation_id=?').get(user.id,order.id);
  const settlement=order.status==='SETTLEMENT'?db.prepare('SELECT status,supplement_nok,paid_nok FROM damage_settlements WHERE reservation_id=?').get(order.id):null;
  const reason=order.status==='SETTLEMENT'?(settlement?.status==='DISPUTED'?'补差存在异议，待沟通解决':`需联系顾客补差 NOK ${Math.max(0,(settlement?.supplement_nok||0)-(settlement?.paid_nok||0))}`):order.status==='REVIEW'?'损坏鉴定 / 押金待经理复核':overdue?'逾期未归还':latePickup?'超过约定取货时间':
    ['CONFIRMED','READY'].includes(order.status)?'已支付，待核码交付':order.status==='ACTIVE'?'租赁中，待归还验收':'等待顾客支付，暂留有效';
  return {isNew,unresolved,urgent,reason:feedbackOverdue?'受损程度检验超过24H未反馈，需立即跟进':reason,noticeVersion:1};
}

function candidates(db,user,now) {
  if(user.role==='contractor') {
    return db.prepare(`SELECT m.id,m.status,m.issue,m.due_at,m.created_at,m.priority,s.name AS store_name,
      u.inventory_no,v.name AS equipment,
      (SELECT MIN(feedback_due_at) FROM damage_cases c WHERE c.maintenance_id=m.id AND c.first_feedback_at IS NULL) AS feedback_due_at,
      COALESCE((SELECT MAX(e.id) FROM maintenance_events e WHERE e.maintenance_id=m.id AND
        (e.event IN ('CREATED','ASSIGNED') OR (e.event='REVIEWED' AND e.to_status='REPAIRING'))),0) AS notice_version,
      a.notice_version AS read_version
      FROM maintenance m JOIN units u ON u.id=m.unit_id JOIN variants v ON v.id=u.variant_id
      JOIN stores s ON s.id=m.store_id LEFT JOIN maintenance_alert_reads a ON a.maintenance_id=m.id AND a.user_id=?
      WHERE m.contractor_id=? AND m.status NOT IN ('COMPLETED','RETIRED')`).all(user.id,user.id).map(m=>{
        const overdue=asTime(m.due_at)<now;
        const feedbackOverdue=!!m.feedback_due_at&&asTime(m.feedback_due_at)<=now;
        return {id:m.id,kind:'maintenance',code:`MT-${String(m.id).padStart(4,'0')}`,status:m.status,
          statusLabel:repairLabels[m.status]||m.status,storeName:m.store_name,createdAt:m.created_at,dueAt:m.due_at,
          equipment:`${m.inventory_no} · ${m.equipment}`,summary:m.issue,noticeVersion:m.notice_version,
          isNew:m.read_version==null||m.read_version<m.notice_version,unresolved:true,
          urgent:feedbackOverdue||overdue||m.priority==='URGENT',reason:feedbackOverdue?'受损程度检验超过24H未反馈':overdue?'维修已超过计划完成时间':m.status==='AWAITING_REVIEW'?'已提交，等待经理验收':m.status==='WAITING_PARTS'?'等待配件，需跟进进度':`本人负责 · ${repairLabels[m.status]||m.status}`};
      });
  }
  // Store staff only receive actionable records from their assigned store.
  return db.prepare(`SELECT r.*,u.name AS customer_name,s.name AS store_name FROM reservations r
    JOIN users u ON u.id=r.user_id JOIN stores s ON s.id=r.store_id
    WHERE r.status IN ('HOLD','CONFIRMED','READY','ACTIVE','REVIEW','SETTLEMENT')
      AND (? IS NULL OR r.store_id=?)`).all(['owner','admin'].includes(user.role)?null:user.store_id,user.store_id).flatMap(r=>{
      const signal=reservationSignal(db,user,r,now);if(!signal.unresolved)return [];
      return [{id:r.id,kind:'reservation',code:r.code,status:r.status,
        statusLabel:{HOLD:'待支付',CONFIRMED:'待取货',READY:'待取货',ACTIVE:'租赁中',REVIEW:'待复核',SETTLEMENT:'待补差'}[r.status],
        storeId:r.store_id,storeName:r.store_name,customerName:r.customer_name,createdAt:r.created_at,
        dueAt:r.status==='ACTIVE'?r.return_at:r.status==='HOLD'?r.hold_expires_at:r.pickup_at,
        ...signal}];
    });
}

export function orderAlerts(db,user,params=new URLSearchParams(),now=Date.now()) {
  need(orderAlertRoles.includes(user?.role),'没有查看订单提醒的权限',403);
  const view=params.get('view')||'unresolved',search=(params.get('search')||'').trim().slice(0,100).toLowerCase();
  const requested=Number(params.get('page')||1);
  need(['new','unresolved','urgent'].includes(view)&&Number.isSafeInteger(requested)&&requested>0,'提醒筛选参数无效');
  const rows=candidates(db,user,now);
  const counts={new:rows.filter(r=>r.isNew).length,unresolved:rows.length,urgent:rows.filter(r=>r.urgent).length};
  if(['owner','admin'].includes(user.role)){
    const groups=new Map();
    for(const row of rows){const key=`${row.storeId}:${row.status}`;
      if(!groups.has(key))groups.set(key,{storeId:row.storeId,storeName:row.storeName,status:row.status,statusLabel:row.statusLabel,count:0,new:0,urgent:0});
      const group=groups.get(key);group.count++;group.new+=Number(row.isNew);group.urgent+=Number(row.urgent);
    }
    return {kind:'summary',counts,byStoreStatus:[...groups.values()].sort((a,b)=>a.storeId-b.storeId||a.status.localeCompare(b.status)),
      items:[],view,page:1,pageSize:0,pages:1,total:0,generatedAt:new Date(now).toISOString()};
  }
  const filtered=rows.filter(r=>(view==='new'?r.isNew:view==='urgent'?r.urgent:true)&&
    (!search||`${r.code} ${r.customerName||''} ${r.storeName} ${r.equipment||''} ${r.summary||''}`.toLowerCase().includes(search)))
    .sort((a,b)=>Number(b.urgent)-Number(a.urgent)||Number(b.isNew)-Number(a.isNew)||asTime(b.createdAt)-asTime(a.createdAt)||b.id-a.id);
  const pageSize=12,pages=Math.max(1,Math.ceil(filtered.length/pageSize)),page=Math.min(requested,pages);
  return {kind:user.role==='contractor'?'maintenance':'reservation',counts,items:filtered.slice((page-1)*pageSize,page*pageSize),
    view,page,pageSize,pages,total:filtered.length,generatedAt:new Date(now).toISOString()};
}

export function markOrderAlertsRead(db,user,input) {
  need(orderAlertRoles.includes(user?.role),'没有处理订单提醒的权限',403);
  if(['owner','admin'].includes(user.role)){
    need(input.kind==='summary'&&!input.entries,'汇总提醒不接受逐单已读请求',403);
    const rows=candidates(db,user,Date.now()).filter(row=>row.isNew);
    return transaction(db,()=>{const at=new Date().toISOString();let marked=0;
      for(const row of rows)marked+=Number(db.prepare('INSERT OR IGNORE INTO order_alert_reads(user_id,reservation_id,read_at) VALUES(?,?,?)').run(user.id,row.id,at).changes);
      return {ok:true,marked};
    });
  }
  const kind=user.role==='contractor'?'maintenance':'reservation';
  need(input.kind===kind,'提醒类型不属于当前角色',403);
  need(Array.isArray(input.entries)&&input.entries.length>0&&input.entries.length<=100,'请选择 1–100 条当前已展示的提醒');
  need(input.entries.every(e=>Number.isSafeInteger(e.id)&&e.id>0&&Number.isSafeInteger(e.noticeVersion)&&e.noticeVersion>=0),'提醒编号或版本无效');
  return transaction(db,()=>{
    const at=new Date().toISOString();let marked=0;
    for(const entry of input.entries) {
      const row=kind==='maintenance'?db.prepare('SELECT id FROM maintenance WHERE id=? AND contractor_id=?').get(entry.id,user.id):db.prepare('SELECT id FROM reservations WHERE id=? AND store_id=?').get(entry.id,user.store_id);
      need(row,'提醒不存在或不属于当前用户',403);
      if(kind==='reservation') {
        need(entry.noticeVersion===1,'订单提醒版本无效',409);
        marked+=Number(db.prepare('INSERT OR IGNORE INTO order_alert_reads(user_id,reservation_id,read_at) VALUES(?,?,?)').run(user.id,entry.id,at).changes);
      } else {
        const version=db.prepare(`SELECT COALESCE(MAX(id),0) AS v FROM maintenance_events WHERE maintenance_id=? AND
          (event IN ('CREATED','ASSIGNED') OR (event='REVIEWED' AND to_status='REPAIRING'))`).get(entry.id).v;
        need(entry.noticeVersion<=version,'维修提醒版本无效',409);
        // A stale screen may acknowledge its version, but must not consume a later reassignment.
        marked+=Number(db.prepare(`INSERT INTO maintenance_alert_reads(user_id,maintenance_id,notice_version,read_at) VALUES(?,?,?,?)
          ON CONFLICT(user_id,maintenance_id) DO UPDATE SET notice_version=excluded.notice_version,read_at=excluded.read_at
          WHERE excluded.notice_version>maintenance_alert_reads.notice_version`).run(user.id,entry.id,entry.noticeVersion,at).changes);
      }
    }
    return {ok:true,marked};
  });
}
