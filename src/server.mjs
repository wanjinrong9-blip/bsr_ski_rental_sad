import http from 'node:http';
import https from 'node:https';
import { readFile, realpath, stat } from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, hashPassword, verifyPassword, audit, notify } from './db.mjs';
import { DomainError, quote, availability, policyFor, normalizeWindow, createReservation, payReservation, effectiveReservationStatus,
  cancelReservation, pickup, returnRental, approveRefund, transaction } from './domain.mjs';
import { employeeRoles,employees,attendanceView,punch,roster,saveShift,osloDay } from './workforce.mjs';
import { maintenanceList,reportFault,updateMaintenance } from './maintenance.mjs';
import { orderAlertRoles,orderAlerts,markOrderAlertsRead,reservationSignal } from './order-alerts.mjs';
import {damagePolicy} from './damage-policy.mjs';
import {depositFor,depositRule} from './catalog-upgrade.mjs';
import {getCustomerCart,putCustomerCart} from './cart.mjs';
import {orderWorkflow,staffReview,staffReviewVersion,checkDamageSLA} from './order-workflow.mjs';
import {preparation,preparationList,updatePreparation,contracts,issueContract,signContract,printableContract} from './fulfillment.mjs';
import {saveCustomerProfile,customerSearch,staffCustomer,employeeDirectory,saveEmployee,contractorRates,addRate,addStore,intakeUnit,clearCleaning} from './master-data.mjs';
import {amendmentQuote,commitAmendment,proposalList,proposal as amendmentProposal,createProposal,confirmProposal} from './amendments.mjs';
import {damageCases,damageCase,damageOrder,assessDamage,reviewDamage,uploadDamagePhoto,damagePhoto,contactDamageCustomer,recordDamageSupplement} from './damage.mjs';
import {rentalPolicy,rentalLateSummary} from './rental-policy.mjs';
import {isInsidePath} from './startup-config.mjs';
import {validateRuntimeConfig} from './runtime-config.mjs';
import {effectiveMiniEntry,loadMiniEntry,miniEntryPublic} from './mini-entry.mjs';
import {createMiniApi} from './mini-api.mjs';
import {assertTrustedProxyRequest} from './proxy-boundary.mjs';
import {preflightRuntime} from './runtime-provenance.mjs';
import {candidateSessionUser,candidateLogin,candidateLogout,candidateProvisionAccount,candidateChangePassword,
  candidateSetAccountState,candidateResetPassword,invalidateCandidateSessions,requireCandidateOrigin} from './identity.mjs';
import {simulated,simulationNotice} from './simulation.mjs';

const here = resolve(fileURLToPath(new URL('.',import.meta.url)));
const root = resolve(here,'..');
const publicDir = join(root,'public');
const startup=validateRuntimeConfig(process.env,{root,publicDir});
const miniEntry=loadMiniEntry(process.env,{runMode:startup.runMode,publicDir});
preflightRuntime(startup,{requireReady:startup.runMode!=='demo'});
const isCandidate=startup.runMode==='candidate';
const managedSecurity=startup.runMode==='candidate'||startup.runMode==='showcase';
const transactionsBlocked=isCandidate;
const showcase=startup.runMode==='showcase';
const businessResponse=value=>showcase?simulated(value):value;
const damageResponse=value=>showcase&&value?
  simulated({...value,contacts:(value.contacts||[]).map(contact=>simulated(contact))}):value;
const publicRealDir=realpathSync.native(publicDir);
export const db = openDb(startup.dbPath,{runMode:startup.runMode});
const miniApi=createMiniApi({db,runMode:startup.runMode,orderDetail:(id,actor)=>orderDetail(id,actor)});
const {host,port}=startup;
const liveClients=new Set();
const liveEpoch=Date.now().toString(36);let liveRevision=0;
function broadcastChange(path){
  const data=JSON.stringify({revision:`${liveEpoch}:${++liveRevision}`,topic:path.split('/')[2],at:new Date().toISOString()});
  for(const client of liveClients){
    if(managedSecurity&&!candidateSessionUser(db,client.req,{runMode:startup.runMode})){
      client.res.end();liveClients.delete(client);continue;
    }
    client.res.write(`event: change\ndata: ${data}\n\n`);
  }
}

const exchange = {
  NOK:{rate:1,label:'挪威克朗',symbol:'NOK'},
  CNY:{rate:0.68,label:'人民币',symbol:'¥'},
  EUR:{rate:0.085,label:'欧元',symbol:'€'},
  USD:{rate:0.095,label:'美元',symbol:'$'},
  GBP:{rate:0.073,label:'英镑',symbol:'£'},
  JPY:{rate:14.2,label:'日元',symbol:'¥'}
};

