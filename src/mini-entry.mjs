import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {isInsidePath} from './startup-config.mjs';

const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const off=Object.freeze({status:'off',qrUrl:null});
const paused=Object.freeze({status:'paused',qrUrl:null});
const appIdPattern=/^wx[A-Za-z0-9]{16}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const keyPattern=/^(?:[a-f0-9]{64}|[a-f0-9]{128})$/i;
const page='pages/catalog/index';
const scene='home';
const source='operator-attested';

function invalid(message='小程序发布码及来源凭据无效'){throw new Error(message);}
function crc32(bytes){
  let crc=0xffffffff;
  for(const byte of bytes){
    crc^=byte;
    for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
function validatePng(bytes){
  if(!Buffer.isBuffer(bytes)||!bytes.subarray(0,8).equals(pngSignature))
    invalid('小程序发布码须为完整 PNG 文件');
  let at=8,header=false,data=false,end=false;
  while(at<bytes.length){
    if(bytes.length-at<12)invalid('小程序发布码须为完整 PNG 文件');
    const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);
    const next=at+12+size;
    if(!/^[A-Za-z]{4}$/.test(type)||next>bytes.length)
      invalid('小程序发布码须为完整 PNG 文件');
    if(crc32(bytes.subarray(at+4,at+8+size))!==bytes.readUInt32BE(at+8+size))
      invalid('小程序发布码 PNG 校验失败');
    if(type==='IHDR'){
      if(header||at!==8||size!==13)invalid('小程序发布码 PNG 结构无效');
      const width=bytes.readUInt32BE(at+8),height=bytes.readUInt32BE(at+12);
      if(width<64||height<64||width>4096||height>4096)
        invalid('小程序发布码 PNG 尺寸无效');
      header=true;
    }else if(type==='IDAT'){
      if(!header||size===0||end)invalid('小程序发布码 PNG 结构无效');
      data=true;
    }else if(type==='IEND'){
      if(!header||!data||size!==0||next!==bytes.length)
        invalid('小程序发布码 PNG 结构无效');
      end=true;
    }
    at=next;
  }
  if(!end)invalid('小程序发布码须为完整 PNG 文件');
}
export const validateMiniCodeImage=validatePng;
function privateFile(path,publicDir,maxBytes){
  if(typeof path!=='string'||!isAbsolute(path))
    invalid('小程序发布文件须使用私有绝对路径');
  const projectDir=resolve(publicDir,'..'),projectReal=realpathSync.native(projectDir);
  const target=resolve(path);
  if(isInsidePath(projectDir,target))
    invalid('小程序发布文件须存放在项目目录之外');
  let real,info,bytes;
  try{
    real=realpathSync.native(target);info=statSync(real);
    if(!info.isFile()||isInsidePath(projectReal,real)||info.size<100||info.size>maxBytes)
      invalid();
    bytes=readFileSync(real);
  }catch{invalid('小程序发布文件不可读取或不在私有目录');}
  return bytes;
}
function receiptFields(receipt){
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))invalid();
  const fields=['version','source','appId','page','scene','imageSha256','approvedAt','expiresAt'];
  if(Object.keys(receipt).sort().join(',')!==[...fields,'mac'].sort().join(','))
    invalid();
  const payload=Object.fromEntries(fields.map(name=>[name,receipt[name]]));
  if(payload.version!==1||payload.source!==source||payload.page!==page||payload.scene!==scene||
      !appIdPattern.test(payload.appId)||!digestPattern.test(payload.imageSha256)||
      typeof receipt.mac!=='string'||!digestPattern.test(receipt.mac))invalid();
  const approved=Date.parse(payload.approvedAt),expires=Date.parse(payload.expiresAt),now=Date.now();
  if(!Number.isFinite(approved)||!Number.isFinite(expires)||approved>now+300000||
      expires<=now||expires-approved>365*86400000||expires<=approved)
    invalid('小程序发布凭据过期或时间无效');
  return payload;
}
function checkReceipt(bytes,receiptBytes,appId,attestKey){
  let receipt;
  try{receipt=JSON.parse(receiptBytes.toString('utf8'));}catch{invalid();}
  const payload=receiptFields(receipt);
  if(payload.appId!==appId||
      createHash('sha256').update(bytes).digest('hex')!==payload.imageSha256)invalid();
  const expected=createHmac('sha256',Buffer.from(attestKey,'hex'))
    .update(JSON.stringify(payload)).digest();
  const supplied=Buffer.from(receipt.mac,'hex');
  if(!timingSafeEqual(expected,supplied))invalid();
  return Date.parse(payload.expiresAt);
}

/**
 * A manually placed PNG cannot become a public code. READY requires a
 * private keyed operator receipt tied to the image digest, AppID and public
 * home scene. The receipt protects local approval/integrity; it does not
 * prove WeChat issued the image. Real platform verification remains open.
 */
export function loadMiniEntry(env,{runMode,publicDir}){
  const requested=env.BSR_MINI_ENTRY_STATE??'OFF';
  if(!['OFF','PAUSED','READY'].includes(requested))
    throw new Error('BSR_MINI_ENTRY_STATE 须为 OFF、PAUSED 或 READY');
  if(env.BSR_MINI_ENTRY_STATE===undefined&&env.BSR_MINI_RELEASE_CONFIRMED==='1')
    invalid('旧版发布配置不能开启入口；须显式设置状态与来源凭据');
  if(requested==='OFF')return off;
  if(runMode!=='showcase')throw new Error('小程序扫码入口只允许在独立的合成预览环境配置');
  if(requested==='PAUSED')return paused;
  const appId=env.BSR_MINI_APP_ID,qrFile=env.BSR_MINI_RELEASE_QR_FILE;
  const receiptFile=env.BSR_MINI_RELEASE_RECEIPT_FILE,attestKey=env.BSR_MINI_RELEASE_ATTEST_KEY;
  if(env.BSR_MINI_RELEASE_CONFIRMED!=='1'||env.BSR_WECHAT_MINI_ENABLED!=='1'||
      typeof appId!=='string'||!appIdPattern.test(appId)||env.BSR_WECHAT_APP_ID!==appId||
      typeof attestKey!=='string'||!keyPattern.test(attestKey))
    invalid('小程序入口 READY 配置不完整或身份 AppID 不一致');
  const bytes=privateFile(qrFile,publicDir,2*1024*1024);
  validatePng(bytes);
  const receiptBytes=privateFile(receiptFile,publicDir,4096);
  const expiresAtMs=checkReceipt(bytes,receiptBytes,appId,attestKey);
  return Object.freeze({status:'ready',appId,qrUrl:'/api/mini-entry/code',
    qrBytes:bytes,expiresAtMs});
}

export function effectiveMiniEntry(entry,now=Date.now()){
  if(entry.status==='ready'&&(!Number.isFinite(entry.expiresAtMs)||now>=entry.expiresAtMs))
    return paused;
  return entry;
}

export function miniEntryPublic(entry,now=Date.now()){
  const current=effectiveMiniEntry(entry,now);
  return {status:current.status,qrUrl:current.status==='ready'?current.qrUrl:null};
}
