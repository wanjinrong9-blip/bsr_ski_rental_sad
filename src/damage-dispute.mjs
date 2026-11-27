// Failed contact attempts do not resolve a previously recorded dispute.
export function hasActiveDamageDispute(db,reservationId){
  const contact=db.prepare(`SELECT outcome FROM damage_contacts
    WHERE reservation_id=? AND (outcome='DISPUTED' OR
      (outcome='REACHED' AND TRIM(COALESCE(note,''))<>''))
    ORDER BY id DESC LIMIT 1`).get(reservationId);
  return contact?.outcome==='DISPUTED';
}