function json(res, status, data, extra={}) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra});
  res.end(JSON.stringify(data));
}
function fail(message,status=400) { throw new DomainError(message,status); }
function requireRole(user, roles) {
  if (!user) fail('请先登录',401);
  if (!roles.includes(user.role)) fail('没有执行此操作的权限',403);
}
function requireStore(user,storeId) {
  requireRole(user,['staff','manager']);
  if(Number(user.store_id)!==Number(storeId))fail('没有操作此门店业务的权限',403);
}
function requireOrder(user,id) {
  if(!user)fail('请先登录',401);
  const row=db.prepare('SELECT id,user_id,store_id,status,code,pickup_code,return_at FROM reservations WHERE id=?').get(id);
  if(row&&user.role==='customer'&&row.user_id===user.id)return row;
  if(row&&['staff','manager'].includes(user.role)&&Number(row.store_id)===Number(user.store_id))return row;
  fail('订单不存在或无权访问',404);
}
function cookieValue(req,name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1) || '';
}
function currentUser(req) {
  if(managedSecurity)return candidateSessionUser(db,req,{runMode:startup.runMode});
  const token = req.headers['x-bsr-session'] || cookieValue(req,'bsr_session');
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  return db.prepare(`SELECT u.id,u.name,u.email,u.role,u.store_id,u.phone,u.height_cm,u.weight_kg,u.shoe_size
    ,u.address,u.birth_year FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .get(hash,new Date().toISOString()) || null;
}
async function body(req,limit=1000000) {
  if(Number(req.headers['content-length']||0)>limit)fail('请求内容过大',413);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) fail('请求内容过大',413);
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { fail('JSON 格式错误'); }
}
function safeUser(user) {
  if (!user) return null;
  return {id:user.id,name:user.name,email:user.email,role:user.role,storeId:user.store_id,
    phone:user.phone,address:user.address,birthYear:user.birth_year,heightCm:user.height_cm,weightKg:user.weight_kg,shoeSize:user.shoe_size,
    mustChangePassword:managedSecurity&&Boolean(user.must_change_password)};
}
function orderDetail(id,user=null) {
  const order = db.prepare(`SELECT r.*,u.name AS customer_name,u.phone AS customer_phone,u.email AS customer_email,s.name AS store_name FROM reservations r
    JOIN users u ON u.id=r.user_id JOIN stores s ON s.id=r.store_id WHERE r.id=?`).get(id);
  if (!order) return null;
  order.status=effectiveReservationStatus(order);
  if(['staff','manager'].includes(user?.role))order.customerContact={name:order.customer_name,phone:order.customer_phone,email:order.customer_email};
  delete order.customer_phone;delete order.customer_email;
  order.lines = db.prepare(`SELECT ri.*,v.name,v.category,v.size,v.visual FROM reservation_items ri
    JOIN variants v ON v.id=ri.variant_id WHERE ri.reservation_id=?`).all(id);
  order.units = db.prepare(`SELECT ru.unit_id,ru.returned,ru.out_at,ru.returned_at,ru.return_store_id,u.inventory_no,u.status,v.name,v.size
    FROM rental_units ru JOIN reservation_items ri ON ri.id=ru.reservation_item_id
    JOIN units u ON u.id=ru.unit_id JOIN variants v ON v.id=ri.variant_id WHERE ri.reservation_id=?`).all(id);
  order.inspections = db.prepare('SELECT * FROM inspections WHERE reservation_id=?').all(id);
  order.payments = db.prepare('SELECT id,type,amount_nok,status,provider_ref,created_at FROM payments WHERE reservation_id=? ORDER BY id').all(id)
    .map(payment=>businessResponse(payment));
  order.quote = JSON.parse(order.quote_json);
  delete order.quote_json;
  order.late=rentalLateSummary(db,id);
  if(user)order.damage=damageResponse(damageOrder(db,user,id));
  if(user)order.workflow=orderWorkflow(db,user,order);
  if(user&&['staff','manager'].includes(user.role))order.staffReviewVersion=staffReviewVersion(db,id);
  if(user){order.preparation=preparation(db,user,id);order.contracts=contracts(db,user,id);order.adjustments=db.prepare('SELECT * FROM contract_adjustments WHERE reservation_id=? ORDER BY id').all(id).map(a=>({...a,detail:JSON.parse(a.detail_json),detail_json:undefined}));order.amendmentProposals=proposalList(db,user,id).items;}
  if(user&&user.role!=='customer')order.attention=reservationSignal(db,user,order);
  return businessResponse(order);
}
function requestWindow(url) {
  let pickupAt = url.searchParams.get('pickupAt');
  let returnAt = url.searchParams.get('returnAt');
  if (!pickupAt || !returnAt) {
    const start = new Date(Date.now()+86400000);
    start.setUTCHours(9,0,0,0);
    pickupAt = start.toISOString();
    returnAt = new Date(start.getTime()+86400000).toISOString();
  }
  return normalizeWindow(pickupAt,returnAt);
}
function checkMutationOrigin(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) fail('请求来源不受信任',403);
}
async function api(req,res,url) {
  const path = url.pathname;
  const method = req.method;
  // Mini Bearer requests have their own identity and mutation boundary. The
  // trusted proxy check has already run in requestHandler.
  if(path.startsWith('/api/mini/'))return miniApi.handle(req,res,url,{body,json});
  const user = currentUser(req);
  if (path==='/api/health') return json(res,200,isCandidate?
    {ok:true,service:'BSR candidate (loopback only)',build:'2026.11-candidate-identity',runMode:'candidate'}:
    startup.runMode==='showcase'?
      {ok:true,service:'BSR synthetic showcase (loopback only)',build:'2026.11-showcase-boundary',runMode:'showcase'}:
      {ok:true,service:'BSR local preview',build:'2026.11-local-preview-guard'});
  if(path==='/api/mini-entry'&&method==='GET')
    return json(res,200,miniEntryPublic(miniEntry));
  if(path==='/api/mini-entry/code'&&method==='GET'){
    const currentMiniEntry=effectiveMiniEntry(miniEntry);
    if(currentMiniEntry.status!=='ready')fail('小程序入口尚未就绪',404);
    res.writeHead(200,{'content-type':'image/png','cache-control':'no-store',
      'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"});
    res.end(currentMiniEntry.qrBytes);return;
  }
  if(path==='/api/events'&&method==='GET') {
    if(managedSecurity&&(!user||user.must_change_password))fail('请先登录并更换一次性凭据',401);
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
    res.write(`event: connected\ndata: ${JSON.stringify({revision:`${liveEpoch}:${liveRevision}`,at:new Date().toISOString()})}\n\n`);
    const client={req,res};liveClients.add(client);
    const heartbeat=setInterval(()=>{
      if(managedSecurity&&!candidateSessionUser(db,req,{runMode:startup.runMode})){res.end();clearInterval(heartbeat);liveClients.delete(client);}
      else res.write(': heartbeat\n\n');
    },20000);
    req.on('close',()=>{clearInterval(heartbeat);liveClients.delete(client);});return;
  }
  if (path==='/api/bootstrap' && method==='GET') {
    const stores = db.prepare('SELECT * FROM stores ORDER BY id').all();
    if(isCandidate)return json(res,200,{stores,user:safeUser(user),
      exchange:{NOK:exchange.NOK},exchangeSource:'仅 NOK；商业汇率未批准',exchangeUpdatedAt:null,
      demo:false,runMode:'candidate',capabilities:{selfRegistration:false,selfRecovery:false,bookingEnabled:false},
      damagePolicy:null,depositRule:null,rentalPolicy:null});
    if(showcase)return json(res,200,{stores,user:safeUser(user),
      exchange:{NOK:exchange.NOK},exchangeSource:'合成预览仅以 NOK 记账',exchangeUpdatedAt:null,
      demo:false,synthetic:true,runMode:'showcase',capabilities:{selfRegistration:false,selfRecovery:false,bookingEnabled:true},
      notice:simulationNotice,damagePolicy,depositRule,rentalPolicy});
    return json(res,200,{stores,user:safeUser(user),exchange,
      exchangeSource:'演示汇率快照（非实时市场数据）',exchangeUpdatedAt:'2026-10-25T00:00:00+02:00',
      demo:true,runMode:'demo',damagePolicy,depositRule,rentalPolicy,
      demoLogin:{password:'Demo123!',accounts:Object.fromEntries(
        ['customer','staff','manager','contractor','owner','admin'].map(role=>[role,role+'@bsr.demo']))}});
  }
  if (method!=='GET' && method!=='HEAD') {
    if(managedSecurity){
      try{requireCandidateOrigin(req,startup.publicOrigin);}
      catch(error){
        if(error.code==='UNTRUSTED_ORIGIN')audit(db,user?.id??null,'UNTRUSTED_ORIGIN','security',null,
          {reason:req.headers.origin?'mismatch':'missing'});
        throw error;
      }
    }
    else checkMutationOrigin(req);
  }
  if(managedSecurity&&user?.must_change_password&&!(path==='/api/me'&&method==='GET')&&
    !['/api/auth/logout','/api/auth/change-password'].includes(path))
    fail('请先更换一次性凭据',403);
  if(transactionsBlocked&&method!=='GET'&&method!=='HEAD'&&(
    /^\/api\/reservations\/\d+\/(?:contracts|amendments(?:\/quote|\/proposals(?:\/\d+(?:\/confirm)?)?)?|pay|cancel|damage\/supplement|staff-review)$/.test(path)||
    /^\/api\/contracts\/\d+\/sign$/.test(path)||
    /^\/api\/operations\/(?:pickup|return|refunds\/\d+\/approve)$/.test(path)||
    /^\/api\/damage-cases\/\d+\/review$/.test(path)))
    fail('正式候选尚未批准交易、签署和结算流程',409);
  if(path==='/api/preparations'&&method==='GET'){requireRole(user,['staff','manager']);return json(res,200,preparationList(db,user));}
  const prepPath=path.match(/^\/api\/preparations\/(\d+)$/);
  if(prepPath){requireRole(user,['customer','staff','manager']);if(method==='GET')return json(res,200,preparation(db,user,Number(prepPath[1])));if(method==='PATCH')return json(res,200,updatePreparation(db,user,Number(prepPath[1]),await body(req)));}
  const issuePath=path.match(/^\/api\/reservations\/(\d+)\/contracts$/);
  if(issuePath){requireRole(user,['customer','staff','manager']);if(method==='GET')return json(res,200,contracts(db,user,Number(issuePath[1])));if(method==='POST')return json(res,201,issueContract(db,user,Number(issuePath[1])));}
  const contractPath=path.match(/^\/api\/contracts\/(\d+)\/(sign|print)$/);
  if(contractPath){requireRole(user,['customer','staff','manager']);if(contractPath[2]==='sign'&&method==='POST')return json(res,200,signContract(db,user,Number(contractPath[1]),await body(req)));if(contractPath[2]==='print'&&method==='GET'){const html=printableContract(db,user,Number(contractPath[1]));res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});return res.end(html);}}
  const amendPath=path.match(/^\/api\/reservations\/(\d+)\/amendments(?:\/(quote))?$/);
  if(amendPath&&method==='POST'){requireRole(user,['staff','manager']);const input=await body(req);return json(res,amendPath[2]?200:201,businessResponse(amendPath[2]?amendmentQuote(db,user,Number(amendPath[1]),input):commitAmendment(db,user,Number(amendPath[1]),input)));}
  const proposalPath=path.match(/^\/api\/reservations\/(\d+)\/amendments\/proposals(?:\/(\d+)(?:\/(confirm))?)?$/);
  if(proposalPath){
    requireRole(user,['customer','staff','manager']);const id=Number(proposalPath[1]),proposalId=proposalPath[2]?Number(proposalPath[2]):null;
    if(!proposalId&&method==='GET'){
      const list=proposalList(db,user,id);
      return json(res,200,showcase?businessResponse({...list,items:list.items.map(businessResponse)}):list);
    }
    if(!proposalId&&method==='POST'){requireRole(user,['staff','manager']);const created=createProposal(db,user,id,await body(req),req.headers['idempotency-key']);return json(res,created.replayed?200:201,businessResponse(created));}
    if(proposalId&&method==='GET'&&!proposalPath[3])return json(res,200,businessResponse(amendmentProposal(db,user,id,proposalId)));
    if(proposalId&&proposalPath[3]==='confirm'&&method==='POST'){requireRole(user,['customer']);return json(res,200,businessResponse(confirmProposal(db,user,id,proposalId,await body(req))));}
  }
  if(path==='/api/customers/search'&&method==='GET'){requireRole(user,['staff','manager']);return json(res,200,customerSearch(db,user,url.searchParams.get('q')));}
  if(path==='/api/customers'&&method==='POST'){
    if(managedSecurity)fail('受管理账号须由管理员开通',403);
    requireRole(user,['staff','manager']);return json(res,201,staffCustomer(db,user,await body(req)));
  }
  if(path==='/api/operations/reservations'&&method==='POST'){
    if(transactionsBlocked)fail('正式候选尚无获批准的预约与交易政策',409);
    requireRole(user,['staff','manager']);const input=await body(req);requireStore(user,input.storeId);const created=createReservation(db,Number(input.customerId),input,user.id,req.headers['idempotency-key']);return json(res,created.replayed?200:201,businessResponse(created));
  }
  const counterPay=path.match(/^\/api\/operations\/reservations\/(\d+)\/pay$/);
  if(counterPay&&method==='POST'){
    if(transactionsBlocked)fail('正式候选未接入真实收款服务',409);
    requireRole(user,['staff','manager']);const id=Number(counterPay[1]);requireOrder(user,id);const input=await body(req),o=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);if(input.confirmed!==true||String(input.reference||'').trim().length<5)fail('请核实演示收款并填写凭证');if(!db.prepare('SELECT signed_at FROM contracts WHERE reservation_id=? AND version=?').get(id,o.contract_version)?.signed_at)fail('现场开单须先签署合同，再确认演示付款',409);const paid=payReservation(db,o.user_id,id,user.id);audit(db,user.id,'COUNTER_PAYMENT_CONFIRMED','reservation',id,{reference:input.reference});return json(res,200,businessResponse(paid));
  }
  if(path==='/api/employee-directory'&&method==='GET'){requireRole(user,['manager','admin','owner']);return json(res,200,employeeDirectory(db,user));}
  if(path==='/api/employee-directory'&&method==='POST'){
    if(managedSecurity)fail('受管理账号须通过管理员开通流程',403);
    requireRole(user,['manager','admin']);return json(res,201,saveEmployee(db,user,await body(req)));
  }
  const employeePath=path.match(/^\/api\/employee-directory\/(\d+)$/);if(employeePath&&method==='PATCH'){requireRole(user,['manager','admin']);return json(res,200,saveEmployee(db,user,await body(req),Number(employeePath[1]),managedSecurity));}
  if(path==='/api/contractor-rates'&&method==='GET'){requireRole(user,['manager','owner','admin','contractor']);return json(res,200,contractorRates(db,user));}
  if(path==='/api/contractor-rates'&&method==='POST'){requireRole(user,['manager']);return json(res,201,addRate(db,user,await body(req)));}
  if(path==='/api/stores'&&method==='POST'){requireRole(user,['manager','admin']);return json(res,201,addStore(db,user,await body(req)));}
  if(path==='/api/inventory'&&method==='POST'){requireRole(user,['manager']);return json(res,201,intakeUnit(db,user,await body(req)));}
  const cleanPath=path.match(/^\/api\/inventory\/(\d+)\/clean$/);if(cleanPath&&method==='POST'){requireRole(user,['staff','manager']);return json(res,200,clearCleaning(db,user,Number(cleanPath[1]),await body(req)));}
  const staffReviewPath=path.match(/^\/api\/reservations\/(\d+)\/staff-review$/);
  if(staffReviewPath&&method==='POST'){requireRole(user,['staff','manager']);requireOrder(user,Number(staffReviewPath[1]));return json(res,200,staffReview(db,user,Number(staffReviewPath[1]),await body(req)));}
  if(path==='/api/damage-policy'&&method==='GET'){
    if(transactionsBlocked)return json(res,409,{error:'正式候选尚无 BSR 批准的损坏收费政策',code:'POLICY_NOT_APPROVED'});
    return json(res,200,damagePolicy);
  }
  if(path==='/api/damage-cases'&&method==='GET'){
    requireRole(user,orderAlertRoles);return json(res,200,damageCases(db,user));
  }
  const damageCasePath=path.match(/^\/api\/damage-cases\/(\d+)(?:\/(photos|review))?$/);
  if(damageCasePath){
    requireRole(user,['customer','staff','manager','contractor']);const id=Number(damageCasePath[1]),action=damageCasePath[2];
    if(!action&&method==='GET')return json(res,200,businessResponse(damageCase(db,user,id)));
    if(!action&&method==='PATCH')return json(res,200,businessResponse(assessDamage(db,user,id,await body(req))));
    if(action==='review'&&method==='POST')return json(res,200,businessResponse(reviewDamage(db,user,id,await body(req))));
    if(action==='photos'&&method==='POST')return json(res,201,businessResponse(uploadDamagePhoto(db,user,id,await body(req,4300000))));
  }
  const photoPath=path.match(/^\/api\/damage-photos\/(\d+)$/);
  if(photoPath&&method==='GET'){
    requireRole(user,['customer','staff','manager','contractor']);const photo=damagePhoto(db,user,Number(photoPath[1]));
    res.writeHead(200,{'content-type':photo.mime,'content-length':photo.image.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(Buffer.from(photo.image));return;
  }
  const damageOrderPath=path.match(/^\/api\/reservations\/(\d+)\/damage(?:\/(contact|supplement))?$/);
  if(damageOrderPath){
    requireRole(user,['customer','staff','manager']);const id=Number(damageOrderPath[1]),action=damageOrderPath[2];
    if(!action&&method==='GET')return json(res,200,damageResponse(damageOrder(db,user,id)));
    if(action==='contact'&&method==='POST')return json(res,200,damageResponse(contactDamageCustomer(db,user,id,await body(req))));
    if(action==='supplement'&&method==='POST')return json(res,200,businessResponse(recordDamageSupplement(db,user,id,await body(req))));
  }
  if (path==='/api/auth/login' && method==='POST') {
    const input = await body(req);
    if(managedSecurity){
      const result=candidateLogin(db,req,input,{runMode:startup.runMode});
      return json(res,200,{user:safeUser(result.user)},{'set-cookie':result.cookie});
    }
    const account = db.prepare('SELECT * FROM users WHERE email=?').get(String(input.email||'').toLowerCase().trim());
    if (!account || !verifyPassword(String(input.password||''),account.password_hash)) fail('账号或密码错误',401);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'),account.id,new Date(Date.now()+7*86400000).toISOString());
    audit(db,account.id,'LOGIN','user',account.id);
    return json(res,200,{user:safeUser(account),sessionToken:token},
      {'set-cookie':`bsr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`});
  }
  if (path==='/api/auth/register' && method==='POST') {
    if(managedSecurity)return json(res,403,{error:'受管理环境尚未启用顾客自助注册，请联系管理员核验身份',
      code:'SELF_REGISTRATION_DISABLED'});
    const input = await body(req);
    const name = String(input.name||'').trim(), email = String(input.email||'').toLowerCase().trim();
    if (name.length<2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || String(input.password||'').length<8)
      fail('请填写姓名、有效邮箱和至少 8 位密码');
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail('该邮箱已注册',409);
    const id = Number(db.prepare("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,'customer',?)")
      .run(name,email,hashPassword(input.password),new Date().toISOString()).lastInsertRowid);
    audit(db,id,'REGISTER','user',id);
    return json(res,201,{id,message:'注册成功，请登录'});
  }
  if(path==='/api/auth/change-password'&&method==='POST'){
    if(!managedSecurity)fail('接口不存在',404);
    requireRole(user,['customer','staff','manager','contractor','owner','admin']);
    const result=candidateChangePassword(db,user,await body(req),{runMode:startup.runMode});
    return json(res,200,{ok:true},{'set-cookie':result.cookie});
  }
  if (path==='/api/auth/logout' && method==='POST') {
    if(managedSecurity){
      const result=candidateLogout(db,req,{runMode:startup.runMode});
      return json(res,200,{ok:true},{'set-cookie':result.cookie});
    }
    const token = req.headers['x-bsr-session'] || cookieValue(req,'bsr_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));
    return json(res,200,{ok:true},{'set-cookie':'bsr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  if (path==='/api/me' && method==='GET') { requireRole(user,['customer','staff','manager','contractor','owner','admin']); return json(res,200,safeUser(user)); }
  if(path==='/api/cart'&&method==='GET'){
    if(transactionsBlocked)fail('候选环境尚未开放租赁购物车',403);
    requireRole(user,['customer']);return json(res,200,getCustomerCart(db,user));
  }
  if(path==='/api/cart'&&method==='PUT'){
    if(transactionsBlocked)fail('候选环境尚未开放租赁购物车',403);
    requireRole(user,['customer']);return json(res,200,putCustomerCart(db,user,await body(req)));
  }
  if (path==='/api/me' && method==='PATCH') {
    requireRole(user,['customer','staff','manager','contractor','owner','admin']);
    const input = await body(req);
    return json(res,200,saveCustomerProfile(db,user,input));
  }
  if (path==='/api/region' && method==='POST') {
    if(managedSecurity)return json(res,200,{currency:'NOK',region:isCandidate?'正式候选':'合成预览',precision:'仅 NOK 记账；定位换算不用于订单金额'});
    const input = await body(req);
    const lat=Number(input.latitude),lon=Number(input.longitude);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) fail('定位数据无效');
    // 演示版只做国家级粗略边界推荐，不保存经纬度，也不用于正式定价。
    let currency='NOK',region='其他地区';
    if (lat>=57 && lat<=72 && lon>=4 && lon<=32) {currency='NOK';region='挪威';}
    else if(lat>=18&&lat<=54&&lon>=73&&lon<=135){currency='CNY';region='中国';}
    else if(lat>=24&&lat<=50&&lon>=-125&&lon<=-66){currency='USD';region='美国';}
    else if(lat>=35&&lat<=46&&lon>=129&&lon<=146){currency='JPY';region='日本';}
    else if(lat>=49&&lat<=59&&lon>=-9&&lon<=2){currency='GBP';region='英国';}
    else if(lat>=35&&lat<=71&&lon>=-12&&lon<=35){currency='EUR';region='欧洲';}
    return json(res,200,{currency,region,precision:'演示版粗略国家级识别；可手动覆盖'});
  }
  if (path==='/api/catalog' && method==='GET') {
    if(transactionsBlocked)return json(res,200,{storeId:null,pickupAt:null,returnAt:null,items:[]});
    if(startup.runMode==='showcase')requireRole(user,['customer','staff','manager','contractor','owner','admin']);
    const storeId=Number(url.searchParams.get('storeId')||1);
    if (!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId)) fail('门店不存在');
    const win=requestWindow(url);
    const available=availability(db,storeId,win.pickupAt,win.returnAt);
    const rows=db.prepare('SELECT * FROM variants WHERE active=1 ORDER BY category,id').all();
    return json(res,200,{storeId,...win,items:rows.map(v=>{
      const p=policyFor(db,v.id,storeId,win.pickupAt);
      return {...v,available:available.get(v.id)||0,dailyNok:p?.daily_nok??null,
        depositNok:p?depositFor(v,p.daily_nok):null,depositRate:depositRule.rate,depositBasis:depositRule.basis,policyVersion:p?.version??null};
    })});
  }
  if (path==='/api/quote' && method==='POST') {
    if(transactionsBlocked)fail('正式候选尚无获批准的预约与交易政策',409);
    if(startup.runMode==='showcase')requireRole(user,['customer','staff','manager']);
    return json(res,200,quote(db,await body(req)));
  }
  if (path==='/api/reservations' && method==='POST') {
    if(transactionsBlocked)fail('正式候选尚无获批准的预约与交易政策',409);
    requireRole(user,['customer']); const created=createReservation(db,user.id,await body(req),null,req.headers['idempotency-key']);return json(res,created.replayed?200:201,businessResponse(created));
  }
  if (path==='/api/reservations' && method==='GET') {
    requireRole(user,['customer','staff','manager']);
    const rows=user.role==='customer'?
      db.prepare('SELECT id FROM reservations WHERE user_id=? ORDER BY id DESC').all(user.id):
      db.prepare('SELECT id FROM reservations WHERE store_id=? ORDER BY id DESC LIMIT 150').all(user.store_id);
    return json(res,200,rows.map(row=>orderDetail(row.id,user)));
  }
  const orderPath=path.match(/^\/api\/reservations\/(\d+)(?:\/(pay|cancel))?$/);
  if (orderPath) {
    requireRole(user,['customer','staff','manager']);
    const id=Number(orderPath[1]),action=orderPath[2];
    if (!action && method==='GET') {
      requireOrder(user,id);
      const order=orderDetail(id,user);
      return json(res,200,order);
    }
    requireRole(user,['customer']);
    if (action==='pay'&&method==='POST'){
      if(transactionsBlocked)fail('正式候选未接入真实收款服务',409);
      return json(res,200,businessResponse(payReservation(db,user.id,id)));
    }
    if (action==='cancel'&&method==='POST') return json(res,200,businessResponse(cancelReservation(db,user.id,id)));
  }
  if (path==='/api/operations/lookup' && method==='GET') {
    requireRole(user,['staff','manager']);
    const code=String(url.searchParams.get('code')||'').trim().toUpperCase();
    if(code.length<6||code.length>100)fail('请输入完整订单号或取货码');
    const row=db.prepare('SELECT id,code,pickup_code,store_id,status,return_at FROM reservations WHERE pickup_code=? OR code=?').get(code,code);
    if (!row) fail('未找到可办理的订单',404);
    if(Number(row.store_id)!==Number(user.store_id)){
      if(row.status!=='ACTIVE')fail('未找到可办理的订单',404);
      const units=db.prepare(`SELECT ru.unit_id,u.inventory_no,v.name,v.size FROM rental_units ru
        JOIN reservation_items ri ON ri.id=ru.reservation_item_id JOIN units u ON u.id=ru.unit_id
        JOIN variants v ON v.id=ri.variant_id WHERE ri.reservation_id=? AND ru.returned=0 ORDER BY ru.unit_id`).all(row.id);
      if(!units.length)fail('当前没有待归还装备',409);
      return json(res,200,{crossStoreReturn:true,id:row.id,code:row.code,store_id:row.store_id,status:row.status,
        return_at:row.return_at,receivingStoreId:user.store_id,units});
    }
    return json(res,200,orderDetail(row.id,user));
  }
  if (path==='/api/operations/pickup' && method==='POST') {
    requireRole(user,['staff','manager']);
    const input=await body(req),code=String(input.code||'').trim().toUpperCase();
    const row=db.prepare('SELECT id FROM reservations WHERE pickup_code=? OR code=?').get(code,code);
    if(!row)fail('订单不存在或无权访问',404);
    requireOrder(user,row.id);
    return json(res,200,businessResponse(pickup(db,user.id,code)));
  }
  if (path==='/api/operations/return' && method==='POST') {
    requireRole(user,['staff','manager']); const input=await body(req);
    const id=Number(input.reservationId),row=db.prepare('SELECT id,store_id,status,code,pickup_code FROM reservations WHERE id=?').get(id);
    if(!row)fail('订单不存在或无权访问',404);
    requireStore(user,input.returnStoreId??user.store_id);
    const crossStore=Number(row.store_id)!==Number(user.store_id);
    if(crossStore){
      const code=String(input.code||'').trim().toUpperCase();
      if(!code||(code!==row.code&&code!==row.pickup_code)||row.status!=='ACTIVE')fail('订单不存在或无权访问',404);
    }
    const result=returnRental(db,user.id,id,input.items,user.store_id);
    if(crossStore)return json(res,200,businessResponse({id,receivedAt:new Date().toISOString(),returnStoreId:user.store_id,
      items:input.items.map(item=>({unitId:Number(item.unitId),condition:item.condition})),status:result.status,remaining:result.remaining??0}));
    return json(res,200,businessResponse(result));
  }
  const approvePath=path.match(/^\/api\/operations\/refunds\/(\d+)\/approve$/);
  if (approvePath&&method==='POST') {
    requireRole(user,['manager']); requireOrder(user,Number(approvePath[1]));return json(res,200,businessResponse(approveRefund(db,user.id,Number(approvePath[1]))));
  }
  if(path==='/api/inventory/summary'&&method==='GET'){
    requireRole(user,['staff','manager','owner','admin']);
    return json(res,200,db.prepare('SELECT store_id,status,COUNT(*) AS count FROM units GROUP BY store_id,status ORDER BY store_id,status').all());
  }
  if (path==='/api/inventory' && method==='GET') {
    requireRole(user,['staff','manager','owner','admin']);
    if(['owner','admin'].includes(user.role))return json(res,200,db.prepare('SELECT store_id,status,COUNT(*) AS count FROM units GROUP BY store_id,status ORDER BY store_id,status').all());
    return json(res,200,db.prepare(`SELECT u.*,v.name,v.category,v.size,s.name AS store_name,EXISTS(SELECT 1 FROM preparation_units pu WHERE pu.unit_id=u.id AND pu.active=1) AS preparation_reserved
      FROM units u JOIN variants v ON v.id=u.variant_id JOIN stores s ON s.id=u.store_id WHERE u.store_id=? ORDER BY u.id`).all(user.store_id));
  }
  if(path==='/api/inventory/movements'&&method==='GET') {
    requireRole(user,['staff','manager']);
    return json(res,200,db.prepare(`SELECT e.*,u.inventory_no,v.name AS variant_name,a.name AS from_store,b.name AS to_store FROM stock_events e JOIN units u ON u.id=e.unit_id JOIN variants v ON v.id=u.variant_id JOIN stores a ON a.id=e.from_store_id JOIN stores b ON b.id=e.to_store_id WHERE e.from_store_id=? OR e.to_store_id=? ORDER BY e.id DESC LIMIT 40`).all(user.store_id,user.store_id));
  }
  if (path==='/api/maintenance' && method==='GET') {
    requireRole(user,['staff','manager','contractor']);
    return json(res,200,maintenanceList(db,user));
  }
  if (path==='/api/maintenance' && method==='POST') {
    requireRole(user,['staff','manager']);return json(res,201,reportFault(db,user,await body(req),managedSecurity));
  }
  const maintenancePath=path.match(/^\/api\/maintenance\/(\d+)$/);
  if (maintenancePath&&method==='PATCH') {
    requireRole(user,['contractor','manager']);return json(res,200,updateMaintenance(db,user,Number(maintenancePath[1]),await body(req),managedSecurity));
  }
  if(path==='/api/transfers'&&method==='GET') {
    requireRole(user,['staff','manager']);
    return json(res,200,db.prepare(`SELECT t.*,u.inventory_no,v.name AS variant_name,
      a.name AS from_store,b.name AS to_store FROM transfers t JOIN units u ON u.id=t.unit_id
      JOIN variants v ON v.id=u.variant_id JOIN stores a ON a.id=t.from_store_id
      JOIN stores b ON b.id=t.to_store_id WHERE t.from_store_id=? OR t.to_store_id=? ORDER BY t.id DESC`).all(user.store_id,user.store_id));
  }
  if(path==='/api/transfers'&&method==='POST') {
    requireRole(user,['manager']); const input=await body(req);
    const unit=db.prepare('SELECT * FROM units WHERE id=?').get(Number(input.unitId));
    if(unit)requireStore(user,unit.store_id);
    if(!unit||unit.status!=='AVAILABLE'||unit.needs_cleaning||db.prepare('SELECT 1 FROM preparation_units WHERE unit_id=? AND active=1').get(unit.id)) fail('仅可调拨未备货占用且已清洁的可用单件',409);
    const target=Number(input.toStoreId);
    if(!db.prepare('SELECT id FROM stores WHERE id=?').get(target)||target===unit.store_id) fail('目标门店无效');
    const id=transaction(db,()=>{
      db.prepare("UPDATE units SET status='TRANSFER' WHERE id=?").run(unit.id);
      const result=db.prepare(`INSERT INTO transfers(unit_id,from_store_id,to_store_id,status,created_by,created_at)
        VALUES(?,?,?,'IN_TRANSIT',?,?)`).run(unit.id,unit.store_id,target,user.id,new Date().toISOString());
      const transferId=Number(result.lastInsertRowid);
      audit(db,user.id,'TRANSFER_DISPATCHED','transfer',transferId,{unitId:unit.id,toStoreId:target});
      return transferId;
    });
    return json(res,201,{id,status:'IN_TRANSIT'});
  }
  const receivePath=path.match(/^\/api\/transfers\/(\d+)\/receive$/);
  if(receivePath&&method==='POST') {
    requireRole(user,['staff','manager']); const id=Number(receivePath[1]);
    const transfer=db.prepare('SELECT * FROM transfers WHERE id=?').get(id);
    if(!transfer||transfer.status!=='IN_TRANSIT') fail('调拨单不可接收',409);
    requireStore(user,transfer.to_store_id);
    transaction(db,()=>{
      db.prepare("UPDATE transfers SET status='RECEIVED',received_at=? WHERE id=?").run(new Date().toISOString(),id);
      db.prepare("UPDATE units SET store_id=?,home_store_id=?,status='AVAILABLE' WHERE id=?").run(transfer.to_store_id,transfer.to_store_id,transfer.unit_id);
      audit(db,user.id,'TRANSFER_RECEIVED','transfer',id,{unitId:transfer.unit_id});
    });
    return json(res,200,{id,status:'RECEIVED'});
  }
  if(path==='/api/policies'&&method==='GET') {
    requireRole(user,['manager','owner','admin']);
    if(transactionsBlocked)return json(res,200,[]);
    return json(res,200,db.prepare(`SELECT p.*,v.name,v.size,v.retail_nok,s.name AS store_name FROM price_policies p
      JOIN variants v ON v.id=p.variant_id JOIN stores s ON s.id=p.store_id ORDER BY p.id DESC`).all().map(p=>({...p,legacy_deposit_nok:p.deposit_nok,deposit_nok:depositFor(p,p.daily_nok),deposit_rate:depositRule.rate})));
  }
  if(path==='/api/policies'&&method==='POST') {
    if(transactionsBlocked)fail('正式候选价目尚待 BSR 批准',409);
    requireRole(user,['manager']); const input=await body(req);
    const variantId=Number(input.variantId),storeId=Number(input.storeId),daily=Number(input.dailyNok);
    requireStore(user,storeId);
    const variant=db.prepare('SELECT * FROM variants WHERE id=?').get(variantId),deposit=variant?depositFor(variant,daily):0;
    if(!db.prepare('SELECT id FROM variants WHERE id=?').get(variantId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId)) fail('装备或门店无效');
    if(!Number.isInteger(daily)||daily<0||!Number.isInteger(deposit)||deposit<0) fail('租金与押金必须为非负整数 NOK');
    const factor=Number(input.extraDayFactor??0.8);
    if(factor<0||factor>1.5) fail('续租日系数须在 0–1.5 之间');
    const effective=String(input.effectiveFrom||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(effective)) fail('生效日期格式无效');
    const approved=transaction(db,()=>{
      const version=(db.prepare('SELECT MAX(version) AS n FROM price_policies WHERE variant_id=? AND store_id=?').get(variantId,storeId).n||0)+1;
      const id=Number(db.prepare(`INSERT INTO price_policies(variant_id,store_id,version,daily_nok,deposit_nok,extra_day_factor,effective_from,status,approved_by,created_at)
        VALUES(?,?,?,?,?,?,?,'APPROVED',?,?)`).run(variantId,storeId,version,daily,deposit,factor,effective,user.id,new Date().toISOString()).lastInsertRowid);
      audit(db,user.id,'PRICE_POLICY_APPROVED','price_policy',id,{version,daily,deposit,effective});
      return {id,version,status:'APPROVED'};
    });
    return json(res,201,approved);
  }
  if(path==='/api/shifts'&&method==='GET') {
    requireRole(user,employeeRoles);
    const sql=`SELECT sh.*,u.name AS employee_name,u.role,s.name AS store_name FROM shifts sh JOIN users u ON u.id=sh.user_id JOIN stores s ON s.id=sh.store_id`;
    return json(res,200,['staff','contractor'].includes(user.role)?db.prepare(sql+' WHERE sh.user_id=? ORDER BY sh.work_date DESC').all(user.id):user.role==='manager'?db.prepare(sql+" WHERE sh.store_id=? AND ((u.role='contractor' AND (u.store_id IS NULL OR u.store_id=?)) OR (u.role IN ('staff','manager') AND u.store_id=?)) ORDER BY sh.work_date DESC").all(user.store_id,user.store_id,user.store_id):db.prepare(sql+' ORDER BY sh.work_date DESC').all());
  }
  if(path==='/api/shifts'&&method==='POST') {
    requireRole(user,['manager']);return json(res,201,saveShift(db,user,await body(req)));
  }
  const shiftPath=path.match(/^\/api\/shifts\/(\d+)$/);
  if(shiftPath&&method==='PATCH') {
    requireRole(user,['manager']);return json(res,200,saveShift(db,user,await body(req),Number(shiftPath[1])));
  }
  if(path==='/api/employees'&&method==='GET') {
    requireRole(user,employeeRoles);return json(res,200,employees(db,user));
  }
  if(path==='/api/attendance'&&method==='GET') {
    requireRole(user,employeeRoles);return json(res,200,attendanceView(db,user));
  }
  if(path==='/api/attendance'&&method==='POST') {
    requireRole(user,employeeRoles);return json(res,200,punch(db,user,await body(req)));
  }
  if(path==='/api/roster'&&method==='GET') {
    requireRole(user,employeeRoles);return json(res,200,roster(db,user,url.searchParams.get('date')||osloDay(),Number(url.searchParams.get('storeId')||0)));
  }
  if(path==='/api/users'&&method==='GET') {
    requireRole(user,['admin']);
    return json(res,200,db.prepare(managedSecurity?
      'SELECT id,name,email,role,store_id,created_at,account_state,must_change_password FROM users ORDER BY id':
      'SELECT id,name,email,role,store_id,created_at FROM users ORDER BY id').all());
  }
  if(path==='/api/users'&&method==='POST'){
    if(!managedSecurity)fail('接口不存在',404);
    requireRole(user,['admin']);
    return json(res,201,candidateProvisionAccount(db,user,await body(req),{runMode:startup.runMode}));
  }
  const accountStatePath=path.match(/^\/api\/users\/(\d+)\/state$/);
  if(accountStatePath&&method==='PATCH'){
    if(!managedSecurity)fail('接口不存在',404);
    requireRole(user,['admin']);
    return json(res,200,candidateSetAccountState(db,user,Number(accountStatePath[1]),await body(req),
      {runMode:startup.runMode}));
  }
  const resetPasswordPath=path.match(/^\/api\/users\/(\d+)\/reset-password$/);
  if(resetPasswordPath&&method==='POST'){
    if(!managedSecurity)fail('接口不存在',404);
    requireRole(user,['admin']);
    return json(res,200,candidateResetPassword(db,user,Number(resetPasswordPath[1]),await body(req),
      {runMode:startup.runMode}));
  }
  const userRolePath=path.match(/^\/api\/users\/(\d+)\/role$/);
  if(userRolePath&&method==='PATCH') {
    requireRole(user,['admin']); const targetId=Number(userRolePath[1]),input=await body(req);
    if(showcase)fail('合成预览岗位按已核验身份开通；变更岗位请停用旧账号并开通新账号',409);
    if(targetId===user.id) fail('不能修改自己的管理员角色');
    if(!['customer','staff','manager','contractor','owner','admin'].includes(input.role)) fail('角色无效');
    if(managedSecurity){
      const target=db.prepare('SELECT id,role,store_id FROM users WHERE id=?').get(targetId);
      if(!target)fail('用户不存在',404);
      const first=db.prepare('SELECT initial_admin_id,instance_id FROM runtime_installation WHERE singleton_id=1 AND run_mode=?').get(startup.runMode.toUpperCase());
      if(targetId===first?.initial_admin_id&&input.role!=='admin')fail('首个管理员角色不能撤销',409);
      const localRole=['staff','manager'].includes(input.role);
      const storeId=localRole?Number(input.storeId??target.store_id):null;
      if(localRole&&(!Number.isInteger(storeId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId)))
        fail('门店岗位须绑定有效门店',400);
      const changed=target.role!==input.role||Number(target.store_id||0)!==Number(storeId||0);
      if(!changed)return json(res,200,{id:targetId,role:target.role,storeId:target.store_id});
      const needsVerification=(target.role!==input.role&&['manager','owner','admin'].includes(input.role))||
        Number(target.store_id||0)!==Number(storeId||0);
      const verificationRef=String(input.verificationRef||'').trim();
      if(needsVerification&&(verificationRef.length<6||verificationRef.length>200))
        fail('高权限或门店范围变更须记录线下核验编号',400);
      const verificationRefHash=needsVerification?createHash('sha256').update(
        [first.instance_id,'role-scope',verificationRef].join('|')).digest('hex'):null;
      return json(res,200,transaction(db,()=>{
        db.prepare('UPDATE users SET role=?,store_id=? WHERE id=?').run(input.role,storeId,targetId);
        invalidateCandidateSessions(db,targetId);
        audit(db,user.id,'ROLE_UPDATED','user',targetId,{role:input.role,storeId,verificationRefHash});
        return {id:targetId,role:input.role,storeId};
      }));
    }
    const result=db.prepare('UPDATE users SET role=? WHERE id=?').run(input.role,targetId);
    if(!result.changes) fail('用户不存在',404);
    audit(db,user.id,'ROLE_UPDATED','user',targetId,{role:input.role});
    return json(res,200,{id:targetId,role:input.role});
  }
  if(path==='/api/audit'&&method==='GET') {
    requireRole(user,['manager','admin']);
    if(user.role==='admin')return json(res,200,db.prepare(`SELECT a.id,a.actor_id,a.action,a.target_type,a.target_id,a.created_at,
      '{}' AS detail_json,u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
      WHERE a.action IN ('ROLE_UPDATED','EMPLOYEE_PROFILE_SAVED','STORE_CREATED',
        'ACCOUNT_PROVISIONED','ACCOUNT_DISABLED','ACCOUNT_ENABLED','CREDENTIAL_RESET',
        'PASSWORD_CHANGED','AUTH_FAILED','AUTH_RATE_LIMITED','UNTRUSTED_ORIGIN','LOGIN','LOGOUT',
        'CANDIDATE_INITIALIZED','SHOWCASE_INITIALIZED') ORDER BY a.id DESC LIMIT 150`).all());
    return json(res,200,db.prepare(`SELECT a.id,a.actor_id,a.action,a.target_type,a.target_id,a.created_at,a.detail_json,u.name AS actor_name
      FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE
        (a.target_type='reservation' AND EXISTS(SELECT 1 FROM reservations r WHERE r.id=a.target_id AND r.store_id=?)) OR
        (a.target_type='damage_case' AND EXISTS(SELECT 1 FROM damage_cases c JOIN reservations r ON r.id=c.reservation_id WHERE c.id=a.target_id AND r.store_id=?)) OR
        (a.target_type='maintenance' AND EXISTS(SELECT 1 FROM maintenance m WHERE m.id=a.target_id AND m.store_id=?)) OR
        (a.target_type='price_policy' AND EXISTS(SELECT 1 FROM price_policies p WHERE p.id=a.target_id AND p.store_id=?)) OR
        (a.target_type='shift' AND EXISTS(SELECT 1 FROM shifts sh WHERE sh.id=a.target_id AND sh.store_id=?)) OR
        (a.target_type='transfer' AND EXISTS(SELECT 1 FROM transfers t WHERE t.id=a.target_id AND (t.from_store_id=? OR t.to_store_id=?)))
      ORDER BY a.id DESC LIMIT 150`).all(user.store_id,user.store_id,user.store_id,user.store_id,user.store_id,user.store_id,user.store_id));
  }
  if(path==='/api/order-alerts'&&method==='GET') {
    requireRole(user,orderAlertRoles);return json(res,200,orderAlerts(db,user,url.searchParams));
  }
  if(path==='/api/order-alerts/read'&&method==='POST') {
    requireRole(user,orderAlertRoles);return json(res,200,markOrderAlertsRead(db,user,await body(req)));
  }
  if(path==='/api/notifications/read'&&method==='POST') {
    requireRole(user,['customer',...orderAlertRoles]);const input=await body(req);
    if(!Array.isArray(input.ids)||input.ids.length>50||!input.ids.every(id=>Number.isSafeInteger(id)&&id>0))fail('通知编号无效');
    const at=new Date().toISOString();let marked=0;
    transaction(db,()=>{for(const id of input.ids)marked+=Number(db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').run(at,id,user.id).changes);});
    return json(res,200,{ok:true,marked});
  }
  if(path==='/api/notifications'&&method==='GET') {
    requireRole(user,['customer','staff','manager','contractor','owner','admin']);
    return json(res,200,db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(user.id));
  }
  if(path==='/api/reports'&&method==='GET') {
    requireRole(user,['manager','owner','admin']);
    const reportStore=user.role==='manager'?user.store_id:null;
    const currentYear=Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric'}).format(new Date()));
    const employeeYear=Number(url.searchParams.get('year')||currentYear);
    if(!Number.isInteger(employeeYear)||employeeYear<2000||employeeYear>currentYear+1)fail('业绩年份无效');
    const yearStart=new Date(Date.UTC(employeeYear,0,1)-3600000).toISOString();
    const yearEnd=new Date(Date.UTC(employeeYear+1,0,1)-3600000).toISOString();
    const overview=db.prepare(`SELECT COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status NOT IN ('CANCELLED','HOLD') THEN rent_nok ELSE 0 END),0) AS revenue_nok,
      COALESCE(SUM(CASE WHEN status IN ('ACTIVE','REVIEW','SETTLEMENT') THEN 1 ELSE 0 END),0) AS open_rentals,
      COALESCE(SUM(CASE WHEN refund_status='REVIEW' THEN 1 ELSE 0 END),0) AS refund_reviews
      FROM reservations WHERE (? IS NULL OR store_id=?)`).get(reportStore,reportStore);
    const byStore=db.prepare(`SELECT s.name,COUNT(r.id) AS orders,COALESCE(SUM(CASE WHEN r.status NOT IN ('CANCELLED','HOLD') THEN r.rent_nok ELSE 0 END),0) AS revenue_nok
      FROM stores s LEFT JOIN reservations r ON r.store_id=s.id WHERE (? IS NULL OR s.id=?) GROUP BY s.id`).all(reportStore,reportStore);
    const inventory=db.prepare(`SELECT status,COUNT(*) AS count FROM units WHERE (? IS NULL OR store_id=?) GROUP BY status`).all(reportStore,reportStore);
    const payments=db.prepare(`SELECT p.type,COALESCE(SUM(p.amount_nok),0) AS total_nok,COUNT(*) AS count FROM payments p JOIN reservations r ON r.id=p.reservation_id WHERE (? IS NULL OR r.store_id=?) GROUP BY p.type`).all(reportStore,reportStore);
    const damage=db.prepare(`SELECT COALESCE(SUM(total_fee_nok),0) AS fee_nok,COALESCE(SUM(damage_fee_nok),0) AS damage_fee_nok,
      COALESCE(SUM(late_fee_nok),0) AS late_fee_nok,COALESCE(SUM(deducted_nok),0) AS deducted_nok,
      COALESCE(SUM(paid_nok),0) AS paid_nok,COALESCE(SUM(supplement_nok-paid_nok),0) AS remaining_nok FROM damage_settlements d JOIN reservations r ON r.id=d.reservation_id WHERE (? IS NULL OR r.store_id=?)`).get(reportStore,reportStore);
    const adjustments=db.prepare('SELECT COALESCE(SUM(rent_delta_nok),0) AS rent_delta_nok,COALESCE(SUM(deposit_delta_nok),0) AS deposit_delta_nok,COUNT(*) AS count FROM contract_adjustments a JOIN reservations r ON r.id=a.reservation_id WHERE (? IS NULL OR r.store_id=?)').get(reportStore,reportStore);
    const byEmployee=db.prepare("SELECT u.id,u.name,COUNT(r.id) AS contracts,COALESCE(SUM(CASE WHEN r.status NOT IN ('HOLD','CANCELLED') THEN r.rent_nok ELSE 0 END),0) AS rent_nok FROM users u JOIN reservations r ON r.created_by=u.id WHERE r.contract_version>0 AND (? IS NULL OR r.store_id=?) GROUP BY u.id").all(reportStore,reportStore);
    const byEmployeeYear=db.prepare(`SELECT u.id,u.name,p.employee_no,COUNT(r.id) AS contracts,
      COALESCE(SUM(r.rent_nok),0) AS rent_nok
      FROM users u LEFT JOIN employee_profiles p ON p.user_id=u.id
      LEFT JOIN reservations r ON r.created_by=u.id AND r.contract_version>0
        AND r.status NOT IN ('HOLD','CANCELLED') AND r.paid_at>=? AND r.paid_at<? AND (? IS NULL OR r.store_id=?)
      WHERE u.role IN ('staff','manager','owner','admin') AND (? IS NULL OR u.store_id=?)
      GROUP BY u.id ORDER BY rent_nok DESC,u.id`).all(yearStart,yearEnd,reportStore,reportStore,reportStore,reportStore);
    return json(res,200,{overview,byStore,inventory,payments,damage,adjustments,byEmployee,employeeYear,byEmployeeYear,
      recent:user.role==='manager'?db.prepare('SELECT code,status,rent_nok,created_at FROM reservations WHERE store_id=? ORDER BY id DESC LIMIT 8').all(user.store_id):[]});
  }
  fail('接口不存在',404);
}

async function serveStatic(req,res,url) {
  const path=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  const file=resolve(publicDir,path);
  if(!isInsidePath(publicDir,file)) fail('文件不可访问',403);
  let target=file;
  try { if(!(await stat(target)).isFile()) target=join(publicDir,'index.html'); }
  catch { target=join(publicDir,'index.html'); }
  try{target=await realpath(target);}catch{fail('文件不可访问',403);}
  if(!isInsidePath(publicRealDir,target))fail('文件不可访问',403);
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
  res.writeHead(200,{'content-type':types[extname(target)]||'application/octet-stream',
    'cache-control':'no-cache','x-content-type-options':'nosniff'});
  res.end(await readFile(target));
}

const requestHandler=async(req,res)=>{
  try {
    if(managedSecurity&&startup.transport==='trusted-local-proxy')
      req.bsrClientIp=assertTrustedProxyRequest(req,startup);
    const url=new URL(req.url,managedSecurity?startup.publicOrigin:`http://${req.headers.host||'localhost'}`);
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/api/auth/')&&url.pathname!=='/api/region')res.on('finish',()=>{if(res.statusCode<400)broadcastChange(url.pathname);});
    if(url.pathname.startsWith('/api/')) await api(req,res,url);
    else if(req.method==='GET'||req.method==='HEAD') await serveStatic(req,res,url);
    else fail('不支持的方法',405);
  } catch(error) {
    const status=error instanceof DomainError?error.status:500;
    if(status===500) console.error(error);
    const payload={error:status===500?'服务器内部错误':error.message};
    if(status<500&&error.code)payload.code=error.code;
    if(error.code==='CART_STALE'&&Number.isInteger(error.currentVersion))payload.currentVersion=error.currentVersion;
    const headers=status===429&&error.retryAfter?{'retry-after':String(error.retryAfter)}:{};
    json(res,status,payload,headers);
  }
};
export const server=managedSecurity&&startup.transport==='direct-tls'?
  https.createServer({cert:startup.tls.cert,key:startup.tls.key},requestHandler):
  http.createServer(requestHandler);
server.on('close',()=>{for(const client of liveClients)client.res.end();liveClients.clear();});
const damageSlaTimer=process.env.NODE_ENV==='test'?null:setInterval(()=>{try{if(checkDamageSLA(db))broadcastChange('/api/damage-sla');}catch(error){console.error('Damage feedback deadline check failed',error);}},60000);
damageSlaTimer?.unref();server.on('close',()=>clearInterval(damageSlaTimer));

if(process.env.NODE_ENV!=='test') server.listen(port,host,()=>{
  console.log(managedSecurity?`BSR ${startup.runMode} (loopback ${startup.transport}): ${startup.transport==='direct-tls'?'https':'http'}://${host}:${port}`:
    `BSR local preview: http://${host}:${port}`);
});
