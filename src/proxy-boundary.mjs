import {timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {DomainError} from './domain.mjs';

const guardedHeaders=new Set(['host','x-bsr-proxy-secret','x-bsr-client-ip','x-forwarded-proto']);
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);

function deny(){
  const error=new DomainError('代理入口不受信任',403);
  error.code='UNTRUSTED_PROXY';
  throw error;
}

function hasRepeatedGuardedHeader(req){
  if(!Array.isArray(req?.rawHeaders))return false;
  const seen=new Set();
  for(let index=0;index<req.rawHeaders.length;index+=2){
    const name=String(req.rawHeaders[index]||'').toLowerCase();
    if(!guardedHeaders.has(name))continue;
    if(seen.has(name))return true;
    seen.add(name);
  }
  return false;
}

function secretMatches(received,expected){
  if(typeof received!=='string'||typeof expected!=='string')return false;
  const receivedBytes=Buffer.from(received,'utf8'),expectedBytes=Buffer.from(expected,'utf8');
  return receivedBytes.length===expectedBytes.length&&timingSafeEqual(receivedBytes,expectedBytes);
}

// Called before API, static, health and event routes. Only a same-machine proxy
// that overwrites these headers can attach a trusted client address to req.
export function assertTrustedProxyRequest(req,startup){
  if(!['candidate','showcase'].includes(startup?.runMode)||startup?.transport!=='trusted-local-proxy')return null;
  const headers=req?.headers||{},expectedHost=new URL(startup.publicOrigin).host;
  const target=req?.url;
  if(!loopback.has(String(req?.socket?.remoteAddress||'').toLowerCase())||
      typeof target!=='string'||!/^\/(?!\/)/.test(target)||target.includes('\\')||target.includes('#')||
      hasRepeatedGuardedHeader(req)||
      typeof headers.host!=='string'||headers.host.toLowerCase()!==expectedHost.toLowerCase()||
      headers['x-forwarded-proto']!=='https'||
      !secretMatches(headers['x-bsr-proxy-secret'],startup.proxySecret))deny();
  const clientIp=headers['x-bsr-client-ip'];
  if(typeof clientIp!=='string'||clientIp!==clientIp.trim()||!isIP(clientIp))deny();
  req.bsrClientIp=clientIp.toLowerCase();
  return req.bsrClientIp;
}
