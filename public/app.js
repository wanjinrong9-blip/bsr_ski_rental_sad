import { createWorkplace } from './workplace.js';
import { createOrderAlerts } from './order-alerts.js';
import { createLiveUpdates } from './live-sync.js';
import { createDamageUI } from './damage.js';
import {jobs,createServiceUI} from './service-ui.js';
import {createFulfillmentUI} from './fulfillment.js';
import {readSubmission,pendingSubmission,clearSubmission} from './submit-intent.js';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = value => String(value??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => new Intl.NumberFormat('nb-NO',{maximumFractionDigits:0}).format(Number(value||0));
const nok = value => `NOK ${num(value)}`;
const dateText = value => value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Europe/Oslo',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'—';
const shortDate = value => value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Europe/Oslo',month:'short',day:'numeric'}).format(new Date(value)):'—';
const day = offset => { const d=new Date(Date.now()+offset*86400000); return d.toISOString().slice(0,10); };
const osloDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const osloDate=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const addCalendarDays=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const earliestPickupDate=()=>{
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  return addCalendarDays(osloDay(),hour>=9?1:0);
};
function readCart(){
  try { const saved=JSON.parse(localStorage.getItem('bsr-cart-v1')||'[]');
    return Array.isArray(saved)?saved.filter(x=>Number.isInteger(x.variantId)&&Number.isInteger(x.qty)&&x.variantId>0&&x.qty>0&&x.qty<=5):[];
  } catch { return []; }
}
const guestCartKey='bsr-cart-v1';
const cartLines=items=>(items||[]).map(item=>({variantId:Number(item.variantId),qty:Number(item.qty)}));
function rememberGuestCart(){localStorage.setItem(guestCartKey,JSON.stringify(state.cart));}
const cartCount=()=>state.cart.reduce((total,item)=>total+item.qty,0);
function osloIso(date,time){
  const temp=new Date(`${date}T${time}:00Z`);
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(temp).map(x=>[x.type,x.value]));
  const osloAsUtc=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
  return new Date(temp.getTime()-(osloAsUtc-temp.getTime())).toISOString();
}
const state={boot:null,user:null,route:'catalog',storeId:Number(localStorage.getItem('bsr-store')||1),
  pickupDate:addCalendarDays(osloDay(),1),returnDate:addCalendarDays(osloDay(),2),bookingConfirmed:false,
  currency:localStorage.getItem('bsr-currency')||'NOK',
  manualCurrency:!!localStorage.getItem('bsr-currency'),category:'全部',search:'',onlyAvailable:false,
  cart:readCart(),cartVersion:null,cartOwnerId:null,pendingGuestCart:null,pendingGuestWindow:null,cartMergeNotice:'',cartQuote:null,cartError:null,catalog:null,orders:[],inventory:[],maintenance:[],transfers:[],policies:[],shifts:[],reports:null,
  reportYear:Number(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric'}).format(new Date())),
  users:[],audit:[],notifications:[],activeOrder:null,lookup:null,modal:null,loginMode:'login',
  orderAlerts:null,alertView:'unresolved',alertPage:1,alertSearch:'',
  damageCases:[],damageFilter:'OPEN',damageSearch:'',damageConsent:null,subtype:'',
  preparations:[],directory:[],rates:[],counterCustomers:[],counterCustomerId:null,customerSkill:'',
  attendance:null,employees:[],roster:null,rosterDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),rosterStore:0,
  stockMoves:[],repairFilter:'OPEN',repairSearch:'',inventoryStatus:'',inventorySearch:'',miniEntry:null,liveConnected:false,lastSync:null,pendingSync:false,syncBusy:false,interacting:0,dirtyForm:false,reservationSubmitting:false};
