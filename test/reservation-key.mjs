import {randomUUID} from 'node:crypto';

export function reservationHeaders(path,method){
  return method==='POST'&&['/api/reservations','/api/operations/reservations'].includes(path)
    ? {'Idempotency-Key':randomUUID()}
    : {};
}
