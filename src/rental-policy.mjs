export const rentalPolicy=Object.freeze({
  version:'BSR-RENTAL-DEMO-2026-01',currency:'NOK',
  pickupFrom:'09:00',returnBy:'16:00',
  lateHourlyPercent:10,firstRentalGraceMinutes:120,capPeriodMinutes:1440
});

function addColumns(db,table,definitions){
  const existing=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(row=>row.name));
  for(const [name,definition] of Object.entries(definitions)){
    if(!existing.has(name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+definition);
  }
}

export function upgradeRentalPolicy(db){
  addColumns(db,'reservations',{
    late_policy_version:'TEXT',late_hourly_percent:'INTEGER',late_grace_minutes:'INTEGER'
  });
  addColumns(db,'rental_units',{
    late_minutes:'INTEGER NOT NULL DEFAULT 0',late_billable_hours:'INTEGER NOT NULL DEFAULT 0',
    late_fee_nok:'INTEGER NOT NULL DEFAULT 0'
  });
  addColumns(db,'damage_settlements',{
    damage_fee_nok:'INTEGER NOT NULL DEFAULT 0',late_fee_nok:'INTEGER NOT NULL DEFAULT 0'
  });
  if(db.prepare("SELECT 1 FROM app_migrations WHERE name='rental-policy-v6'").get())return;
  db.exec('BEGIN IMMEDIATE');
  try{
    // Previously settled fees predate this rule and are damage fees only.
    db.prepare('UPDATE damage_settlements SET damage_fee_nok=total_fee_nok WHERE damage_fee_nok=0').run();
    db.prepare('INSERT INTO app_migrations(name,applied_at) VALUES(?,?)').run('rental-policy-v6',new Date().toISOString());
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function isFirstEffectiveRental(db,userId,excludeId=null){
  return !db.prepare(
    "SELECT 1 FROM reservations WHERE user_id=? AND id<>COALESCE(?,0) "+
    "AND status IN ('CONFIRMED','READY','ACTIVE','REVIEW','SETTLEMENT','COMPLETED') LIMIT 1"
  ).get(userId,excludeId);
}

export function lateCharge(dailyNok,dueAt,actualAt,graceMinutes=0,hourlyPercent=rentalPolicy.lateHourlyPercent){
  const due=Date.parse(dueAt),actual=Date.parse(actualAt);
  if(!Number.isFinite(due)||!Number.isFinite(actual))throw new Error('超时计算的日期无效');
  const lateMinutes=Math.max(0,Math.ceil((actual-due)/60000));
  const billableMinutes=Math.max(0,lateMinutes-graceMinutes);
  if(!billableMinutes||!dailyNok)return {lateMinutes,billableMinutes,billableHours:0,feeNok:0};
  const fullPeriods=Math.floor(billableMinutes/rentalPolicy.capPeriodMinutes);
  const remainingMinutes=billableMinutes%rentalPolicy.capPeriodMinutes;
  const hourlyNok=Math.max(1,Math.round(dailyNok*hourlyPercent/100));
  const billableHours=fullPeriods*24+Math.ceil(remainingMinutes/60);
  const feeNok=fullPeriods*dailyNok+
    Math.min(dailyNok,Math.ceil(remainingMinutes/60)*hourlyNok);
  return {lateMinutes,billableMinutes,billableHours,feeNok};
}

export function rentalLateSummary(db,reservationId,at=new Date().toISOString()){
  const order=db.prepare('SELECT late_policy_version,late_hourly_percent,late_grace_minutes FROM reservations WHERE id=?').get(reservationId);
  if(!order)return null;
  const units=db.prepare(
    'SELECT ru.unit_id,ru.returned,ru.returned_at,ru.late_minutes,ru.late_billable_hours,ru.late_fee_nok,'+
    'u.inventory_no,v.name,p.daily_nok,COALESCE(ri.rental_to,r.return_at) AS due_at '+
    'FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id '+
    'JOIN reservations r ON r.id=ri.reservation_id JOIN units u ON u.id=ru.unit_id '+
    'JOIN variants v ON v.id=u.variant_id JOIN price_policies p ON p.id=ri.policy_id '+
    'WHERE r.id=? ORDER BY ru.unit_id'
  ).all(reservationId);
  const applicable=!!order.late_policy_version;
  const details=units.map(unit=>{
    const calc=unit.returned
      ? {lateMinutes:unit.late_minutes,billableHours:unit.late_billable_hours,feeNok:unit.late_fee_nok}
      : applicable?lateCharge(unit.daily_nok,unit.due_at,at,order.late_grace_minutes||0,order.late_hourly_percent):null;
    return {unitId:unit.unit_id,inventoryNo:unit.inventory_no,name:unit.name,dueAt:unit.due_at,
      returnedAt:unit.returned_at,returned:!!unit.returned,dailyNok:unit.daily_nok,
      lateMinutes:calc?.lateMinutes||0,billableHours:calc?.billableHours||0,feeNok:calc?.feeNok||0};
  });
  return {applicable,version:order.late_policy_version,graceMinutes:order.late_grace_minutes||0,
    hourlyPercent:order.late_hourly_percent||0,asOf:at,
    assessedNok:details.filter(unit=>unit.returned).reduce((sum,unit)=>sum+unit.feeNok,0),
    estimatedNok:details.filter(unit=>!unit.returned).reduce((sum,unit)=>sum+unit.feeNok,0),
    units:details};
}