const isCandidate=()=>state.boot?.runMode==='candidate';
const isShowcase=()=>state.boot?.runMode==='showcase';
const isManaged=()=>isCandidate()||isShowcase();
const canBook=()=>state.boot?.runMode==='demo'||state.boot?.capabilities?.bookingEnabled===true;
const windowPayload=()=>({storeId:state.storeId,pickupAt:osloIso(state.pickupDate,'09:00'),returnAt:osloIso(state.returnDate,'16:00')});
async function api(path, method='GET', data, headers={}){
  const options={method,credentials:'same-origin',headers:{...headers}};
  // The candidate site is HTTPS-only and authenticates with an HttpOnly cookie.
  // Before bootstrap identifies the mode, only the legacy HTTP preview reads its token.
  const legacySession=state.boot?state.boot.demo!==false:location.protocol==='http:';
  if(legacySession){const sessionToken=sessionStorage.getItem('bsr-session');if(sessionToken)options.headers['x-bsr-session']=sessionToken;}
  if(data!==undefined){options.headers['content-type']='application/json';options.body=JSON.stringify(data);}
  const res=await fetch(path,options);
  const json=await res.json().catch(()=>({error:'服务器响应异常'}));
  if(!res.ok){const error=new Error(json.error||`请求失败 ${res.status}`);error.status=res.status;error.code=json.code;error.currentVersion=json.currentVersion;throw error;}
  if(path==='/api/auth/login'){if(legacySession&&json.sessionToken)sessionStorage.setItem('bsr-session',json.sessionToken);fulfillmentUI.reset();}
  if(path==='/api/auth/logout'){clearSubmission('online',state.user?.id);clearSubmission('counter',state.user?.id);clearSubmission('amend',state.user?.id);if(legacySession)sessionStorage.removeItem('bsr-session');}
  return json;
}
function applySharedCart(cart){
  state.cart=cartLines(cart.items);state.cartVersion=cart.version;state.cartOwnerId=state.user?.id;
  const pickup=cart.pickupAt?osloDate(cart.pickupAt):null;
  const returnDate=cart.returnAt?osloDate(cart.returnAt):null;
  if(pickup&&returnDate&&pickup>=earliestPickupDate()&&returnDate>=pickup&&returnDate<=addCalendarDays(pickup,29)){
    if(state.storeId!==cart.storeId||state.pickupDate!==pickup||state.returnDate!==returnDate){
      state.storeId=cart.storeId;state.pickupDate=pickup;state.returnDate=returnDate;
      state.bookingConfirmed=false;state.catalog=null;state.cartQuote=null;
      localStorage.setItem('bsr-store',String(cart.storeId));
    }
  }else if(cart.version){state.bookingConfirmed=false;state.cartQuote=null;}
}
function mergedCartLines(remote,guest){
  const counts=new Map(cartLines(remote).map(line=>[line.variantId,line.qty]));
  for(const line of cartLines(guest))counts.set(line.variantId,Math.min(5,Math.max(counts.get(line.variantId)||0,line.qty)));
  return [...counts].map(([variantId,qty])=>({variantId,qty})).sort((a,b)=>a.variantId-b.variantId);
}
async function syncSharedCart(){
  if(state.user?.role!=='customer'||!canBook())return;
  let remote=await api('/api/cart');
  const guest=state.pendingGuestCart;
  if(guest?.length){
    const items=mergedCartLines(remote.items,guest);
    if(items.length>12){
      state.cartMergeNotice='登录前的装备已保留。两份购物车合并会超过 12 种，请先移除部分装备，再点击“重新合并”。';
    }else{
      const guestWindow=state.pendingGuestWindow||windowPayload();
      const useRemoteWindow=remote.version&&remote.pickupAt&&osloDate(remote.pickupAt)>=earliestPickupDate();
      const window=useRemoteWindow?{storeId:remote.storeId,pickupAt:remote.pickupAt,returnAt:remote.returnAt}:guestWindow;
      try{
        remote=await api('/api/cart','PUT',{expectedVersion:remote.version,...window,items});
        state.cartMergeNotice=useRemoteWindow&&(
          remote.storeId!==guestWindow.storeId||remote.pickupAt!==guestWindow.pickupAt||remote.returnAt!==guestWindow.returnAt)
          ?'已合并登录前选择的装备，并沿用账号原有租期。下单前请重新确认日期和库存。':'';
        state.pendingGuestCart=null;state.pendingGuestWindow=null;
        localStorage.removeItem(guestCartKey);
      }catch(error){
        state.cartMergeNotice='登录前的装备仍保留在本机；请在购物车重试合并。';
        if(error.code==='CART_STALE')remote=await api('/api/cart');
        else if(error.status===409||error.status===422)remote=await api('/api/cart');
        else throw error;
      }
    }
  }else localStorage.removeItem(guestCartKey);
  applySharedCart(remote);
}
async function saveCart(){
  if(state.user?.role!=='customer'||!canBook()){rememberGuestCart();return;}
  if(state.cartOwnerId!==state.user.id||state.cartVersion===null)
    throw new Error('购物车正在同步，请稍后重试');
  try{
    const saved=await api('/api/cart','PUT',{expectedVersion:state.cartVersion,...windowPayload(),items:cartLines(state.cart)});
    applySharedCart(saved);state.cartQuote=null;state.cartMergeNotice='';
    localStorage.removeItem(guestCartKey);
  }catch(error){
    if(error.code==='CART_STALE'){
      applySharedCart(await api('/api/cart'));state.cartQuote=null;
      const stale=new Error('购物车已在另一端更新，已载入最新内容。请重新操作。');
      stale.code='CART_STALE';throw stale;
    }
    throw error;
  }
}
async function changeCart(change){
  const before=cartLines(state.cart);
  change();
  try{await saveCart();}
  catch(error){if(error.code!=='CART_STALE')state.cart=before;render();throw error;}
}
function holdGuestCartForLogin(){
  if(state.user||!state.cart.length)return;
  state.pendingGuestCart=cartLines(state.cart);
  state.pendingGuestWindow=windowPayload();
}
function toast(message,bad=false){
  const el=$('#toast'); el.className='toast show'+(bad?' bad':''); el.textContent=message;
  clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',3600);
}
const icons={
  compass:'<circle cx="12" cy="12" r="9"/><path d="m15 9-2 4-4 2 2-4 4-2Z"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
  box:'<path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M8 10h8M8 14h8"/>',
  wrench:'<path d="M14 5a5 5 0 0 0-6 6L3 16l5 5 5-5a5 5 0 0 0 6-6l-3 3-4-4 2-4Z"/>',
  chart:'<path d="M4 20V4M4 20h17M8 16l4-5 3 2 5-7"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  shield:'<path d="M12 2 4 5v6c0 6 3.8 9.4 8 11 4.2-1.6 8-5 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  pin:'<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron:'<path d="m9 6 6 6-6 6"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
  plus:'<path d="M12 4v16M4 12h16"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  arrow:'<path d="M4 12h16m-7-7 7 7-7 7"/>',
  wallet:'<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 9V5a2 2 0 0 1 2-2h13M16 13h5"/>',
  cart:'<circle cx="9" cy="20" r="1"/><circle cx="19" cy="20" r="1"/><path d="M2 3h2l2.3 12.2a2 2 0 0 0 2 1.6h10.5a2 2 0 0 0 2-1.6L22 7H5"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  log:'<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M14 17l5-5-5-5M19 12H8"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 7 9-7"/>'
  ,phone:'<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'
};
function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.box}</svg>`;}
function logo(){return `<span class="brand-mark brand-logo"><img src="/bsr-logo.png" alt="BSR 标识"></span><span class="brand-name">BSR<span>SKI RENTAL SYSTEM</span></span>`;}
function gearSvg(type){
  const common='fill="none" stroke="#286d77" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
  const shapes={
    goggles:`<path d="M12 52h25l9-13h73l10 13h23v44h-24l-12 12H46L34 96H12Z" fill="#78a8ad"/><path d="M43 55h34v35H45L36 77ZM88 55h33l9 22-10 13H88Z" fill="#e3f0ed"/><path d="M77 66h11M17 68h15M132 68h15" stroke="#397b83" stroke-width="7"/>`,
    kneepads:`<rect x="22" y="18" width="48" height="105" rx="20" fill="#639495"/><rect x="94" y="18" width="48" height="105" rx="20" fill="#639495"/><path d="M27 42h38M99 42h38M27 96h38M99 96h38" stroke="#cde1d8" stroke-width="9"/><ellipse cx="46" cy="69" rx="15" ry="19" fill="#9cb8aa"/><ellipse cx="118" cy="69" rx="15" ry="19" fill="#9cb8aa"/>`,
    protector:`<path d="m55 9 26 13 27-13 23 31-17 80H48L31 40Z" fill="#578b88"/><path d="M81 25v92M49 48h64M46 69h71M43 91h77" stroke="#d2e3d9" stroke-width="7"/>`,
    gloves:`<path d="M19 51q1-10 11-8l8 12V26q0-10 9-10h18q9 0 9 10v64l-8 31H33L19 83Z" fill="#669294"/><path d="M92 51q1-10 11-8l8 12V26q0-10 9-10h18q9 0 9 10v64l-8 31h-33L92 83Z" fill="#669294"/><path d="M30 99h39M103 99h39" stroke="#cedfd4" stroke-width="9"/>`,
    jacket:`<path d="m59 12 22 9 23-9 30 18 24 53-24 11-17-31v62H46V63L29 94 7 83l24-53Z" fill="#739494"/><path d="M81 22v100M49 82h21M94 82h20" stroke="#dce7d6" stroke-width="5"/><path d="m61 13 20 20 22-20" stroke="#477a7a" stroke-width="7"/>`,
    pants:`<path d="M42 8h80l13 117H93L81 65 70 125H28Z" fill="#6a9398"/><path d="M42 25h80M81 28v37M33 109h38M93 109h38" stroke="#d1e3da" stroke-width="7"/>`,
    ski:`<path ${common} d="M57 7 34 110q-3 16 7 15c4 0 7-4 9-9L73 15M100 8 79 111q-4 16 6 14c4 0 7-4 8-9L116 16"/><path stroke="#84b6bc" stroke-width="7" stroke-linecap="round" d="M45 80h22M88 80h22"/>`,
    powder:`<path ${common} d="M58 6 30 113q-5 19 5 15 6-2 10-13L78 12M110 6 83 113q-5 19 5 15 6-2 10-13l33-103"/><path stroke="#84b6bc" stroke-width="7" d="M42 76h25M96 76h25"/>`,
    board:`<rect x="55" y="3" width="40" height="127" rx="20" transform="rotate(12 75 65)" fill="#387d86"/><path d="M52 68h50M49 86h50" stroke="#cfe7e8" stroke-width="8" stroke-linecap="round" transform="rotate(12 75 65)"/>`,
    boots:`<path d="M43 18h50v55l28 19q8 5 8 17v8H25v-14q0-14 18-21V18Z" fill="#397e88"/><path d="M52 37h30M52 53h30M42 102h78" stroke="#d8eeee" stroke-width="6" stroke-linecap="round"/>`,
    helmet:`<path d="M25 73a52 52 0 0 1 104 0v20H96l-10 17H57L46 93H25V73Z" fill="#387d86"/><path d="M34 74h88M60 99h24" stroke="#d4e9e9" stroke-width="6"/>`,
    poles:`<path ${common} d="M51 8 61 115M100 8 108 115"/><path d="M34 30h35M82 30h35M50 116l-8 12M61 116l8 12M99 116l-8 12M108 116l8 12" stroke="#82b1b8" stroke-width="5" stroke-linecap="round"/>`,
    junior:`<path ${common} d="M47 7 29 116M81 7 64 116"/><path d="M94 54a29 29 0 0 1 58 0v20H94V54Z" fill="#78abb1" stroke="#286d77" stroke-width="4"/><path d="M36 74h26M72 74h25" stroke="#cee7e8" stroke-width="6"/>`,
    premium:`<path ${common} d="M43 5 25 119M84 5 66 119"/><path d="M100 58h35l15 32v24H93V93l7-35Z" fill="#367986"/><path d="M33 77h30M73 77h25" stroke="#d7e9e8" stroke-width="6"/>`
  };
  return `<svg viewBox="0 0 165 135" aria-hidden="true">${shapes[type]||shapes.ski}</svg>`;
}
const roleLabels=Object.fromEntries(Object.entries(jobs).map(([key,job])=>[key,job.name]));
const statusLabels={HOLD:'待支付',EXPIRED:'暂留已过期',CONFIRMED:'待取货 · 准备中',READY:'待取货 · 已备妥',ACTIVE:'租赁中',REVIEW:'待复核',SETTLEMENT:'待补差',COMPLETED:'已完成',CANCELLED:'已取消'};
function statusTag(status){const c={HOLD:'warn',EXPIRED:'bad',CONFIRMED:'good',ACTIVE:'good',REVIEW:'warn',SETTLEMENT:'warn',COMPLETED:'',CANCELLED:'bad'}[status]||'';return `<span class="tag ${c}"><span class="dot"></span>${statusLabels[status]||esc(status)}</span>`;}
function reference(amount){if(state.currency==='NOK')return '';const rate=state.boot?.exchange?.[state.currency]?.rate;if(!rate)return '';return `≈ ${state.boot.exchange[state.currency].symbol} ${new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(amount*rate)} <span class="muted">参考换算</span>`;}
const navByRole={
  guest:[['catalog','探索装备','compass'],['cart','购物车','cart'],['service','服务流程','info'],['mini','微信小程序','phone']],
  customer:[['catalog','探索装备','compass'],['cart','购物车','cart'],['orders','我的预约','calendar'],['service','服务流程','info'],['mini','微信小程序','phone'],['profile','个人资料','users']],
  staff:[['dashboard','今日工作台','chart'],['operations','取货与归还','clipboard'],['inventory','装备库存','box'],['maintenance','故障维修','wrench'],['shifts','我的排班','calendar']],
  manager:[['dashboard','运营工作台','chart'],['operations','取货与归还','clipboard'],['inventory','库存与调拨','box'],['maintenance','维修任务','wrench'],['policies','价格政策','wallet'],['shifts','员工排班','calendar'],['reports','经营报表','chart'],['audit','审计日志','shield']],
  contractor:[['maintenance','我的维修任务','wrench']],
  owner:[['reports','经营报表','chart']],
  admin:[['users','账号与权限','users'],['audit','审计日志','shield'],['reports','经营报表','chart']]
};
for(const role of ['staff','manager','contractor','owner','admin']){
  navByRole[role].splice(role==='contractor'?1:2,0,['order-alerts','订单提醒','bell']);
  navByRole[role].push(['attendance','上下班打卡','clock']);
  navByRole[role].push(['roles','岗位与权限说明','users']);
  if(!['owner','admin'].includes(role))navByRole[role].splice(role==='contractor'?1:3,0,['damage-cases','受损鉴定','shield']);
}
for(const role of ['staff','manager'])navByRole[role].splice(1,0,['preparations','装备准备','box'],['counter','现场开单','clipboard']);
for(const role of ['manager','owner','admin'])navByRole[role].push(['team','员工与承包商','users'],['network','门店与采购','layers']);
function nav(){
  if(isShowcase()&&!canBook())return state.user?.role==='admin'
    ?[['users','账号与权限','users'],['audit','审计日志','shield'],['catalog','虚构装备','compass'],['service','阶段状态','info'],['mini','微信小程序','phone']]
    :[['catalog','虚构装备','compass'],['service','阶段状态','info'],['mini','微信小程序','phone']];
  return navByRole[state.user?.role||'guest'];
}
function defaultRoute(){
  if(isShowcase())return !state.user?'login':!canBook()?(state.user.role==='admin'?'users':'catalog'):
    state.user.role==='customer'?'catalog':nav()[0][0];
  return state.user?.role==='customer'||!state.user?'catalog':nav()[0][0];
}
async function loadCartQuote(){
  state.cartQuote=null;state.cartError=null;
  if(!state.cart.length||!state.bookingConfirmed||!canBook())return;
  try{state.cartQuote=await api('/api/quote','POST',{...windowPayload(),items:state.cart});}
  catch(e){state.cartError=e.message;}
}
async function loadRoute(){
  const r=state.route;
  const latestBoot=await api('/api/bootstrap');state.boot=latestBoot;
  if(isShowcase()&&!latestBoot.stores.some(store=>store.id===state.storeId))
    state.storeId=latestBoot.stores[0]?.id||0;
  if(isManaged()){
    const previousId=state.user?.id;
    state.user=latestBoot.user||null;
    if(previousId&&!state.user){
      state.orders=[];state.activeOrder=null;state.inventory=[];state.maintenance=[];state.notifications=[];
      orderAlerts.reset();damageUI.reset();fulfillmentUI.reset();state.route='login';
      history.replaceState(null,'','#/login');return;
    }
    if(state.user?.mustChangePassword){state.route='login';history.replaceState(null,'','#/login');return;}
  }else if(state.user?.id!==latestBoot.user?.id){
    if(!state.user&&latestBoot.user?.role==='customer')holdGuestCartForLogin();
    state.user=latestBoot.user||null;state.cartOwnerId=null;state.cartVersion=null;
    if(!state.user){state.cart=[];state.pendingGuestCart=null;state.pendingGuestWindow=null;localStorage.removeItem(guestCartKey);}
  }
  if(isShowcase()&&!canBook()){
    if(!latestBoot.stores.some(s=>s.id===state.storeId))state.storeId=latestBoot.stores[0]?.id||0;
    if(r==='catalog'){
      const w=windowPayload();
      state.catalog=await api(`/api/catalog?storeId=${w.storeId}&pickupAt=${encodeURIComponent(w.pickupAt)}&returnAt=${encodeURIComponent(w.returnAt)}`);
    }else if(r==='users'&&state.user?.role==='admin')state.users=await api('/api/users');
    else if(r==='audit'&&state.user?.role==='admin')state.audit=await api('/api/audit');
    else if(r==='mini')state.miniEntry=await api('/api/mini-entry');
    state.lastSync=new Date();return;
  }
  if(state.user?.role==='customer'&&canBook())await syncSharedCart();
  if(r==='mini')state.miniEntry=await api('/api/mini-entry');
  await fulfillmentUI.load(r);
  if(r==='catalog'||r==='cart'){
    if(!canBook()){state.catalog={items:[]};state.bookingConfirmed=false;}
    else {const w=windowPayload();state.catalog=await api(`/api/catalog?storeId=${w.storeId}&pickupAt=${encodeURIComponent(w.pickupAt)}&returnAt=${encodeURIComponent(w.returnAt)}`);}
    if(r==='cart')await loadCartQuote();
  } else if(r==='orders'||r==='operations'||r==='dashboard'){
    if(state.user) state.orders=await api('/api/reservations');
    if(r==='dashboard'&&['manager','owner'].includes(state.user?.role))state.reports=await api('/api/reports');
  } else if(r==='inventory'){
    [state.inventory,state.transfers,state.stockMoves]=await Promise.all([api('/api/inventory'),['staff','manager'].includes(state.user?.role)?api('/api/transfers'):Promise.resolve([]),api('/api/inventory/movements')]);
  } else if(r==='maintenance')state.maintenance=await api('/api/maintenance');
  else if(r==='policies')state.policies=await api('/api/policies');
  else if(r==='shifts')state.shifts=await api('/api/shifts');
  else if(r==='reports')state.reports=await api(`/api/reports?year=${state.reportYear}`);
  else if(r==='users')state.users=await api('/api/users');
  else if(r==='audit')state.audit=await api('/api/audit');
  if(state.user){
    const jobs=[api('/api/notifications').then(data=>state.notifications=data),orderAlerts.load(),damageUI.load()];
    if(state.user.role!=='customer')jobs.push(api('/api/attendance').then(data=>state.attendance=data));
    if(['maintenance','shifts','dashboard','preparations'].includes(r)&&state.user.role!=='customer')jobs.push(api('/api/employees').then(data=>state.employees=data));
    if(['shifts','dashboard'].includes(r))jobs.push(api(`/api/roster?date=${r==='dashboard'?new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):state.rosterDate}&storeId=${state.user.role==='manager'?state.user.storeId:r==='dashboard'?0:state.rosterStore}`).then(data=>state.roster=data));
    if(r==='dashboard')jobs.push(api('/api/maintenance').then(data=>state.maintenance=data));
    await Promise.all(jobs);
  }
  state.lastSync=new Date();
}
async function navigate(route){
  state.dirtyForm=false;state.modal=null;
  if(isShowcase()&&!state.user)route='login';
  if(isManaged()&&state.user?.mustChangePassword)route='login';
  if(route==='login'){state.route='login';history.replaceState(null,'','#/login');render();return;}
  const available=nav().map(x=>x[0]);
  state.route=available.includes(route)||route==='mini'?route:defaultRoute();
  history.replaceState(null,'',`#/${state.route}`);
  try{await loadRoute();render();}catch(e){toast(e.message,true);render();}
}
function shell(content){
  const user=state.user,role=user?.role||'guest',navItems=nav();
  const notifications=state.notifications.filter(n=>!n.read_at).length;
  const showcaseReady=isShowcase()&&canBook();
  const syntheticBanner=isShowcase()?`<div class="banner warn synthetic-boundary" role="note">${icon('shield')}<div><b>合成模拟 · 虚构资料</b>　门店、人员、装备与 NOK 费率均为课程示例；支付、退款和签署不发生真实资金划转或有效电子签名。</div></div>`:'';
  const environmentName=isShowcase()?'合成预览 · 虚构资料':isCandidate()?'正式候选 · 仅本机':'演示环境';
  const environmentDetail=isShowcase()?(showcaseReady?'门店、人员、装备和 NOK 价目均为虚构；全部资金和签署步骤仅作模拟。':'门店、人员、装备和 NOK 价目均为虚构；预约与模拟结算仍在验收。'):
    isCandidate()?'身份与数据边界待验证；无获批目录时不可预约。真实支付、签署和商业政策尚未接入。':
      '支付、退款和汇率均为模拟，正式价格仅以 NOK 展示与结算。';
  return `<div class="shell role-${role}"><aside class="sidebar"><a href="#/catalog" class="brand" data-route="${defaultRoute()}">${logo()}</a>
    <nav><p class="nav-label">${role==='customer'||role==='guest'?'探索服务':'工作空间'}</p><div class="nav-list">${navItems.map(([route,label,ic])=>`<button class="nav-item ${state.route===route?'active':''}" data-route="${route}">${icon(ic)}<span>${label}</span>${route==='damage-cases'?`<span class="damage-nav-flag">${damageUI.flag()}</span>`:''}${orderAlerts.enabled()&&(['order-alerts','operations','orders'].includes(route)||(role==='contractor'&&route==='maintenance'))?orderAlerts.indicator('unresolved','未解决订单'):''}</button>`).join('')}</div></nav>
    <div class="sidebar-spacer"></div><div class="sidebar-note">${icon('info')}<div><b>${environmentName}</b><br>${environmentDetail}</div></div>
    <div class="side-user"><div class="avatar">${esc((user?.name||'访')[0])}</div><div style="flex:1"><b>${esc(user?.name||'访客')}</b><div class="small muted">${roleLabels[role]||'正在浏览'}</div></div>${user?`<button class="icon-btn" data-action="logout" title="退出登录">${icon('log')}</button>`:''}</div></aside>
    <div class="main"><header class="topbar"><div class="topbar-left">${state.route==='catalog'?'探索雪地，自在出发':state.route==='mini'?'微信小程序':navItems.find(n=>n[0]===state.route)?.[1]||'BSR'}</div><div class="topbar-right">
      ${isShowcase()&&!showcaseReady?'<span class="small muted">合成资料 · 业务验收中</span>':`<button class="sync-indicator ${state.liveConnected?'connected':''}" data-action="sync" title="库存、订单、排班和维修记录自动同步"><i></i><span id="sync-label">${state.pendingSync?'有新更新':state.liveConnected?'实时同步':'连接中'}</span></button>`}
      <button class="mini-top-entry" data-route="mini" title="查看微信小程序入口" aria-label="微信小程序入口">${icon('phone')}<span>小程序</span></button>
      ${isShowcase()?'<span class="small muted">NOK · 虚构示例价</span>':['customer','guest'].includes(role)?isCandidate()?'<span class="small muted">NOK · 待批准价目</span>':`<div class="currency">${icon('pin')}<select id="currency-select" aria-label="参考展示币种">${Object.entries(state.boot.exchange||{}).map(([code,item])=>`<option value="${code}" ${state.currency===code?'selected':''}>${code}</option>`).join('')}</select></div><button class="location-btn" data-action="locate" title="授权定位推荐参考币种">定位推荐</button>`:`<button class="attendance-shortcut ${state.attendance?.today&&!state.attendance.today.clock_out_at?'on-duty':''}" data-route="attendance">${icon('clock')}<span>${!state.attendance?.today?'上班打卡':state.attendance.today.clock_out_at?'今日已下班':'在岗 · 下班打卡'}</span></button>`}
      ${showcaseReady&&role!=='customer'?`<button class="attendance-shortcut ${state.attendance?.today&&!state.attendance.today.clock_out_at?'on-duty':''}" data-route="attendance">${icon('clock')}<span>${!state.attendance?.today?'上班打卡':state.attendance.today.clock_out_at?'今日已下班':'在岗 · 下班打卡'}</span></button>`:''}
      ${(!isShowcase()||showcaseReady)&&['customer','guest'].includes(role)?`<button class="top-cart" data-route="cart" aria-label="购物车，${cartCount()} 件装备">${icon('cart')}<span>购物车</span>${cartCount()?`<b>${cartCount()}</b>`:''}</button>`:''}
      ${user?`${isShowcase()&&!showcaseReady?'':`<button class="icon-btn order-reminder-bell" data-action="notifications" title="通知与订单提醒" aria-label="通知与订单提醒">${icon('bell')}${orderAlerts.enabled()?`<span class="order-alert-bell">${orderAlerts.indicator('unresolved','未解决订单')}</span>`:''}${notifications&&(!orderAlerts.enabled()||!state.orderAlerts?.counts.unresolved)?`<span class="notice-count">${Math.min(notifications,9)}</span>`:''}</button>`}<button class="top-logout" data-action="logout" title="退出当前账号，返回身份选择">${icon('log')}<span>退出登录</span></button>`:`<button class="btn small" data-route="login">${isManaged()?'登录':'登录 / 注册'}</button>`}
    </div></header><main class="content">${syntheticBanner}<div id="order-alert-strip">${isShowcase()&&!showcaseReady?'':orderAlerts.strip()}</div>${content}<footer class="footer"><span>© 2026 BSR Ski Rental · ${isShowcase()?'虚构合成预览':isCandidate()?'正式候选本机验证':'系统分析与设计课程项目预览'}</span><span>${isShowcase()?'仅供课程展示 · 无真实收付款或有效电子签署':isCandidate()?'商业价目待批准 · 无真实收付款或合格电子签署':'正式价 NOK · 参考汇率仅用于展示 · 无真实收款'}</span></footer></main></div>
    <div class="mobile-nav">${navItems.map(([route,label,ic])=>`<button class="${state.route===route?'active':''}" data-route="${route}">${icon(ic)}${label}${route==='damage-cases'?`<span class="order-alert-indicator">${damageUI.flag()}</span>`:''}${orderAlerts.enabled()&&(['order-alerts','operations','orders'].includes(route)||(role==='contractor'&&route==='maintenance'))?orderAlerts.indicator('unresolved','未解决订单'):''}</button>`).join('')}</div></div>${state.modal||''}`;
}
function storeOptions(selected=state.storeId,ownOnly=false){return state.boot.stores.filter(s=>!ownOnly||s.id===state.user?.storeId).map(s=>`<option value="${s.id}" ${+selected===s.id?'selected':''}>${esc(s.name)}</option>`).join('');}
function otherStoreOptions(){return state.boot.stores.filter(s=>s.id!==state.user?.storeId).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');}
function pageHead(kicker,title,subtitle,action=''){return `<div class="page-head"><div><div class="kicker">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;}
function empty(title,subtitle,ic='box'){return `<div class="empty"><div class="symbol">${icon(ic)}</div><h3>${title}</h3><div>${subtitle}</div></div>`;}
function catalogPage(){
  if(isShowcase()&&!canBook()){
    const items=state.catalog?.items||[];
    const categories=['全部',...new Set(items.map(x=>x.category))];
    const shown=items.filter(x=>(state.category==='全部'||x.category===state.category)&&
      `${x.name} ${x.size} ${x.style} ${x.skill}`.toLowerCase().includes(state.search.toLowerCase()));
    return `<section class="hero"><div class="hero-copy"><div class="eyebrow">SYNTHETIC · NORWAY</div><h1>虚构装备，<br>真实地检验系统。</h1><p>以下门店、装备与 NOK 示例价目只用于课程合成预览。预约、资金和合同流程尚在验收，暂不能提交订单。</p><div class="hero-actions"><button class="btn" data-route="service">查看实施进度 ${icon('arrow')}</button></div></div><div class="hero-art">${mountainArt()}</div></section>
      <div class="banner warn" style="margin:22px 0">${icon('shield')}<div><b>合成数据 · 非真实业务</b><br>库存编号、人员、价格和门店均为虚构；目前只开放目录查看与受控账号管理。</div></div>
      <div class="section-head"><div><div class="kicker">SYNTHETIC CATALOG</div><h2>虚构装备目录</h2><p>${items.length} 款规格 · ${state.boot.stores.length} 家虚构门店 · 押金示例按参考价值 8% 计算</p></div></div>
      <div class="filterbar">${categories.map(c=>`<button class="pill ${state.category===c?'active':''}" data-category="${c}">${c}</button>`).join('')}<div class="push"></div><input class="input" id="catalog-search" placeholder="搜索虚构装备 / 尺码" value="${esc(state.search)}"></div>
      <div class="catalog-grid">${shown.map(productCard).join('')||empty('没有匹配的虚构装备','调整类别或搜索词','search')}</div>`;
  }
  if(!canBook())return `${pageHead('CATALOG STATUS','装备目录待批准','这是身份与数据边界的本机候选验证，尚无经 BSR 批准的门店、装备和 NOK 价目。')}<section class="card pad">${empty('当前没有可预约装备','商业价目、押金和取还政策获批并完成独立验收后，才会开放日期段库存与预约。','shield')}<div class="banner warn">${icon('info')}<div>此环境不提供真实支付、退款或合格电子签署；本机候选验证不代表已经正式上线。</div></div></section>`;
  const items=state.catalog?.items||[];
  const categories=['全部',...new Set(items.map(x=>x.category))];
  const shown=items.filter(x=>(state.category==='全部'||x.category===state.category)&&(!state.subtype||x.subtype===state.subtype)&&(!state.onlyAvailable||x.available>0)&&`${x.name} ${x.size} ${x.style} ${x.skill}`.toLowerCase().includes(state.search.toLowerCase()));
  return `<section class="hero"><div class="hero-copy"><div class="eyebrow">${isShowcase()?'SYNTHETIC · NORWAY':'SKARDALEN · NORWAY'}</div><h1>好雪况，<br>从合适的装备开始。</h1><p>${isShowcase()?'先选虚构门店和日期，再看该时段的合成库存。NOK 租金、8% 示例押金与归还截止时间会在模拟预约前逐项列出。':'先选门店和滑行日期，再看这段时间内各尺码还剩多少件。租金、押金与归还截止时间会在预约前逐项列出。'}</p><div class="hero-actions"><button class="btn" data-action="scroll-catalog">选择租期 ${icon('arrow')}</button><button class="btn secondary" data-route="service">了解租赁流程</button></div><div class="hero-micro"><span>到店出示取货码</span><span>逐件验货</span><span>首次有效租赁享两小时归还宽限</span></div></div><div class="hero-art">${mountainArt()}</div></section>
  <section class="card booking-panel" id="booking-anchor"><div class="booking-title"><div><div class="kicker">01 / CHOOSE YOUR DATES</div><h2>先选滑行日期</h2><p>按挪威门店当地时间：起租日 09:00 取货，归还日最迟 16:00 还回。可以当天租还，最长计费 30 天。</p></div><div class="booking-mini-peak" aria-hidden="true">⌁</div></div><div class="booking-grid"><div class="field"><label for="store-select">取货门店</label><select id="store-select">${storeOptions()}</select></div><div class="field"><label for="pickup-date">起租日期 · 09:00 起</label><input type="date" id="pickup-date" value="${esc(state.pickupDate)}" min="${earliestPickupDate()}" required></div><div class="field"><label for="return-date">归还日期 · 16:00 前</label><input type="date" id="return-date" value="${esc(state.returnDate)}" min="${esc(state.pickupDate)}" max="${addCalendarDays(state.pickupDate,29)}" required></div><button class="btn" data-action="search-catalog">查看该时段库存 ${icon('arrow')}</button></div><div class="booking-foot">${state.bookingConfirmed?`<span class="booking-confirmed">✓ 已确认 ${esc(state.pickupDate)} 09:00 — ${esc(state.returnDate)} 16:00，以下数量仅适用于该租期。</span>`:`<span>选定时间段后，才显示可预约的装备及剩余数量。</span>`}</div></section>
  ${state.bookingConfirmed?`<div id="catalog-anchor"><div class="section-head"><div><div class="kicker">02 / LIVE AVAILABILITY</div><h2>这段时间，还能租到什么？</h2><p>${esc(state.boot.stores.find(s=>s.id===state.storeId)?.name||'')} · ${state.pickupDate} 09:00 至 ${state.returnDate} 16:00 · 每个规格独立计数</p></div><button class="btn secondary" data-route="cart">${icon('cart')} 购物车 (${cartCount()})</button></div>
  <div class="filterbar">${categories.map(c=>`<button class="pill ${state.category===c?'active':''}" data-category="${c}">${c}</button>`).join('')}<select id="catalog-subtype" class="input catalog-subtype" aria-label="装备细分类"><option value="">所有细分类</option>${[...new Set(items.filter(x=>state.category==='全部'||x.category===state.category).map(x=>x.subtype))].map(t=>`<option value="${esc(t)}" ${state.subtype===t?'selected':''}>${esc(t)}</option>`).join('')}</select><label class="flex small"><input type="checkbox" id="only-available" ${state.onlyAvailable?'checked':''}>仅看有货</label><div class="push"></div><input class="input" id="catalog-search" placeholder="搜索装备 / 尺码 / 款式" value="${esc(state.search)}"></div>
  <div class="catalog-grid">${shown.map(productCard).join('')||empty('没有匹配的装备','试试调整日期、类别或关键词','search')}</div>
  <div class="banner" style="margin-top:25px">${icon('info')}<div>${isShowcase()?'虚构门店以 NOK 示例价记账；每件押金为虚构装备参考价值的 8%。超时费示例按单件日租金的 10%／小时计算，不足一小时按一小时计，每 24 小时封顶一天日租金，首次有效租赁免计前两小时。所有付款与退款均为模拟，不发生实际资金划转。':'BSR 挪威门店均以 NOK 计价；新订单押金按每件装备演示参考价值的 8% 计算。超时费按单件日租金的 10%／小时计算，不足一小时按一小时计，每 24 小时封顶一天日租金；首次有效租赁免计前两小时。旧订单保留原报价，定位币种只供参考换算。'}</div></div></div>`:`<div id="catalog-anchor" class="booking-pending"><div class="booking-pending-art" aria-hidden="true">△</div><div class="kicker">YOUR RENTAL WINDOW</div><h2>选好时间，库存才有答案。</h2><p>不同日期占用不同，先选上方租期，就能看到每款、每个尺码在这段时间的剩余数量。</p></div>`}`;
}
function mountainArt(){return `<svg viewBox="0 0 440 280" fill="none" aria-hidden="true"><circle cx="343" cy="65" r="34" fill="#d9e9f5" opacity=".17"/><path d="M0 236 104 155l68-91 72 100 46-62 150 134" fill="#86accb" opacity=".19"/><path d="M0 267 78 208l69-102 69 95 56-66 168 132" fill="#d6e8f3" opacity=".12"/><path d="m17 238 155-174 72 100 46-62 132 139M76 210l71-104 68 95 57-66 131 105" stroke="#e9f4fb" stroke-width="3" stroke-linejoin="round" opacity=".86"/><path d="m145 95 27-31 30 42m69 18 19-22 26 31" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M0 268h440" stroke="#b8d5e8" stroke-width="2" opacity=".62"/><path d="m92 232 16-27 16 27m242 0 16-30 17 30" stroke="#d7eaf6" stroke-width="3" stroke-linecap="round"/><path d="M87 232h42m233 0h41" stroke="#d7eaf6" stroke-width="3" stroke-linecap="round"/></svg>`;}
function productCard(x){return `<article class="card product"><div class="product-visual ${esc(x.visual)}"><span class="vtag">${esc(x.category)} · ${esc(x.style)}</span>${gearSvg(x.visual)}</div><div class="product-body"><div class="between"><h3>${esc(x.name)}</h3><span class="tag ${x.available>0?'good':'bad'}">${isShowcase()?`虚构库存 ${x.available} 件`:x.available>0?`可订 ${x.available} 件`:'已约满'}</span></div><p>${esc(x.description)}</p><div class="product-meta"><span>尺码 ${esc(x.size)}</span><span>${esc(x.skill)}</span><span>8%押金 ${nok(x.depositNok)}</span></div><div class="product-foot"><div><div class="price">${x.dailyNok!==null?`${nok(x.dailyNok)} <small>/ 日</small>`:'暂不可订'}</div><div class="reference">${reference(x.dailyNok)}</div></div><button class="btn small" data-add="${x.id}" ${!canBook()||x.available<=0||x.dailyNok===null?'disabled':''}>${canBook()?'加入购物车':'预约验收中'} ${icon('plus')}</button></div></div></article>`;}
function cartPage(){
  if(!canBook())return `${pageHead('BOOKING UNAVAILABLE','预约暂未开放','正式候选环境尚无经 BSR 批准的商品目录和商业政策。')}<section class="card pad">${empty('购物车暂不可用于下单','当前无法核算正式租金、押金或库存，也不会提交预约。','cart')}</section>`;
  const pending=state.user?.role==='customer'?readSubmission('online',state.user.id):null;
  const recovery=pending?`<div class="banner warn" data-pending-reservation>${icon('info')}<div>上次预约提交结果尚未确认。可安全重试原提交，系统会返回同一订单，不会再次占用库存。<button class="btn secondary small" data-action="retry-reservation" ${state.reservationSubmitting?'disabled':''}>找回上次预约</button></div></div>`:'';
  const mergeNotice=state.cartMergeNotice?`<div class="banner warn">${icon('info')}<div>${esc(state.cartMergeNotice)}${state.pendingGuestCart?.length?`<div class="flex" style="margin-top:10px"><button class="btn secondary small" data-action="merge-guest-cart">重新合并</button><button class="btn secondary small" data-action="replace-guest-cart">使用登录前清单</button></div>`:''}</div></div>`:'';
  if(!state.bookingConfirmed)return `${pageHead('YOUR CART','购物车','先确认门店与起租、归还日期，才能核算购物车中每件装备的可订量和费用。')}${recovery}${mergeNotice}<div class="card booking-cart-gate"><div class="booking-pending-art" aria-hidden="true">△</div><h2>还差一步：选好租期</h2><p>购物车内已有 ${cartCount()} 件装备。确认日期后，系统会重新检查该时段库存并计算租金。</p><button class="btn" data-route="catalog">选择租期并查看库存 ${icon('arrow')}</button></div>`;
  const items=state.catalog?.items||[],quote=state.cartQuote;
  const rows=state.cart.map(line=>{
    const item=items.find(x=>x.id===line.variantId);
    if(!item)return `<div class="cart-row"><div><b>装备规格 #${line.variantId} 已下架</b><p class="muted small">请移除后继续预约。</p></div><button class="btn small danger" data-cart-remove="${line.variantId}">移除</button></div>`;
    const quoted=quote?.lines.find(x=>x.variantId===line.variantId);
    return `<div class="cart-row"><div class="cart-thumb ${esc(item.visual)}">${gearSvg(item.visual)}</div><div class="cart-desc"><div class="kicker">${esc(item.category)} · ${esc(item.style)}</div><h3>${esc(item.name)}</h3><p>尺码 ${esc(item.size)} · ${esc(item.skill)} · 当前可订 ${item.available} 件</p><button class="cart-remove" data-cart-remove="${item.id}">移除装备</button></div><div class="cart-controls"><div class="qty" aria-label="${esc(item.name)} 数量"><button data-cart-decrement="${item.id}" aria-label="减少数量">−</button><span>${line.qty}</span><button data-cart-increment="${item.id}" aria-label="增加数量" ${line.qty>=Math.min(item.available,5)?'disabled':''}>+</button></div><b>${quoted?nok(quoted.rentNok):item.dailyNok===null?'待核价':`${nok(item.dailyNok)} / 日`}</b><small class="muted">押金 ${quoted?nok(quoted.depositNok):item.depositNok===null?'待核价':nok(item.depositNok*line.qty)}</small></div></div>`;
  }).join('');
  return `${pageHead('YOUR CART','购物车','在确认预约前调整装备和数量。库存与价格会按当前门店和租期重新校验。',`<button class="btn secondary" data-route="catalog">继续挑选装备</button>`)}${recovery}${mergeNotice}
    <div class="cart-context">${icon('pin')} <b>${esc(state.boot.stores.find(s=>s.id===state.storeId)?.name||'门店')}</b><span>取货 ${state.pickupDate} 09:00</span><span>归还 ${state.returnDate} 16:00</span><button data-route="catalog">修改租期 / 门店 ${icon('chevron')}</button></div>
    ${state.cart.length?`<div class="cart-layout"><div class="card cart-items"><div class="cart-items-head"><h2>已选装备 <span class="muted">${cartCount()} 件</span></h2><span class="small muted">以当前确认报价为准</span></div>${rows}</div><div class="card cart-summary"><div class="kicker">ORDER SUMMARY</div><h2>费用预览</h2>${state.cartError?`<div class="banner warn">${icon('info')}<div>${esc(state.cartError)}。请调整数量、租期或门店。</div></div>`:''}<div class="cost-list"><div class="cost-row"><span>装备租金</span><b>${quote?nok(quote.rentNok):'待核价'}</b></div><div class="cost-row"><span>可退押金</span><b>${quote?nok(quote.depositNok):'待核价'}</b></div><div class="cost-row total"><span>应付合计</span><b>${quote?nok(quote.totalNok):'—'}</b></div></div><p class="small muted">${isShowcase()?'合成订单只按 NOK 示例价模拟记账；验收和费用结清后仅登记模拟退款，不会实际收付资金。':'正式订单仅以 NOK 结算；押金在全部装备验收及费用结清后发起演示退款。'}当前租期 ${quote?`${quote.days} 天`:'待校验'}。</p><div class="late-disclosure"><b>归还时间与超时费</b><span>${state.returnDate} 16:00 前归还；首次有效租赁免计前 2 小时。其后每件每小时为日租金的 10%，每 24 小时封顶一天日租金。按实际归还单件结算。</span></div><button class="btn w-full" data-action="cart" ${quote?'':'disabled'}>核对报价并预约 ${icon('arrow')}</button><p class="small muted" style="margin:12px 0 0">提交前仍可查看逐件费用、取还时间与取消规则。</p></div></div>`:`<div class="card">${empty('购物车还是空的','选好装备后，这里可以统一调整数量并确认预约。','cart')}<div class="cart-empty-action"><button class="btn" data-route="catalog">浏览可租装备 ${icon('arrow')}</button></div></div>`}`;
}
function servicePage(){if(isShowcase()&&!canBook())return `${pageHead('SHOWCASE STATUS','合成预览的实施进度','这里仅使用虚构门店、人员与装备资料。当前可核对账号、角色、来源和目录，租赁流程仍在验收。')}<div class="grid-2"><div class="card pad"><div class="kicker">AVAILABLE NOW</div><h3>受控身份与虚构目录</h3><p class="muted">六类岗位可使用各自账号登录；管理员可开通、停用账号并查看审计。虚构装备和 NOK 示例价目可只读浏览。</p></div><div class="card pad"><div class="kicker">IN VALIDATION</div><h3>预约与模拟结算</h3><p class="muted">预约、合同、付款、归还、受损评估及退款暂由服务端暂停。完成模拟语义和权限验收后才会开放。</p></div></div><div class="banner warn">${icon('shield')}<div>所有资料均为课程合成预览；不代表 BSR 商业政策批准、真实收付款或有效电子签署。</div></div>`;if(isCandidate())return `${pageHead('SERVICE STATUS','服务流程待业务批准','此本机候选环境用于验证身份和数据隔离，尚未开放正式租赁。')}<div class="grid-2"><div class="card pad"><h3>当前可验证</h3><p class="muted">授权账号登录、岗位权限及数据来源隔离。没有获批目录时，预约和报价不可用。</p></div><div class="card pad"><h3>正式业务仍待完成</h3><p class="muted">BSR 需批准 NOK 价目、押金、取还和受损规则；真实支付、退款与合格电子签署还需独立接入和验收。</p></div></div>`;return `${pageHead('HOW IT WORKS','从预约到归还，每一步都清楚。','线上先确认合同并完成模拟支付，到店由店员和你一起确认实物。')}
  <div class="steps-grid"><div class="card process"><div class="num">01</div><h3>选择装备与租期</h3><p>按门店、日期、类别、尺码、款式和技能级别筛选。库存按照完整租期校验。</p></div><div class="card process"><div class="num">02</div><h3>确认合同与付款</h3><p>先查看 NOK 租金、押金、取还时刻与规则，确认当前合同，再完成模拟支付。</p></div><div class="card process"><div class="num">03</div><h3>到店验货取走</h3><p>出示一次性取货码，店员核对身份与装备单件库存编号，完成现场交付。</p></div><div class="card process"><div class="num">04</div><h3>逐件归还与退款</h3><p>店员记录外观和功能验收；无异常登记模拟押金退款，有异常进入经理复核。</p></div></div>
  <div class="grid-2" style="margin-top:19px"><div class="card pad"><h3>费用与货币</h3><p class="muted">${isShowcase()?'虚构挪威门店只以 NOK 示例价模拟记账；每张订单冻结报价快照，新政策不回写旧单。':'BSR 首期以挪威门店批准的 NOK 价目结算。所在地币种仅供参考换算；已确认订单保留报价快照，不因定位、汇率或新政策而改变。'}</p><div class="banner">${icon('wallet')}<div>${isShowcase()?'合成预览不发生真实收款、退款或有效电子签署；上线前还须取得 BSR 政策批准并接入合格服务。':'演示版支付和退款不会发生真实资金划转；上线前须接入支付机构并完成对账、退款幂等和争议处理验证。'}</div></div></div><div class="card pad"><h3>门店服务</h3>${state.boot.stores.map(s=>`<div class="key-value"><div><b>${esc(s.name)}</b><div class="small muted">${esc(s.address)}</div></div><div class="tag">${esc(s.open_hours)}</div></div>`).join('')}</div></div>`;}
function miniPage(){
  const published=state.miniEntry?.status==='ready'&&state.miniEntry?.qrUrl;
  const code=published?`<img src="${esc(state.miniEntry.qrUrl)}" alt="BSR 微信小程序扫码图片" width="220" height="220">`:
    `<div class="mini-peak" aria-hidden="true"><svg viewBox="0 0 220 180"><path d="M5 150 69 54l34 47 36-70 76 119" fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="round"/><path d="M34 151h156" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg></div><strong>发布后显示小程序码</strong>`;
  return `${pageHead('BSR ON WECHAT','雪地出发，掌上安排。','网页与微信小程序将共用门店库存和预约记录；在小程序完成账号关联后，可查看同一顾客订单。')}
    <section class="mini-entry-card"><div class="mini-entry-copy"><div class="kicker">TWO WAYS TO RENT</div><h2>选好租期，<br>再去雪场。</h2><p>小程序将支持按日期查看剩余装备、管理购物车和预约、查看备货及取还进度。网页仍提供完整服务，员工继续在工作台处理同一笔订单。</p><div class="mini-entry-points"><span>01 · 同一库存</span><span>02 · 同一订单</span><span>03 · 进度同步</span></div><div class="mini-entry-actions">${published?'<span class="mini-live-tag">已开放微信扫码</span>':'<span class="mini-pending-tag">小程序筹备中</span>'}<button class="btn secondary" data-route="catalog">继续使用网页版 ${icon('arrow')}</button></div></div>
      <div class="mini-code-panel"><div class="mini-code-frame ${published?'is-live':''}">${code}</div><p>${published?'打开微信扫一扫，即可进入 BSR 小程序。':'当前尚无已发布的小程序码；此图案仅为页面装饰，不能扫码。'}</p></div></section>`;
}
function ordersPage(){const orders=state.orders||[];return `${pageHead('MY RESERVATIONS',state.user?.role==='owner'?'订单总览':'我的预约','查看每一笔订单的报价快照、取货码、验收和押金状态。',state.user?.role==='customer'?`<button class="btn" data-route="catalog">继续挑选装备</button>`:'')}${orders.length?orders.map(orderCard).join(''):empty('尚无预约','从装备目录开始你的第一次雪地旅程','calendar')}`;}
function orderAttention(o){return o.attention?.unresolved?`${orderAlerts.marker(1,o.attention.reason)}${o.attention.isNew?'<span class="order-new-hint">新增待阅</span>':''}`:'';}
function holdCustomerAction(o){if(o.status!=='HOLD'||state.user?.role!=='customer')return '';const c=o.contracts?.[0];return !c?`<button class="btn small" data-contract-issue="${o.id}">生成并阅读合同</button>`:!c.signed_at?`<button class="btn small" data-contract-view="${c.id}" data-contract-order="${o.id}">确认当前合同</button>`:`<button class="btn small" data-pay="${o.id}">确认演示付款</button>`;}
function orderCard(o){return `<article class="card order-card"><div class="order-top"><div><div class="order-code">${esc(o.code)} ${statusTag(o.status)}${orderAttention(o)}</div><div class="order-meta"><span>${icon('pin')} <b>${esc(o.store_name)}</b></span><span>取货 ${dateText(o.pickup_at)}</span><span>应还 ${dateText(o.return_at)}</span>${state.user?.role!=='customer'?`<span>顾客 ${esc(o.customer_name)}</span>`:''}</div></div><div class="right"><b>${nok(o.total_nok)}</b><div class="small muted">${o.status==='EXPIRED'?'历史报价 · 未付款':'含可退押金 '+nok(o.deposit_nok)}</div></div></div><div class="compact-order-progress">当前：<b>${esc(o.workflow?.current||'待处理')}</b> · 负责人 ${esc(o.workflow?.handler?.name||'待分派')}${o.preparation?' · 备货：'+esc(o.preparation.label):''}</div><div class="order-line"><div class="small muted">${o.lines.map(l=>`${esc(l.name)} ${esc(l.size)} ×${l.qty}`).join(' · ')}<br>押金状态：${refundLabel(o.refund_status)}</div><div class="flex"><button class="btn secondary small" data-order="${o.id}">查看详情</button>${holdCustomerAction(o)}${o.status==='EXPIRED'&&state.user?.role==='customer'?`<button class="btn small" data-rebook="${o.id}">重新选择租期</button>`:''}</div></div></article>`;}
const refundLabel=s=>({NOT_DUE:'未到退款环节',REVIEW:'等待异常复核',REFUNDED:'已发起演示退款',DEDUCTED:'已扣完押金'})[s]||s;
function lateSection(o){
 const late=o.late;if(!late?.applicable)return '';
 const pending=['HOLD','CONFIRMED','READY'].includes(o.status);
 return `<section class="late-order-section"><div class="late-order-head"><div><div class="kicker">RETURN WINDOW · NOK</div><h3>归还时限与超时费用</h3></div><span class="tag ${late.assessedNok?'warn':'good'}">${late.assessedNok?`已核定 ${nok(late.assessedNok)}`:'当前无已核定超时费'}</span></div><p>约定归还：<b>${dateText(o.return_at)}</b> · ${late.graceMinutes?`本单享首次有效租赁 ${late.graceMinutes/60} 小时免费宽限`:'本单无首租宽限'}${pending?'（付款后锁定资格）':''}。宽限后每件按日租金 ${late.hourlyPercent}%／小时计，不足一小时按一小时计，每 24 小时封顶一天日租金。</p>${late.estimatedNok?`<div class="late-estimate">截至 ${dateText(late.asOf)}，尚未归还装备预估超时费 ${nok(late.estimatedNok)}；实际金额以逐件归还时间为准。</div>`:''}${late.units.length?`<details><summary>查看逐件归还时间与计费</summary>${late.units.map(u=>`<div class="late-unit-row"><span>${esc(u.inventoryNo)} · ${esc(u.name)}<small>应还 ${dateText(u.dueAt)} · ${u.returned?`实还 ${dateText(u.returnedAt)}`:'尚未归还'}</small></span><b>${nok(u.feeNok)} ${u.returned?'已核定':'预估'}</b></div>`).join('')}</details>`:''}</section>`;
}
function operationsPage(){const list=(state.orders||[]).filter(x=>['HOLD','CONFIRMED','READY','ACTIVE','REVIEW','SETTLEMENT'].includes(x.status));return `${pageHead('FRONT DESK','取货与归还操作台','先完成装备准备和合同签署，再核码交付；支持分批及跨店归还。',`<button class="btn" data-route="preparations">装备准备工作台 ${icon('arrow')}</button>`)}
  <div class="card pad" style="margin-bottom:19px"><div class="card-head"><h3>快速核验</h3><span class="subtle">输入订单号或顾客出示的 6 位取货码</span></div><form data-form="lookup" class="flex"><input class="input" name="code" placeholder="如 BR-XXXXXXXX / A1B2C3" required style="max-width:380px"><button class="btn">${icon('search')} 查询订单</button></form></div>
  <div class="grid-4" style="margin-bottom:19px"><div class="card stat-card"><div class="label">待取货</div><div class="value">${list.filter(x=>x.status==='CONFIRMED').length}</div><div class="foot">可核码交付</div></div><div class="card stat-card"><div class="label">租赁中</div><div class="value">${list.filter(x=>x.status==='ACTIVE').length}</div><div class="foot">可逐件验收归还</div></div><div class="card stat-card"><div class="label">待经理复核</div><div class="value">${list.filter(x=>x.status==='REVIEW').length}</div><div class="foot">照片鉴定与押金结算</div></div><div class="card stat-card"><div class="label">待联系补差 ${orderAlerts.marker(list.filter(x=>x.status==='SETTLEMENT').length,'待联系补差')}</div><div class="value">${list.filter(x=>x.status==='SETTLEMENT').length}</div><div class="foot">联系顾客并核实补差凭证</div></div></div>
  <section class="card pad"><div class="card-head"><h3>需要处理的订单 ${orderAlerts.marker(list.length,'未解决订单')}</h3><span class="subtle">${list.length} 笔</span></div><div class="table-wrap"><table class="table"><thead><tr><th>订单号</th><th>顾客</th><th>门店</th><th>取货</th><th>状态</th><th></th></tr></thead><tbody>${list.map(o=>`<tr><td>${esc(o.code)} ${orderAttention(o)}</td><td>${esc(o.customer_name)}</td><td>${esc(o.store_name)}</td><td>${shortDate(o.pickup_at)}</td><td>${statusTag(o.status)}</td><td><button class="btn secondary small" data-order="${o.id}">处理</button></td></tr>`).join('')}</tbody></table>${!list.length?empty('队列已清空','目前没有待处理订单','check'):''}</div></section>`;}
function policiesPage(){if(isCandidate())return `${pageHead('PRICE GOVERNANCE','商业价目待批准','本机候选环境尚未导入 BSR 批准的 NOK 价目，不能以课程演示价目接受预约。')}<section class="card pad">${empty('暂无可发布的商业价目','押金、取消、超时和损坏规则需由 BSR 确认，真实支付与退款另行验收。','wallet')}</section>`;const list=state.policies||[],latest=list.filter((p,i)=>list.findIndex(x=>x.variant_id===p.variant_id&&x.store_id===p.store_id)===i);return `${pageHead('PRICE GOVERNANCE','版本化价格与押金政策','新价目只对生效后新建订单适用，历史订单保持原报价快照。',`<button class="btn" data-action="new-policy">新增价目版本 ${icon('plus')}</button>`)}<div class="banner warn" style="margin-bottom:18px">${icon('info')}<div>当前展示的是课程项目演示价目，不代表 BSR 实际已批准商业价格。正式上线需由业务方确认政策金额、取消规则和退款承诺。</div></div><div class="card pad"><div class="card-head"><h3>当前价目</h3><span class="subtle">${latest.length} 项门店规格组合</span></div><div class="table-wrap"><table class="table"><thead><tr><th>装备</th><th>门店</th><th>版本</th><th>日租金</th><th>8%参考价押金</th><th>续租日系数</th><th>生效日期</th></tr></thead><tbody>${latest.map(p=>`<tr><td>${esc(p.name)} <span class="mini">${esc(p.size)}</span></td><td>${esc(p.store_name)}</td><td>V${p.version}</td><td>${nok(p.daily_nok)}</td><td>${nok(p.deposit_nok)}</td><td>${p.extra_day_factor}</td><td>${esc(p.effective_from)}</td></tr>`).join('')}</tbody></table></div></div>`;}
function reportsPage(){const r=state.reports;if(!r)return empty('正在加载报表','请稍候','chart');const max=Math.max(1,...r.byStore.map(x=>x.revenue_nok));return `${pageHead('BUSINESS INTELLIGENCE','从数据看见门店表现。','订单、营收、装备状态与支付流水汇总，支持经营复盘。')}<div class="grid-4"><div class="card stat-card"><div class="label">累计预约</div><div class="value">${r.overview.orders}</div><div class="foot">含待支付与取消</div></div><div class="card stat-card"><div class="label">确认租金</div><div class="value" style="font-size:24px">${nok(r.overview.revenue_nok)}</div><div class="foot">演示数据</div></div><div class="card stat-card"><div class="label">未闭环租赁业务</div><div class="value">${r.overview.open_rentals}</div><div class="foot">仍需闭环</div></div><div class="card stat-card"><div class="label">押金待复核</div><div class="value">${r.overview.refund_reviews}</div><div class="foot">须经理审批</div></div></div><div class="split" style="margin-top:19px"><div class="card pad"><div class="card-head"><h3>门店租金表现</h3><span class="subtle">NOK · 演示数据</span></div><div class="chart">${r.byStore.map(x=>`<div class="bar-wrap"><b>${nok(x.revenue_nok)}</b><div class="bar" style="height:${Math.max(5,130*x.revenue_nok/max)}px"></div><label>${esc(x.name)}</label></div>`).join('')}</div></div><div class="card pad"><div class="card-head"><h3>装备状态分布</h3>${icon('box')}</div>${r.inventory.map(x=>`<div style="margin:11px 0"><div class="between small"><b>${esc(x.status)}</b><span>${x.count} 件</span></div><div class="progress-bar"><span style="width:${Math.round(x.count/Math.max(1,r.inventory.reduce((a,b)=>a+b.count,0))*100)}%"></span></div></div>`).join('')}</div></div><div class="card pad" style="margin-top:19px"><div class="card-head"><h3>支付与退款对账概览</h3><span class="subtle">演示适配器流水，不代表真实资金</span></div><div class="grid-4">${['RENT','DEPOSIT','REFUND','CANCELLATION_REFUND'].map(type=>{const p=r.payments.find(x=>x.type===type);return `<div><div class="small muted">${{RENT:'租金收取',DEPOSIT:'押金收取',REFUND:'押金退款',CANCELLATION_REFUND:'取消退款'}[type]}</div><div class="strong" style="font-size:19px;margin-top:4px">${nok(p?.total_nok||0)}</div><div class="small muted">${p?.count||0} 笔</div></div>`}).join('')}</div></div><section class="card pad" style="margin-top:19px"><div class="card-head"><h3>归还费用、押金与补差</h3><span class="subtle">NOK · 演示登记，不计入租金营收</span></div><div class="grid-4">${[['核定损坏费',r.damage?.damage_fee_nok],['核定超时费',r.damage?.late_fee_nok],['押金抵扣',r.damage?.deducted_nok],['已登记补差',r.damage?.paid_nok],['剩余待补差',r.damage?.remaining_nok]].map(([label,value])=>`<div><div class="small muted">${label}</div><b style="display:block;margin-top:9px">${nok(value||0)}</b></div>`).join('')}</div></section>`;}
function usersPage(){return `${pageHead('ACCESS CONTROL','账号与角色权限','角色变更可审计；管理员不参与日常租赁业务。')}<div class="card pad"><div class="table-wrap"><table class="table"><thead><tr><th>姓名</th><th>邮箱</th><th>角色</th><th>门店</th><th>创建时间</th><th></th></tr></thead><tbody>${state.users.map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><span class="tag">${roleLabels[u.role]}</span></td><td>${esc(state.boot.stores.find(s=>s.id===u.store_id)?.name||'跨门店')}</td><td class="mini">${shortDate(u.created_at)}</td><td>${u.id!==state.user.id?`<button class="btn secondary small" data-user="${u.id}">修改角色</button>`:''}</td></tr>`).join('')}</tbody></table></div></div>`;}
function auditPage(){return `${pageHead('AUDIT TRAIL','关键操作，全程留痕。','价格、支付、库存、退款与权限操作均记录在不可编辑的审计事件中。')}<div class="card pad"><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>执行者</th><th>事件</th><th>对象</th><th>摘要</th></tr></thead><tbody>${state.audit.map(a=>`<tr><td class="mini nowrap">${dateText(a.created_at)}</td><td>${esc(a.actor_name||'系统')}</td><td><span class="tag">${esc(a.action)}</span></td><td>${esc(a.target_type)} #${a.target_id||'—'}</td><td class="mini">${esc(a.detail_json.slice(0,90))}</td></tr>`).join('')}</tbody></table>${state.audit.length?'':empty('暂无审计事件','完成一项业务操作后将在这里出现')}</div></div>`;}
function profilePage(){const u=state.user;return `${pageHead('YOUR PROFILE','个人资料','量体信息只用于装备匹配与门店备货，不会改变基础定价。')}<div class="card pad" style="max-width:650px"><form data-form="profile" class="form-grid"><div class="field"><label>姓名</label><input name="name" value="${esc(u.name)}" required></div><div class="field"><label>联系电话</label><input name="phone" value="${esc(u.phone||'')}"></div><div class="field"><label>身高 / cm</label><input name="heightCm" type="number" min="80" max="230" value="${u.heightCm||''}"></div><div class="field"><label>体重 / kg</label><input name="weightKg" type="number" min="20" max="250" value="${u.weightKg||''}"></div><div class="field"><label>鞋码</label><input name="shoeSize" value="${esc(u.shoeSize||'')}" placeholder="如 EU 42"></div><div class="wide action-row"><button class="btn">保存资料</button></div></form></div>`;}
function loginPage(){const register=state.loginMode==='register';return `<div class="login-layout"><div class="login-art"><div class="brand">${logo()}</div><div><div class="eyebrow" style="color:#def3f1">SKARDALEN · NORWAY</div><h1>让每一段雪上旅程，都从容开始。</h1><p>浏览装备、提前预约、到店核码取货。门店与运营团队在同一个系统中协作。</p></div><div class="small">BSR · 课程项目本地预览 · 无真实支付</div></div><div class="login-panel"><div class="login-box"><div class="kicker">WELCOME TO BSR</div><h2>${register?'创建顾客账号':'欢迎回来'}</h2><p class="muted">${register?'填写基本信息即可开始预约。':'登录后可继续预约或进入分角色工作台。'}</p><form class="login-form" data-form="${register?'register':'login'}">${register?'<div class="field"><label>姓名</label><input name="name" required minlength="2" placeholder="你的姓名"></div>':''}<div class="field"><label>电子邮箱</label><input name="email" type="email" required placeholder="name@example.com"></div><div class="field"><label>密码</label><input name="password" type="password" required minlength="8" placeholder="至少 8 位"></div><button class="btn w-full">${register?'创建账号':'登录工作台'} ${icon('arrow')}</button></form><div class="login-switch">${register?'已有账号？':'还没有账号？'} <button data-action="toggle-login">${register?'返回登录':'注册顾客账号'}</button>　·　<button data-route="catalog">先浏览装备</button></div>${!register?`<div style="margin-top:37px;border-top:1px solid var(--line);padding-top:20px"><div class="between"><b>快速体验不同角色</b><span class="small muted">统一演示密码 ${esc(state.boot?.demoLogin?.password||'暂不可用')}</span></div><div class="demo-accounts">${[['customer','顾客'],['staff','店员'],['manager','经理'],['contractor','维修'],['owner','跨店运营总监'],['admin','平台运维管理员']].map(([role,label])=>`<button class="demo-account" data-demo="${role}"><span class="role-option-label">${roleLabels[role]}</span><span class="role-option-note">${esc(jobs[role].scope.slice(0,38))}…</span></button>`).join('')}</div><p class="small muted" style="margin-top:12px">演示账号只供本地预览；上传公开仓库前会移除默认密码或限制其仅用于种子数据。</p></div>`:''}</div></div></div>`;}
function candidateLoginPage(){
  const changing=!!state.user?.mustChangePassword;
  const showcase=isShowcase();
return `<div class="login-layout"><div class="login-art"><div class="brand">${logo()}</div><div><div class="eyebrow" style="color:#def3f1">${showcase?'BSR · SYNTHETIC SHOWCASE':'BSR · LOCAL CANDIDATE'}</div><h1>先确认身份，<br>再准备雪上服务。</h1><p>${showcase?(canBook()?'此实例只使用虚构门店、人员、装备和 NOK 示例价目；预约、合同与资金步骤均为模拟。':'此实例只使用虚构门店、人员、装备和 NOK 示例价目；预约与模拟结算仍在验收。'):'此实例只在本机验证身份和数据隔离。门店商品、商业价目与租赁政策尚待 BSR 批准。'}</p></div><div class="small">${showcase?'BSR · 合成预览 · 无真实客户或支付':'BSR · 正式候选验证 · 无真实支付或合格电子签署'}</div></div><div class="login-panel"><div class="login-box"><div class="kicker">IDENTITY VERIFICATION</div><h2>${changing?'更换一次性密码':'受管理账号登录'}</h2><p class="muted">${changing?`${esc(state.user.name)}，请先更换管理员线下交付的初始密码。更换后需重新登录。`:'顾客自助注册和恢复尚未启用；请联系已授权的管理员完成线下身份核验。'}</p>${changing?`<form class="login-form" data-form="change-password"><div class="field"><label>当前一次性密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label>设置新密码</label><input name="newPassword" type="password" autocomplete="new-password" required minlength="12" placeholder="至少 12 位"></div><button class="btn w-full">更换密码并重新登录 ${icon('arrow')}</button></form><div class="login-switch"><button data-action="logout">退出此账号</button></div>`:`<form class="login-form" data-form="login"><div class="field"><label>电子邮箱</label><input name="email" type="email" autocomplete="username" required placeholder="name@example.com"></div><div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" required></div><button class="btn w-full">登录 ${icon('arrow')}</button></form>${showcase?'':`<div class="login-switch"><button data-route="catalog">查看当前服务状态</button></div>`}`}</div></div></div>`;
}
function candidateUsersPage(){
  const rows=state.users.map(u=>{
    const disabled=u.account_state==='DISABLED';
    const status=disabled?'已停用':u.must_change_password||u.mustChangePassword?'待改初始密码':'已开通';
    return `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(roleLabels[u.role]||u.role)}</td><td>${esc(state.boot.stores.find(s=>s.id===Number(u.store_id??u.storeId))?.name||'按角色/任务授权')}</td><td>${status}${u.id!==state.user?.id?`<div class="candidate-user-actions"><button class="btn secondary small" data-candidate-reset="${u.id}">核验后重置密码</button><button class="btn secondary small" data-candidate-state="${u.id}">${disabled?'核验后启用':'停用账号'}</button></div>`:''}</td></tr>`;
  }).join('');
  return `${pageHead('ACCOUNT PROVISIONING','受管理账号',isShowcase()?'合成预览账号由权限管理员为虚构身份逐个开通。首次登录须更换一次性密码；自助注册暂未启用。':'正式候选账号由权限管理员线下核验后开通。首次登录必须更换一次性密码；自助注册暂未启用。',state.user?.role==='admin'?`<button class="btn" data-action="new-candidate-user">开通已核验账号 ${icon('plus')}</button>`:'')}<div class="banner warn" style="margin-bottom:18px">${icon('shield')}<div>请通过可信线下渠道交付一次性密码。${isShowcase()?'只填写虚构人员资料，不输入真实客户身份、照片或联系方式。':'真实顾客资料、密码和核验材料不得填入课程测试环境。'}</div></div><section class="card pad"><div class="card-head"><h3>当前账号</h3><span class="subtle">${state.users.length} 个</span></div><div class="table-wrap"><table class="table"><thead><tr><th>姓名</th><th>邮箱</th><th>岗位</th><th>门店</th><th>状态 / 管理</th></tr></thead><tbody>${rows}</tbody></table>${state.users.length?'':empty('暂无账号','先使用离线初始化流程建立首个管理员。','users')}</div></section>`;
}
function candidateReportsPage(){
  const r=state.reports;
  if(!r)return empty('正在加载候选数据','请稍候','chart');
  return `${pageHead('CANDIDATE DATA','候选数据概览','以下仅为隔离环境中的测试记录；未接入真实资金，也不代表 BSR 已批准商业政策。')}<div class="grid-4"><div class="card stat-card"><div class="label">预约记录</div><div class="value">${r.overview?.orders||0}</div><div class="foot">隔离测试数据</div></div><div class="card stat-card"><div class="label">租金记录</div><div class="value" style="font-size:24px">${nok(r.overview?.revenue_nok||0)}</div><div class="foot">演示适配器，不代表到账</div></div><div class="card stat-card"><div class="label">未闭环业务</div><div class="value">${r.overview?.open_rentals||0}</div><div class="foot">需要授权人员处理</div></div><div class="card stat-card"><div class="label">待复核押金</div><div class="value">${r.overview?.refund_reviews||0}</div><div class="foot">无真实退款</div></div></div>`;
}
function render(){
  const pages={catalog:catalogPage,cart:cartPage,service:servicePage,mini:miniPage,orders:ordersPage,'order-alerts':orderAlerts.page,'damage-cases':damageUI.page,roles:serviceUI.rolesPage,dashboard:workplace.dashboardPage,operations:operationsPage,inventory:workplace.inventoryPage,maintenance:workplace.maintenancePage,policies:policiesPage,shifts:workplace.shiftsPage,attendance:workplace.attendancePage,reports:isCandidate()?candidateReportsPage:reportsPage,users:isManaged()?candidateUsersPage:usersPage,audit:auditPage,profile:fulfillmentUI.profilePage,preparations:fulfillmentUI.prepPage,counter:fulfillmentUI.counterPage,team:fulfillmentUI.teamPage,network:fulfillmentUI.networkPage};
  $('#app').innerHTML=state.route==='login'?(isManaged()?candidateLoginPage():loginPage()):shell((pages[state.route]||catalogPage)()+(state.route==='reports'&&!isCandidate()?fulfillmentUI.reportExtras(state.reports):''));
  if(isManaged()&&state.route==='users')$('#app').querySelector('section.card.pad')?.classList.add('candidate-users');
  const toastEl=$('#toast');if(toastEl)toastEl.classList.add('toast');
  damageUI.hydrate();
  if(state.boot?.temporaryPreview){
    const note=document.createElement('aside');note.className='temporary-preview-note';note.setAttribute('role','note');
    note.textContent='临时课程演示 · 空闲后首次打开可能需等待约一分钟，重启后演示记录可能重置。请勿填写真实资料。正式域名 bsrski.cn 待网站备案通过后切换；小程序尚未发布。';
    $('#app').prepend(note);
  }
}
function modal(content,wide=false){state.modal=`<div class="modal-back" data-modal-backdrop><div class="modal ${wide?'wide':''}" role="dialog" aria-modal="true">${content}</div></div>`;render();}
function closeModal(){state.modal=null;state.dirtyForm=false;render();if(state.pendingSync)syncData(true);}
function modalHeader(title,subtitle=''){return `<div class="modal-head"><div><div class="kicker">BSR SERVICE</div><h2>${title}</h2>${subtitle?`<p class="small muted" style="margin:5px 0 0">${subtitle}</p>`:''}</div><button class="modal-close" data-action="close-modal" aria-label="关闭">×</button></div>`;}
async function cartModal(){
  if(!state.cart.length)return toast('请先选择装备',true);
  if(!state.damageConsent)return damageUI.consentModal();
  let q;try{q=await api('/api/quote','POST',{...windowPayload(),items:state.cart});}catch(e){return toast(e.message,true);}
  state.quote=q;
  modal(`${modalHeader('确认预约清单',isShowcase()?'仅按虚构 NOK 示例价模拟记账，不发生实际收款':'正式订单以 NOK 计价，参考币种不参与支付')}
    <div class="detail-grid"><div class="detail-cell"><div class="k">取货门店</div><div class="v">${esc(state.boot.stores.find(s=>s.id===q.storeId)?.name)}</div></div><div class="detail-cell"><div class="k">租期</div><div class="v">${q.days} 天</div></div><div class="detail-cell"><div class="k">取货时间</div><div class="v">${dateText(q.pickupAt)}</div></div><div class="detail-cell"><div class="k">应还时间</div><div class="v">${dateText(q.returnAt)}</div></div></div>
    <div class="skill-explainer"><div class="kicker">EQUIPMENT FIT</div><h3>你这次滑雪的水平是什么？</h3><p>请按这次要滑的雪道和自己的控制能力自评，门店会据此推荐适合的双板、雪鞋等。这是每张租赁单单独记录的顾客水平，不是员工技能，也不是装备入库后固定的技能等级。</p><div class="field"><label for="checkout-skill">本次滑雪水平 · 必选</label><select id="checkout-skill" required><option value="" ${!state.customerSkill?'selected':''} disabled>请选择本次水平</option>${[['初级','刚开始学习，适合初级雪道'],['中级','能稳定转弯，尝试中级雪道'],['高级','能熟练控制速度与多种雪况'],['专家+','能应对高难度雪道或竞技环境']].map(([value,label])=>`<option value="${value}" ${state.customerSkill===value?'selected':''}>${value} · ${label}</option>`).join('')}</select></div></div><p class="small muted">合同将保存当前档案和本次自评水平；请先在“个人资料”补全地址、出生年与量体信息。</p>
    <div style="margin:20px 0 13px;font-weight:800">装备明细</div>${q.lines.map(l=>`<div class="line-item"><div><b>${esc(l.name)}</b><div class="small muted">${esc(l.size)} · ${l.qty} 件 · V${l.policyVersion} 价目</div></div><b>${nok(l.rentNok)}</b></div>`).join('')}
    <div class="cost-list" style="margin-top:18px"><div class="cost-row"><span>装备租金</span><b>${nok(q.rentNok)}</b></div><div class="cost-row"><span>可退押金</span><b>${nok(q.depositNok)}</b></div><div class="cost-row total"><span>应付合计</span><span>${nok(q.totalNok)}</span></div></div>
    <p class="small muted">${isShowcase()?'合成预览：所有价目、合同、收款与退款均为模拟。':`${reference(q.totalNok)} · 参考汇率：${esc(state.boot.exchangeSource)}，实际支付 NOK。`}</p>
    <div class="banner warn">${icon('info')}<div>归还截止为挪威当地时间 ${state.returnDate} 16:00。首次有效租赁超时前两小时免费，之后按每件日租金 10%／小时计费，不足一小时按一小时计，每 24 小时封顶一天日租金；按实际归还时间结算。此为${isShowcase()?'合成预览':'本地演示'}规则，正式政策待 BSR 确认。下单暂留 15 分钟，${isShowcase()?'模拟支付不会扣款':'支付不真实扣款'}；取货前 24 小时内取消按示例收取租金 20% 费用。</div></div>
    <div class="action-row"><button class="btn secondary" data-action="close-modal">继续挑选</button><button class="btn" data-action="create-reservation">${isShowcase()?'确认模拟预约':'确认并创建预约'} ${icon('arrow')}</button></div>`,true);
}
function orderActions(o){
 const role=state.user?.role,staff=['staff','manager'].includes(role);
 const ready=!o.requires_fulfillment||(o.preparation?.status==='READY'&&o.contracts?.[0]?.signed_at);
 return `<div class="order-primary-actions">${holdCustomerAction(o)}${role==='customer'&&['HOLD','CONFIRMED','READY'].includes(o.status)?`<button class="btn danger" data-cancel="${o.id}">取消预约</button>`:''}
 ${staff&&o.status==='HOLD'?`<button class="btn secondary" data-counter-pay="${o.id}">现场签署后确认演示付款</button>`:''}
 ${staff&&['CONFIRMED','READY'].includes(o.status)?`<button class="btn secondary" data-preparation="${o.id}">准备装备 / 查看检查</button><button class="btn" data-pickup="${o.id}" ${ready?'':'disabled'}>核码并逐件交付</button>${!ready?'<span class="small">新订单须完成装备准备，并由顾客签署当前合同版本后方可交付。</span>':''}`:''}
 ${staff&&o.status==='ACTIVE'?`<button class="btn" data-return="${o.id}">开始分批 / 逐件归还验收</button>`:''}${staff&&o.status==='REVIEW'?`<button class="btn secondary" data-staff-review="${o.id}" ${o.staff_reviewed_at?'disabled':''}>${o.staff_reviewed_at?'已完成店员复核':'店员复核 · 提交经理核价'}</button>`:''}${role==='manager'&&o.status==='REVIEW'?`<button class="btn" data-approve="${o.id}" ${o.staff_reviewed_at&&o.damage?.cases?.length&&o.damage.cases.every(c=>c.status==='APPROVED')?'':'disabled'}>核算押金抵扣与补差</button>`:''}${staff&&o.status==='REVIEW'?'<span class="small">店员核对实物、合同和照片资料；技师评估程度，经理最后核价，不可越权直接扣款。</span>':''}</div>`;
}
function orderModal(o){
  state.activeOrder=o;
  const customer=state.user?.role==='customer';
  const steps=['HOLD','CONFIRMED','ACTIVE','COMPLETED'];const idx=['REVIEW','SETTLEMENT'].includes(o.status)?2:steps.indexOf(o.status);
  modal(`${modalHeader(`订单 ${esc(o.code)}`,`${esc(o.customer_name)} · ${esc(o.store_name)}`)}<div class="between"><span>${statusTag(o.status)} ${orderAttention(o)}</span><span class="small muted">创建于 ${dateText(o.created_at)}</span></div>${o.status==='EXPIRED'?`<div class="banner warn">${icon('info')}<div>15 分钟预约暂留已过期，库存已重新开放。本单未发生演示付款，以下金额仅为历史报价。${customer?'请重新选择租期并确认当前库存、报价和规则。':'请引导顾客重新开单，不要继续签署或收款。'}${customer?`<div class="action-row"><button class="btn small" data-rebook="${o.id}">保留装备，重新选择租期</button></div>`:''}</div></div>`:''}${serviceUI.workflow(o.workflow)}${orderActions(o)}${fulfillmentUI.preview(o.preparation,o.id)}${fulfillmentUI.contractSection(o)}${fulfillmentUI.amendmentSection(o)}${damageUI.orderSummary(o)}
    <div class="detail-grid" style="margin:22px 0"><div class="detail-cell"><div class="k">取货</div><div class="v">${dateText(o.pickup_at)}</div></div><div class="detail-cell"><div class="k">应还</div><div class="v">${dateText(o.return_at)}</div></div><div class="detail-cell"><div class="k">取货门店</div><div class="v">${esc(o.store_name)}</div></div><div class="detail-cell"><div class="k">取货码 · 已确认后有效</div><div class="v" style="font-size:20px;letter-spacing:.13em">${['CONFIRMED','READY','ACTIVE','REVIEW','SETTLEMENT','COMPLETED'].includes(o.status)?esc(o.pickup_code):o.status==='EXPIRED'?'暂留已失效':'等待付款'}</div></div></div>
    <h3>装备与报价快照</h3>${o.lines.map(l=>`<div class="line-item"><span>${esc(l.name)} · ${esc(l.size)} ×${l.qty}</span><b>${nok(l.unit_rent_nok*l.qty)}</b></div>`).join('')}
    <div class="cost-list" style="margin:15px 0 19px"><div class="cost-row"><span>租金</span><b>${nok(o.rent_nok)}</b></div><div class="cost-row"><span>可退押金</span><b>${nok(o.deposit_nok)}</b></div><div class="cost-row total"><span>合计 · NOK</span><b>${nok(o.total_nok)}</b></div></div>
    ${lateSection(o)}
    ${o.inspections.length?`<h3>逐件验收</h3>${o.inspections.map(i=>`<div class="line-item"><span>库存 #${i.unit_id} · ${esc(i.condition)}<span class="small muted"> ${esc(i.note)}</span></span><b>${i.condition==='DAMAGED'&&!i.approved?'待照片鉴定 / 经理核定':i.fee_nok?`核定费用 ${nok(i.fee_nok)}`:'无损坏费用'}</b></div>`).join('')}`:''}
    ${o.units.length?`<h3>单件交接记录</h3><div class="table-wrap"><table class="table"><thead><tr><th>编号 / 装备</th><th>借出</th><th>归还</th><th>归还门店</th></tr></thead><tbody>${o.units.map(u=>`<tr><td>${esc(u.inventory_no)}<div class="mini">${esc(u.name)}</div></td><td class="mini">${dateText(u.out_at)}</td><td class="mini">${u.returned?dateText(u.returned_at):'尚未归还'}</td><td class="mini">${esc(state.boot.stores.find(s=>s.id===u.return_store_id)?.name||'—')}</td></tr>`).join('')}</tbody></table></div>`:''}
    <div class="banner">${icon('wallet')}<div>押金状态：<b>${refundLabel(o.refund_status)}</b>${o.refund_nok?` · ${nok(o.refund_nok)}`:''}。仅在全部单件归还、验收完成且无待处理争议后发起演示退款。</div></div>
    ${o.payments.length?`<div class="small muted" style="margin-top:15px">演示支付流水：${o.payments.map(p=>`${p.type} ${nok(p.amount_nok)}`).join(' · ')}</div>`:''}
    ${damageUI.orderSection(o)}
    `,true);
}
function returnModal(o){state.activeOrder=o;modal(`${modalHeader('逐件 / 分批归还验收',`订单 ${o.code} · 只勾选本批已实际归还的装备`)}<form data-form="return"><input type="hidden" name="reservationId" value="${o.id}"><div class="field fulfillment-return-batch"><label>本批接收门店</label><select name="returnStoreId"><option value="${state.user.storeId}">${esc(state.boot.stores.find(s=>s.id===state.user.storeId)?.name||'当前门店')}</option></select><p class="small muted">由当前登录员工所属门店接收；异店归还仅显示单件验收资料。货物所在店随归还更新，永久归属由经理调拨接收变更。</p></div>${o.crossStoreReturn?`<div class="banner">${icon('info')}<div>已核对完整代码，可办理异店逐件接收。顾客资料、押金与结算由原订单门店处理。</div></div>`:''}${o.late?.applicable?`<div class="banner">${icon('clock')}<div>应还 ${dateText(o.return_at)}；${o.late.graceMinutes?'本单首租前两小时免费宽限。':'本单无首租宽限。'}截至当前尚未归还装备的预估超时费 ${nok(o.late.estimatedNok)}，提交后按各单件实际归还时间核定。</div></div>`:''}${o.units.filter(u=>!u.returned).map(u=>`<div class="card pad" style="margin:12px 0"><label class="check-return-unit"><input name="return-${u.unit_id}" type="checkbox" checked><span>本批归还 · ${esc(u.inventory_no)} · ${esc(u.name)} / ${esc(u.size)}</span></label><div class="form-grid" style="margin-top:13px"><div class="field"><label>验收结果</label><select name="condition-${u.unit_id}"><option value="GOOD">无损 / 正常磨损</option><option value="CLEANING">需清洁（确认清洁前不可再租）</option><option value="DAMAGED">损坏 / 异常</option></select></div><div class="field"><label>损坏费用</label><div class="small muted">由技师凭照片鉴定，前台不直接定价。</div></div><div class="field wide"><label>验收依据 / 备注</label><input name="note-${u.unit_id}" placeholder="损坏时至少填写 3 个字"></div></div></div>`).join('')}<div class="banner warn">${icon('info')}<div>部分归还保持合同有效，全部归还且异常闭环后才退押金。疑似受损从本次归还起24小时内反馈初评，不等待其他装备归还。</div></div><div class="action-row"><button class="btn">提交本批逐件验收</button></div></form>`,true);}
function formModal(type){
  if(type==='policy'){modal(`${modalHeader('新增价格政策版本','批准后仅影响生效日期后的新订单')}<form data-form="policy" class="form-grid"><div class="field"><label>门店</label><select name="storeId">${storeOptions(state.user.storeId,true)}</select></div><div class="field"><label>装备规格</label><select name="variantId">${(state.policies||[]).filter((p,i,rows)=>p.store_id===state.user.storeId&&rows.findIndex(x=>x.store_id===p.store_id&&x.variant_id===p.variant_id)===i).map(p=>`<option value="${p.variant_id}">${esc(p.name)} · ${esc(p.size)}</option>`).join('')}</select></div><div class="field"><label>日租金 · NOK</label><input name="dailyNok" type="number" min="0" required></div><div class="field"><label>押金规则</label><div class="deposit-disclosure">每件装备参考价值 × 8%。系统自动计算，不能手工调高；已创建订单保留原报价。</div></div><div class="field"><label>续租日系数</label><input name="extraDayFactor" type="number" min="0" max="1.5" step="0.05" value="0.8"></div><div class="field"><label>生效日期</label><input name="effectiveFrom" type="date" value="${day(1)}" required></div><div class="wide banner warn">${icon('info')}<div>创建即作为经理批准的演示价目。生产环境应增加双人审批和支付服务核验。</div></div><div class="wide action-row"><button class="btn">批准并发布版本</button></div></form>`);}
  if(type==='transfer'){modal(`${modalHeader('发起跨店调拨','仅可调拨状态为 AVAILABLE 的单件')}<form data-form="transfer" class="form-grid"><div class="field wide"><label>库存单件</label><select name="unitId">${state.inventory.filter(u=>u.status==='AVAILABLE'&&u.store_id===state.user.storeId).map(u=>`<option value="${u.id}">${esc(u.inventory_no)} · ${esc(u.name)} · ${esc(u.store_name)}</option>`).join('')}</select></div><div class="field"><label>目标门店</label><select name="toStoreId">${otherStoreOptions()}</select></div><div class="wide action-row"><button class="btn">发出调拨</button></div></form>`);}
}
async function refresh(){await loadRoute();state.modal=null;state.pendingSync=false;state.dirtyForm=false;render();}
async function submitReservation(entry){
  if(state.reservationSubmitting)return;
  state.reservationSubmitting=true;
  const buttons=$$('[data-action=create-reservation],[data-action=retry-reservation]');buttons.forEach(button=>button.disabled=true);
  try {
    const result=await api('/api/reservations','POST',entry.payload,{'Idempotency-Key':entry.key});
    clearSubmission('online',state.user.id);state.cartQuote=null;state.damageConsent=null;
    if(result.status==='EXPIRED'){
      state.bookingConfirmed=false;state.modal=null;
      toast(`已找回预约 ${result.code}，但暂留已到期。请重新选择租期，系统会重新检查库存与报价。`);
      await navigate('catalog');return;
    }
    state.cart=[];
    let cartAfterOrder='';
    try{await saveCart();}
    catch(error){cartAfterOrder=error.code==='CART_STALE'?'；另一端购物车有新内容，已为你保留':'；购物车同步暂未完成，订单仍已创建';}
    toast((result.status==='HOLD'?`${result.replayed?'已找回':'已创建'}预约 ${result.code}，请先阅读并确认当前合同`:`已找回预约 ${result.code}，当前状态：${statusLabels[result.status]||result.status}`)+cartAfterOrder);state.modal=null;await navigate('orders');
  } catch(error) {
    if(error instanceof TypeError)throw new Error('网络响应不确定。请在购物车点击“找回上次预约”，安全重试同一提交。');
    throw error;
  } finally {state.reservationSubmitting=false;buttons.forEach(button=>button.disabled=false);}
}
async function act(target){
  if(target.matches('[data-modal-backdrop]')){closeModal();return;}
  if(await fulfillmentUI.act(target))return;
  if(await damageUI.act(target))return;
  if(await serviceUI.act(target))return;
  if(await orderAlerts.act(target))return;
  const rebook=target.closest('[data-rebook]');if(rebook){
    const o=state.orders.find(order=>order.id===Number(rebook.dataset.rebook))||state.activeOrder;
    if(state.user?.role!=='customer'||o?.status!=='EXPIRED')throw new Error('只能重新选择本人已过期的预约');
    if(state.cart.length&&!confirm('重新预约会用原订单装备替换当前购物车，是否继续？'))return;
    state.cart=o.lines.map(line=>({variantId:line.variant_id,qty:line.qty}));
    state.storeId=o.store_id;localStorage.setItem('bsr-store',String(o.store_id));
    state.pickupDate=osloDate(o.pickup_at)>=earliestPickupDate()?osloDate(o.pickup_at):earliestPickupDate();
    const oldReturn=osloDate(o.return_at);
    state.returnDate=oldReturn>=state.pickupDate&&oldReturn<=addCalendarDays(state.pickupDate,29)?oldReturn:addCalendarDays(state.pickupDate,1);
    state.bookingConfirmed=false;state.cartQuote=null;state.damageConsent=null;
    await saveCart();
    await navigate('catalog');toast('已带回原装备选择。请确认新的取还日期，再查看实时库存与报价。');return;
  }
  const route=target.closest('[data-route]');if(route){await navigate(route.dataset.route);return;}
  if(await workplace.act(target))return;
  const category=target.closest('[data-category]');if(category){state.category=category.dataset.category;state.subtype='';render();return;}
  const add=target.closest('[data-add]');if(add){const id=Number(add.dataset.add),item=state.cart.find(x=>x.variantId===id),product=state.catalog?.items.find(x=>x.id===id);if(!product||!product.available||((item?.qty||0)>=Math.min(product.available,5)))throw new Error('单种装备最多预约 5 件，且不能超过当前库存');await changeCart(()=>{if(item)item.qty++;else state.cart.push({variantId:id,qty:1});});render();toast('已加入购物车');return;}
  const cartRemove=target.closest('[data-cart-remove]');if(cartRemove){await changeCart(()=>{state.cart=state.cart.filter(x=>x.variantId!==Number(cartRemove.dataset.cartRemove));});await loadCartQuote();render();toast('已从购物车移除');return;}
  const cartStep=target.closest('[data-cart-increment],[data-cart-decrement]');if(cartStep){const increment=cartStep.hasAttribute('data-cart-increment'),id=Number(increment?cartStep.dataset.cartIncrement:cartStep.dataset.cartDecrement),line=state.cart.find(x=>x.variantId===id),product=state.catalog?.items.find(x=>x.id===id);if(!line)return;const next=line.qty+(increment?1:-1);await changeCart(()=>{if(next<1){state.cart=state.cart.filter(x=>x!==line);}else{if(increment&&(!product||next>Math.min(product.available,5)))throw new Error('单种装备最多预约 5 件，且不能超过当前库存');line.qty=next;}});await loadCartQuote();render();return;}
  const order=target.closest('[data-order]');if(order){const o=await api(`/api/reservations/${Number(order.dataset.order)}`);if(o.attention?.isNew){await orderAlerts.read([{id:o.id,kind:'reservation',noticeVersion:1}]);o.attention.isNew=false;}orderModal(o);return;}
  const pay=target.closest('[data-pay]');if(pay){await api(`/api/reservations/${pay.dataset.pay}/pay`,'POST');toast('演示支付成功，取货码已生成');await refresh();return;}
  const cancel=target.closest('[data-cancel]');if(cancel){if(!confirm('确认取消此预约？取货前 24 小时内演示收取租金 20% 取消费。'))return;await api(`/api/reservations/${cancel.dataset.cancel}/cancel`,'POST');toast('预约已取消');await refresh();return;}
  const pick=target.closest('[data-pickup]');if(pick){const o=state.orders.find(x=>x.id===Number(pick.dataset.pickup))||state.activeOrder;await api('/api/operations/pickup','POST',{code:o.pickup_code});toast('单件已绑定，交付完成');await refresh();return;}
  const ret=target.closest('[data-return]');if(ret){returnModal(state.orders.find(x=>x.id===Number(ret.dataset.return))||state.activeOrder);return;}
  const approve=target.closest('[data-approve]');if(approve){const o=await api(`/api/reservations/${approve.dataset.approve}`),fee=o.damage.cases.reduce((n,c)=>n+c.fee_nok,0);if(!confirm(`核定损坏费 ${nok(fee)}；抵扣押金 ${nok(Math.min(fee,o.deposit_nok))}；可退 ${nok(Math.max(0,o.deposit_nok-fee))}；需补差 ${nok(Math.max(0,fee-o.deposit_nok))}。确认后执行演示结算？`))return;const result=await api(`/api/operations/refunds/${approve.dataset.approve}/approve`,'POST');toast(result.supplementNok?'已核定，员工需联系顾客补差后才能结清':'押金已完成演示结算');await refresh();return;}
  const receive=target.closest('[data-receive]');if(receive){await api(`/api/transfers/${receive.dataset.receive}/receive`,'POST');toast('装备已接收并更新库存门店');await refresh();return;}
  const user=target.closest('[data-user]');if(user){const u=state.users.find(x=>x.id===Number(user.dataset.user));modal(`${modalHeader('修改角色',esc(u.name))}<form data-form="role"><input name="id" type="hidden" value="${u.id}"><div class="field"><label>系统角色</label><select name="role">${Object.entries(roleLabels).map(([code,label])=>`<option value="${code}" ${u.role===code?'selected':''}>${label}</option>`).join('')}</select></div><div class="action-row"><button class="btn">保存并记入审计</button></div></form>`);return;}
  const candidateReset=target.closest('[data-candidate-reset]');if(candidateReset){
    if(!isManaged()||state.user?.role!=='admin')throw new Error('没有重置账号权限');
    const u=state.users.find(x=>x.id===Number(candidateReset.dataset.candidateReset));if(!u)throw new Error('账号已变化，请刷新');
    modal(`${modalHeader('线下核验后重置密码',esc(u.name)+' · '+esc(u.email))}<form data-form="candidate-reset"><input type="hidden" name="id" value="${u.id}"><p class="small muted">重置会立即撤销该账号所有旧会话。一次性密码须通过可信线下渠道交付。</p><div class="field"><label>线下核验记录编号</label><input name="verificationRef" required minlength="6"></div><div class="field"><label>新的一次性密码</label><input name="temporaryPassword" type="password" autocomplete="new-password" required minlength="12"></div><div class="action-row"><button class="btn">核验并重置</button></div></form>`);return;
  }
  const candidateState=target.closest('[data-candidate-state]');if(candidateState){
    if(!isManaged()||state.user?.role!=='admin')throw new Error('没有管理账号权限');
    const u=state.users.find(x=>x.id===Number(candidateState.dataset.candidateState));if(!u)throw new Error('账号已变化，请刷新');
    if(u.account_state==='DISABLED'){
      modal(`${modalHeader('核验后启用账号',esc(u.name)+' · '+esc(u.email))}<form data-form="candidate-enable"><input type="hidden" name="id" value="${u.id}"><div class="field"><label>线下核验记录编号</label><input name="verificationRef" required minlength="6"></div><div class="action-row"><button class="btn">核验并启用</button></div></form>`);
    }else{
      if(!confirm(`确认停用 ${u.name}？该账号所有已登录会话将立即失效。`))return;
      await api(`/api/users/${u.id}/state`,'PATCH',{state:'DISABLED'});
      state.users=await api('/api/users');render();toast('账号已停用，旧会话已撤销');
    }
    return;
  }
  const demo=target.closest('[data-demo]');if(demo){if(isManaged())throw new Error('受管理环境不提供演示身份入口');const login=state.boot?.demoLogin,email=login?.accounts?.[demo.dataset.demo];if(!email||!login.password)throw new Error('演示身份暂不可用，请手动输入账号登录');const data=await api('/api/auth/login','POST',{email,password:login.password});holdGuestCartForLogin();orderAlerts.reset();damageUI.reset();state.user=data.user;state.boot.user=data.user;toast(`已进入${roleLabels[data.user.role]}演示工作台`);await navigate(defaultRoute());return;}
  const action=target.closest('[data-action]')?.dataset.action;
  if(!action)return;
  if(action==='merge-guest-cart'){
    await syncSharedCart();await loadCartQuote();render();
    if(!state.pendingGuestCart)toast('登录前的选择已与账号购物车合并');return;
  }
  if(action==='replace-guest-cart'){
    if(state.user?.role!=='customer'||!state.pendingGuestCart?.length)throw new Error('登录前清单已失效');
    const current=await api('/api/cart');
    try{
      const updated=await api('/api/cart','PUT',{expectedVersion:current.version,...(state.pendingGuestWindow||windowPayload()),items:state.pendingGuestCart});
      applySharedCart(updated);state.pendingGuestCart=null;state.pendingGuestWindow=null;state.cartMergeNotice='';
      localStorage.removeItem(guestCartKey);await loadCartQuote();render();toast('已使用登录前的装备清单');
    }catch(error){if(error.code==='CART_STALE'){applySharedCart(await api('/api/cart'));render();}throw error;}
    return;
  }
  if(action==='new-candidate-user'){
    if(!isManaged()||state.user?.role!=='admin')throw new Error('仅受管理环境权限管理员可开通账号');
    modal(`${modalHeader('开通已核验账号','管理员需先完成线下身份核验，再通过可信渠道交付初始密码。')}<form data-form="provision-user" class="form-grid"><div class="field"><label>姓名</label><input name="name" required minlength="2"></div><div class="field"><label>电子邮箱</label><input name="email" type="email" required></div><div class="field"><label>岗位</label><select name="role" required><option value="customer">顾客</option><option value="staff">门店租赁专员</option><option value="manager">门店运营经理</option><option value="contractor">装备检修技师</option><option value="owner">经营负责人</option><option value="admin">权限管理员</option></select></div><div class="field"><label>所属门店（门店岗位必填）</label><select name="storeId"><option value="">按角色或任务授权</option>${state.boot.stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div class="field wide"><label>线下核验记录编号</label><input name="verificationRef" required minlength="6" placeholder="仅填写内部编号，不输入身份证件内容"></div><div class="field wide"><label>一次性初始密码</label><input name="temporaryPassword" type="password" autocomplete="new-password" required minlength="12" placeholder="至少 12 位，线下单独交付"></div><div class="wide action-row"><button class="btn">开通账号</button></div></form>`,true);return;
  }
  if(action==='sync'){if(state.modal||state.dirtyForm)return toast('请先保存或关闭当前编辑，随后会自动更新');state.pendingSync=true;await syncData(true);return;}
  if(action==='close-modal'){closeModal();return;}
  if(action==='scroll-catalog'){document.getElementById('booking-anchor')?.scrollIntoView({behavior:'smooth'});return;}
  if(action==='search-catalog'){
    if(!canBook())throw new Error('候选环境尚无获批目录，不能查询可订库存');
    const storeId=Number($('#store-select').value),pickupDate=$('#pickup-date').value,returnDate=$('#return-date').value;
    if(!pickupDate||!returnDate)throw new Error('请先选择完整的起租和归还日期');
    if(pickupDate<earliestPickupDate())throw new Error('今日 09:00 取货时间已过，请选择之后的日期');
    if(returnDate<pickupDate)throw new Error('归还日期不能早于起租日期');
    if(returnDate>addCalendarDays(pickupDate,29))throw new Error('单笔预约最多计费 30 天');
    const start=osloIso(pickupDate,'09:00'),end=osloIso(returnDate,'16:00');
    const catalog=await api(`/api/catalog?storeId=${storeId}&pickupAt=${encodeURIComponent(start)}&returnAt=${encodeURIComponent(end)}`);
    state.storeId=storeId;state.pickupDate=pickupDate;state.returnDate=returnDate;
    state.catalog=catalog;state.bookingConfirmed=true;state.cartQuote=null;state.cartError=null;
    localStorage.setItem('bsr-store',storeId);render();
    document.getElementById('catalog-anchor')?.scrollIntoView({behavior:'smooth'});return;
  }
  if(action==='cart'){if(!canBook())throw new Error('尚无获批商品与商业政策，预约暂未开放');damageUI.consentModal();return;}
  if(action==='retry-reservation'){
    if(state.user?.role!=='customer')throw new Error('请先用原顾客账号登录');
    const entry=readSubmission('online',state.user.id);if(!entry)throw new Error('没有待确认的预约提交');
    await submitReservation(entry);return;
  }
  if(action==='create-reservation'){
    if(!state.user){toast('请先登录后提交预约');state.modal=null;await navigate('login');return;}
    if(state.user.role!=='customer')throw new Error('请使用顾客账号创建预约');
    if(!state.customerSkill)throw new Error('请先选择本次滑雪水平，门店需要据此匹配装备');
    const payload={...windowPayload(),items:state.cart,customerSkill:state.customerSkill,damageConsent:state.damageConsent};
    await submitReservation(pendingSubmission('online',state.user.id,payload));return;
  }
  if(action==='toggle-login'){if(isManaged())throw new Error('受管理环境自助注册尚未开放');state.loginMode=state.loginMode==='login'?'register':'login';render();return;}
  if(action==='logout'){await api('/api/auth/logout','POST');state.user=null;state.boot.user=null;state.orders=[];state.notifications=[];state.cart=[];state.cartVersion=null;state.cartOwnerId=null;state.pendingGuestCart=null;state.pendingGuestWindow=null;state.cartMergeNotice='';localStorage.removeItem(guestCartKey);orderAlerts.reset();damageUI.reset();fulfillmentUI.reset();state.modal=null;await navigate('login');toast(isManaged()?'已退出登录':'已退出登录，可选择其他演示身份');return;}
  if(action==='notifications'){notificationsModal();return;}
  if(action==='read-notifications'){await api('/api/notifications/read','POST',{ids:state.notifications.filter(n=>!n.read_at).map(n=>n.id)});state.notifications=await api('/api/notifications');notificationsModal();toast('当前展示的业务通知已读，未解决订单提醒仍保留');return;}
  if(action==='locate'){
    if(isManaged())throw new Error('受管理环境尚未开放定位换算');
    if(!navigator.geolocation)throw new Error('浏览器不支持定位');
    toast('正在请求定位授权…');
    navigator.geolocation.getCurrentPosition(async pos=>{try{const result=await api('/api/region','POST',{latitude:pos.coords.latitude,longitude:pos.coords.longitude});state.currency=result.currency;state.manualCurrency=false;localStorage.removeItem('bsr-currency');render();toast(`已根据 ${result.region} 推荐 ${result.currency} 参考展示币种`);}catch(e){toast(e.message,true);}},()=>toast('定位未授权或不可用，继续显示当前币种',true),{timeout:7000,maximumAge:600000});return;
  }
  if(action==='new-policy'){if(isCandidate()||isShowcase()&&!canBook())throw new Error('当前环境暂不开放价目编辑');formModal('policy');return;}
  if(action==='new-transfer'){formModal('transfer');return;}
}
async function submit(form,event){
  if(await fulfillmentUI.submit(form,event))return;
  if(await serviceUI.submit(form))return;
  if(await damageUI.submit(form,event))return;
  if(await orderAlerts.submit(form))return;
  if(await workplace.submit(form))return;
  const kind=form.dataset.form,fields=Object.fromEntries(new FormData(form));
  if(kind==='login') {const data=await api('/api/auth/login','POST',fields);if(!isShowcase())holdGuestCartForLogin();orderAlerts.reset();damageUI.reset();state.user=data.user;state.boot.user=data.user;if(isManaged()&&data.user?.mustChangePassword){toast('请先更换一次性密码');await navigate('login');return;}toast('登录成功');await navigate(defaultRoute());return;}
  if(kind==='register'){if(isManaged())throw new Error('受管理环境自助注册尚未开放');await api('/api/auth/register','POST',fields);toast('注册成功，请登录');state.loginMode='login';render();return;}
  if(kind==='change-password'){if(!isManaged()||!state.user?.mustChangePassword)throw new Error('当前无需更换一次性密码');await api('/api/auth/change-password','POST',{currentPassword:fields.currentPassword,newPassword:fields.newPassword});state.user=null;state.boot.user=null;state.modal=null;toast('密码已更换，请重新登录');await navigate('login');return;}
  if(kind==='provision-user'){if(!isManaged()||state.user?.role!=='admin')throw new Error('没有开通账号权限');await api('/api/users','POST',{name:fields.name,email:fields.email,role:fields.role,storeId:fields.storeId?Number(fields.storeId):null,temporaryPassword:fields.temporaryPassword,verificationRef:fields.verificationRef});state.users=await api('/api/users');state.modal=null;render();toast('账号已开通，请线下交付一次性密码');return;}
  if(kind==='candidate-reset'){if(!isManaged()||state.user?.role!=='admin')throw new Error('没有重置账号权限');await api(`/api/users/${Number(fields.id)}/reset-password`,'POST',{temporaryPassword:fields.temporaryPassword,verificationRef:fields.verificationRef});state.users=await api('/api/users');state.modal=null;render();toast('密码已重置，旧会话已撤销');return;}
  if(kind==='candidate-enable'){if(!isManaged()||state.user?.role!=='admin')throw new Error('没有管理账号权限');await api(`/api/users/${Number(fields.id)}/state`,'PATCH',{state:'ACTIVE',verificationRef:fields.verificationRef});state.users=await api('/api/users');state.modal=null;render();toast('账号已启用，须重新登录');return;}
  if(kind==='profile'){await api('/api/me','PATCH',fields);state.user={...state.user,...fields};toast('资料已保存');await refresh();return;}
  if(kind==='lookup'){state.lookup=await api(`/api/operations/lookup?code=${encodeURIComponent(fields.code)}`);if(state.lookup.crossStoreReturn){returnModal(state.lookup);return;}if(state.lookup.attention?.isNew){await orderAlerts.read([{id:state.lookup.id,kind:'reservation',noticeVersion:1}]);state.lookup.attention.isNew=false;}orderModal(state.lookup);return;}
  if(kind==='return'){
    const o=state.activeOrder;
    const items=o.units.filter(u=>!u.returned&&form.elements[`return-${u.unit_id}`]?.checked).map(u=>({unitId:u.unit_id,condition:fields[`condition-${u.unit_id}`],feeNok:0,note:fields[`note-${u.unit_id}`]||''}));
    const result=await api('/api/operations/return','POST',{reservationId:o.id,code:o.code,items,returnStoreId:Number(fields.returnStoreId)});toast(result.status==='ACTIVE'?`本批已验收，尚有${result.remaining}件在租`:result.status==='REVIEW'?'已登记疑似损坏，押金待照片鉴定与复核':o.crossStoreReturn?'本批已接收；结算由原订单门店办理':'全部验收完成，已自动发起演示押金退款');await refresh();return;
  }
  if(kind==='policy'){await api('/api/policies','POST',fields);toast('新价格政策版本已发布');await refresh();return;}
  if(kind==='transfer'){await api('/api/transfers','POST',fields);toast('调拨已发出，等待接收');await refresh();return;}
  if(kind==='role'){await api(`/api/users/${fields.id}/role`,'PATCH',{role:fields.role});toast('角色已更新并记录审计');await refresh();return;}
}
function notificationsModal(){modal(`${modalHeader('通知中心','新增提醒与未解决业务分别跟踪')}<div class="notification-order-summary">${orderAlerts.strip(true)}</div><div class="card-head"><h3>业务通知</h3><button class="btn secondary small" data-action="read-notifications" ${state.notifications.some(n=>!n.read_at)?'':'disabled'}>当前通知标为已读</button></div><div class="stack">${state.notifications.map(n=>`<div class="card pad"><div class="notification-meta"><b>${!n.read_at?'<i class="notification-unread" aria-label="未读"></i>':''}${esc(n.title)}</b><span class="small muted">${n.read_at?'已读':'未读'}</span></div><div class="small muted">${dateText(n.created_at)}</div><p style="margin:8px 0 0">${esc(n.body)}</p></div>`).join('')||empty('暂无其他通知','订单待办可从上方提醒入口查看','bell')}</div>`);}
function damageTaskButton(task){const c=state.damageCases.find(c=>c.maintenance_id===task.id);return c?`<div class="banner warn" style="margin:15px 0">${icon('shield')}<div>此件涉及归还损坏鉴定。维修验收入库不代表顾客费用已结清。<button class="btn secondary small" data-damage-case="${c.id}" style="margin-top:9px">上传受损照片 / 查看鉴定</button></div></div>`:'';}
const workplace=createWorkplace({state,esc,icon,nok,dateText,shortDate,pageHead,empty,api,modal,modalHeader,refresh,render,toast,storeOptions,osloIso,statusTag,orderAttention,damageTaskButton});
const orderAlerts=createOrderAlerts({state,esc,icon,api,pageHead,empty,dateText,toast,render,navigate,orderModal,
  openRepair:async id=>{await navigate('maintenance');const task=state.maintenance.find(t=>t.id===id);if(task)workplace.repairModal(task);else toast('工单已转派，请刷新提醒列表',true);}});
const damageUI=createDamageUI({state,api,esc,icon,nok,dateText,modal,modalHeader,render,toast,pageHead,empty,navigate,orderModal,cartModal,workflow:flow=>serviceUI.workflow(flow),sla:c=>serviceUI.sla(c)});
const serviceUI=createServiceUI({state,api,esc,icon,nok,dateText,modal,modalHeader,render,toast,pageHead,orderModal});
const fulfillmentUI=createFulfillmentUI({state,api,esc,icon,nok,dateText,pageHead,empty,modal,modalHeader,toast,render,refresh,storeOptions,osloIso,addCalendarDays,orderModal});
function updateSyncBadge(){const label=$('#sync-label');if(label)label.textContent=state.pendingSync?'有新更新':state.liveConnected?'实时同步':'正在重连';label?.closest('.sync-indicator')?.classList.toggle('connected',state.liveConnected);}
async function syncData(force=false){
  if(state.syncBusy||state.route==='login'||state.modal||state.dirtyForm||(!force&&(state.interacting||document.activeElement?.matches('input,textarea,select'))))return;
  state.syncBusy=true;const route=state.route;
  try{await loadRoute();state.pendingSync=false;if(route===state.route&&!state.modal)render();}
  catch(e){state.pendingSync=true;if(force)toast(e.message,true);}
  finally{state.syncBusy=false;updateSyncBadge();}
}
let liveTimer,alertTimer;
function syncOrderIndicators(announce=false){
  clearTimeout(alertTimer);alertTimer=setTimeout(()=>{if(state.route!=='login'&&orderAlerts.enabled())orderAlerts.load(announce).then(()=>orderAlerts.updateIndicators()).catch(()=>{});},200);
}
function startLiveSync(){
  createLiveUpdates({
    connected:()=>{state.liveConnected=true;updateSyncBadge();state.pendingSync=true;syncData();},
    change:()=>{state.pendingSync=true;updateSyncBadge();syncOrderIndicators(true);fulfillmentUI.syncCustomerOrder();clearTimeout(liveTimer);liveTimer=setTimeout(()=>syncData(),400);},
    offline:()=>{state.liveConnected=false;updateSyncBadge();}
  });
  window.addEventListener('focus',()=>{syncOrderIndicators();fulfillmentUI.syncCustomerOrder();syncData();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncData();});
  document.addEventListener('focusout',()=>{if(state.pendingSync)setTimeout(()=>syncData(),100);});
  setInterval(()=>{if(state.pendingSync&&!document.hidden)syncData();const el=$('[data-work-clock]');if(el)el.textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date());},1000);
  setInterval(()=>{if(!document.hidden){syncOrderIndicators();state.pendingSync=true;syncData();}},60000);
}
document.addEventListener('click',async event=>{state.interacting++;try{await act(event.target);}catch(e){toast(e.message,true);}finally{state.interacting--;}});
document.addEventListener('submit',async event=>{const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();state.interacting++;try{await submit(form,event);state.dirtyForm=false;}catch(e){toast(e.message,true);}finally{state.interacting--;}});
document.addEventListener('change',async event=>{
  if(event.target.closest('[data-form]'))state.dirtyForm=true;
  if(event.target.id==='pickup-date'||event.target.id==='return-date'||event.target.id==='store-select'){
    const selected=$('#pickup-date')?.value;if(!selected)return;
    state.pickupDate=selected;
    const ending=$('#return-date')?.value||state.returnDate;
    state.returnDate=ending<selected?addCalendarDays(selected,1):ending;
    state.storeId=Number($('#store-select')?.value||state.storeId);
    state.bookingConfirmed=false;state.cartQuote=null;state.cartError=null;render();return;
  }
  if(event.target.id==='currency-select'){state.currency=event.target.value;state.manualCurrency=true;localStorage.setItem('bsr-currency',state.currency);render();toast(`参考展示币种已切换为 ${state.currency}，正式价仍为 NOK`);}
  if(event.target.id==='only-available'){state.onlyAvailable=event.target.checked;render();}
  if(event.target.id==='catalog-subtype'){state.subtype=event.target.value;render();}
  if(event.target.id==='checkout-skill')state.customerSkill=event.target.value;
  if(event.target.id==='report-year'){
    state.reportYear=Number(event.target.value);
    try{state.reports=await api(`/api/reports?year=${state.reportYear}`);render();}
    catch(error){toast(error.message,true);}
  }
  if(event.target.id==='inventory-status'){state.inventoryStatus=event.target.value;render();}
});
document.addEventListener('input',event=>{
  if(event.target.closest('[data-form]'))state.dirtyForm=true;
  if(event.target.id==='catalog-search'){state.search=event.target.value;const pos=event.target.selectionStart;render();const input=$('#catalog-search');input?.focus();input?.setSelectionRange(pos,pos);}
  if(event.target.id==='inventory-search'){state.inventorySearch=event.target.value;const status=state.inventoryStatus,query=state.inventorySearch.toLowerCase();$('#inventory-rows').innerHTML=workplace.inventoryRows(state.inventory.filter(u=>(!status||u.status===status)&&`${u.inventory_no} ${u.name} ${u.size} ${u.store_name}`.toLowerCase().includes(query)));}
});
window.addEventListener('hashchange',()=>navigate(location.hash.slice(2)||defaultRoute()));
async function boot(){
  try{state.boot=await api('/api/bootstrap');state.user=state.boot.user;
    if(isShowcase()){state.cart=[];state.pendingGuestCart=null;state.pendingGuestWindow=null;localStorage.removeItem(guestCartKey);}
    const requested=location.hash.slice(2)||defaultRoute();await navigate(requested);
    if(!isShowcase()||canBook())startLiveSync();
  }catch(e){$('#app').innerHTML=`<div class="boot"><h2>暂时无法连接本地服务</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">重试连接</button></div>`;}
}
boot();
