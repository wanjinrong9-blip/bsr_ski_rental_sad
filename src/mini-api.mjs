import {DomainError} from './domain.mjs';
import {randomBytes} from 'node:crypto';
import {availability,cancelReservation,createReservation,normalizeWindow,
  payReservation,policyFor,quote,quoteFingerprint} from './domain.mjs';
import {getCustomerCart,putCustomerCart} from './cart.mjs';
import {depositFor,depositRule} from './catalog-upgrade.mjs';
import {damagePolicy} from './damage-policy.mjs';
import {orderWorkflow} from './order-workflow.mjs';
import {contracts,issueContract,preparation,signContract} from './fulfillment.mjs';
import {damageOrder,damagePhoto,submitCustomerDamageDispute} from './damage.mjs';
import {simulated} from './simulation.mjs';
import {rentalPolicy} from './rental-policy.mjs';
import {saveCustomerProfile} from './master-data.mjs';
import {publicReleaseInfo} from './release-info.mjs';
import {createWechatCodeSessionAdapter,WechatPlatformError} from './wechat-platform.mjs';
import {bindMiniCustomer,claimMiniCodeExchange,logoutMiniSession,miniSessionUser,unbindMiniCustomer,
  wechatMiniLogin} from './mini-identity.mjs';

const deny=(code,message,status)=>{const error=new DomainError(message,status);error.code=code;throw error;};
const publicUser=user=>({id:user.id,name:user.name,email:user.email,role:'customer',
  storeId:user.store_id,phone:user.phone||'',address:user.address||'',
  birthYear:user.birth_year??null,heightCm:user.height_cm??null,
  weightKg:user.weight_kg??null,shoeSize:user.shoe_size||''});

/** A separate Bearer boundary. The enclosing HTTP server checks its trusted proxy first. */
export function createMiniApi({db,runMode,env=process.env,adapter=null,orderDetail=null}={}){
  if(adapter&&process.env.NODE_ENV!=='test')
    deny('WECHAT_TEST_ADAPTER_FORBIDDEN','微信测试适配器只允许隔离测试使用',503);
  const configured=runMode==='showcase'&&env.BSR_WECHAT_MINI_ENABLED==='1';
  const appId=configured?env.BSR_WECHAT_APP_ID:null;
  const openidKey=configured?env.BSR_WECHAT_OPENID_KEY:null;
  if(configured&&(!/^wx[A-Za-z0-9]{16}$/.test(String(appId||''))||
      typeof openidKey!=='string'||openidKey.length<32||
      /^(.)\1+$/.test(openidKey)||(!env.BSR_WECHAT_APP_SECRET&&!adapter)))
    deny('MINI_CONFIG_INVALID','小程序身份配置不完整',503);
  const platform=configured?(adapter??createWechatCodeSessionAdapter({
    appId,appSecret:env.BSR_WECHAT_APP_SECRET})):null;
  const enabled=Boolean(configured&&appId&&openidKey&&platform);
  function cartInput(actor,version){
    const cart=getCustomerCart(db,actor);
    if(!Number.isSafeInteger(version)||version!==cart.version){
      const error=new DomainError('购物车已更新，请刷新后重新报价',409);
      error.code='CART_STALE';error.currentVersion=cart.version;throw error;
    }
    if(!cart.items.length)deny('CART_EMPTY','请先选择装备',422);
    return {cart,input:{storeId:cart.storeId,pickupAt:cart.pickupAt,
      returnAt:cart.returnAt,items:cart.items.map(({variantId,qty})=>({variantId,qty}))}};
  }
  function ownOrder(actor,id){
    const row=db.prepare('SELECT * FROM reservations WHERE id=? AND user_id=?').get(id,actor.id);
    if(!row)deny('ORDER_NOT_FOUND','订单不存在',404);
    return row;
  }
  function detail(actor,id){
    ownOrder(actor,id);
    if(orderDetail)return orderDetail(id,actor);
    const row=db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
    const lines=db.prepare('SELECT * FROM reservation_items WHERE reservation_id=? ORDER BY id').all(id);
    const quote=JSON.parse(row.quote_json);delete row.quote_json;
    return simulated({...row,lines,quote,workflow:orderWorkflow(db,actor,row),
      preparation:preparation(db,actor,id),damage:damageOrder(db,actor,id),
      payments:db.prepare(`SELECT id,type,amount_nok,status,provider_ref,created_at
        FROM payments WHERE reservation_id=? ORDER BY id`).all(id).map(simulated),
      contracts:contracts(db,actor,id)});
  }

  async function handle(req,res,url,{body,json}){
    const path=url.pathname,method=req.method;
    if(!path.startsWith('/api/mini/'))return false;
    if(path==='/api/mini/bootstrap'&&method==='GET'){
      const bootAuth=req.headers.authorization;
      const bootToken=typeof bootAuth==='string'&&/^Bearer [a-f0-9]{64}$/.test(bootAuth)?
        bootAuth.slice(7):null;
      const bootUser=enabled&&bootToken?miniSessionUser(db,bootToken):null;
      json(res,200,{status:enabled?'ready':'off',synthetic:runMode==='showcase',
        releaseInfo:publicReleaseInfo({miniBackendEnabled:enabled}),
        customerOnly:true,currency:'NOK',bookingEnabled:enabled,loginEnabled:enabled,
        stores:enabled?db.prepare('SELECT * FROM stores ORDER BY id').all():[],
        damagePolicy:enabled?damagePolicy:null,
        depositRule:enabled?depositRule:null,rentalPolicy:enabled?rentalPolicy:null,
        user:bootUser?publicUser(bootUser):null});
      return true;
    }
    if(!enabled)deny('MINI_NOT_READY','微信小程序身份服务尚未开放',503);
    const auth=req.headers.authorization;
    const bearer=typeof auth==='string'&&/^Bearer [a-f0-9]{64}$/.test(auth)?auth.slice(7):null;
    const actor=bearer?miniSessionUser(db,bearer):null;
    if(path==='/api/mini/auth/wechat'&&method==='POST'){
      if(auth)deny('FORBIDDEN','登录请求不能附带既有身份',403);
      try{
        const loginInput=await body(req,4096);
        claimMiniCodeExchange(db,{openidKey,
          source:req.bsrClientIp||req.socket?.remoteAddress||'unknown'});
        json(res,200,await wechatMiniLogin(db,loginInput,
          {adapter:platform,appId,openidKey}));
      }catch(error){
        if(error instanceof WechatPlatformError)deny(error.code,error.message,error.status);
        throw error;
      }
      return true;
    }
    if(path==='/api/mini/auth/bind'&&method==='POST'){
      if(auth)deny('FORBIDDEN','绑定请求不能附带既有身份',403);
      json(res,200,bindMiniCustomer(db,await body(req,4096),{appId,openidKey,
        source:req.bsrClientIp||req.socket?.remoteAddress||'unknown'}));
      return true;
    }
    if(!actor)deny('SESSION_EXPIRED','请重新登录小程序',401);
    if(path==='/api/mini/me'&&method==='GET'){
      json(res,200,publicUser(actor));return true;
    }
    if(path==='/api/mini/me'&&method==='PATCH'){
      saveCustomerProfile(db,actor,await body(req,100000));
      json(res,200,publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(actor.id)));
      return true;
    }
    if(path==='/api/mini/auth/logout'&&method==='POST'){
      json(res,200,logoutMiniSession(db,bearer));return true;
    }
    if(path==='/api/mini/auth/unbind'&&method==='POST'){
      json(res,200,unbindMiniCustomer(db,actor,bearer,await body(req,4096)));return true;
    }
    if(path==='/api/mini/catalog'&&method==='GET'){
      const storeId=Number(url.searchParams.get('storeId'));
      if(!Number.isSafeInteger(storeId)||!db.prepare('SELECT id FROM stores WHERE id=?').get(storeId))
        deny('STORE_INVALID','请选择有效取货门店',400);
      const window=normalizeWindow(url.searchParams.get('pickupAt'),url.searchParams.get('returnAt'));
      const remaining=availability(db,storeId,window.pickupAt,window.returnAt);
      const items=db.prepare('SELECT * FROM variants WHERE active=1 ORDER BY category,id').all()
        .map(variant=>{
          const policy=policyFor(db,variant.id,storeId,window.pickupAt);
          return {...variant,variantId:variant.id,availableCount:remaining.get(variant.id)||0,
            dailyNok:policy?.daily_nok??null,
            depositNok:policy?depositFor(variant,policy.daily_nok):null,
            depositRate:depositRule.rate,depositBasis:depositRule.basis,
            policyVersion:policy?.version??null};
        });
      json(res,200,simulated({storeId,...window,items,currency:'NOK'}));return true;
    }
    if(path==='/api/mini/cart'&&method==='GET'){
      json(res,200,getCustomerCart(db,actor));return true;
    }
    if(path==='/api/mini/cart'&&method==='PUT'){
      json(res,200,putCustomerCart(db,actor,await body(req,100000)));return true;
    }
    if(path==='/api/mini/quote'&&method==='POST'){
      const input=await body(req,4096),{cart,input:orderInput}=cartInput(actor,input.cartVersion);
      const quoted=quote(db,orderInput),quoteId=randomBytes(16).toString('hex');
      db.prepare(`INSERT INTO mini_quotes
        (quote_id,customer_id,cart_version,fingerprint,cart_json,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(quoteId,actor.id,cart.version,quoteFingerprint(quoted),
          JSON.stringify(orderInput),quoted.expiresAt,new Date().toISOString());
      json(res,200,{...quoted,quoteId,cartVersion:cart.version,damagePolicyVersion:damagePolicy.version});
      return true;
    }
    if(path==='/api/mini/reservations'&&method==='POST'){
      const input=await body(req,100000),receipt=db.prepare(`SELECT * FROM mini_quotes
        WHERE quote_id=? AND customer_id=?`).get(String(input.quoteId||''),actor.id);
      if(!receipt)deny('QUOTE_EXPIRED','报价无效，请重新报价',409);
      const requestKey=req.headers['idempotency-key'];
      const prior=typeof requestKey==='string'?db.prepare(`SELECT reservation_id FROM reservation_requests
        WHERE actor_id=? AND channel='ONLINE' AND request_key=?`).get(actor.id,requestKey):null;
      if(!prior&&Date.parse(receipt.expires_at)<=Date.now())
        deny('QUOTE_EXPIRED','报价已过期，请重新报价',409);
      if(input.cartVersion!==receipt.cart_version)
        deny('CART_STALE','购物车与报价版本不同，请重新报价',409);
      if(!prior)cartInput(actor,receipt.cart_version);
      const orderInput={...JSON.parse(receipt.cart_json),customerSkill:input.customerSkill,
        customerProfile:input.customerProfile,damageConsent:input.damageConsent,
        expectedQuoteFingerprint:receipt.fingerprint,miniQuoteId:receipt.quote_id};
      const created=createReservation(db,actor.id,orderInput,null,requestKey);
      json(res,created.replayed?200:201,simulated(created));return true;
    }
    if(path==='/api/mini/reservations'&&method==='GET'){
      const ids=db.prepare('SELECT id FROM reservations WHERE user_id=? ORDER BY id DESC LIMIT 150').all(actor.id);
      json(res,200,ids.map(row=>detail(actor,row.id)));return true;
    }
    const photoPath=path.match(/^\/api\/mini\/damage-photos\/(\d+)$/);
    if(photoPath&&method==='GET'){
      const photo=damagePhoto(db,actor,Number(photoPath[1]));
      res.writeHead(200,{'content-type':photo.mime,'content-length':photo.image.length,
        'cache-control':'private, no-store','x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; sandbox"});
      res.end(Buffer.from(photo.image));return true;
    }
    const reservation=path.match(/^\/api\/mini\/reservations\/(\d+)(?:\/(cancel|contracts|pay|damage\/dispute))?$/);
    if(reservation){
      const id=Number(reservation[1]),action=reservation[2];
      ownOrder(actor,id);
      if(!action&&method==='GET'){json(res,200,detail(actor,id));return true;}
      if(action==='damage/dispute'&&method==='POST'){
        json(res,200,simulated(submitCustomerDamageDispute(db,actor,id,await body(req,12000))));return true;
      }
      if(action==='cancel'&&method==='POST'){
        const row=ownOrder(actor,id);
        json(res,200,simulated(row.status==='CANCELLED'?{id,status:'CANCELLED',
          feeNok:row.cancellation_fee_nok,refundNok:row.refund_nok}:
          cancelReservation(db,actor.id,id)));return true;
      }
      if(action==='contracts'&&method==='GET'){
        json(res,200,contracts(db,actor,id));return true;
      }
      if(action==='contracts'&&method==='POST'){
        json(res,201,simulated(issueContract(db,actor,id)));return true;
      }
      if(action==='pay'&&method==='POST'){
        json(res,200,simulated(payReservation(db,actor.id,id)));return true;
      }
    }
    const signing=path.match(/^\/api\/mini\/contracts\/(\d+)\/sign$/);
    if(signing&&method==='POST'){
      json(res,200,simulated(signContract(db,actor,Number(signing[1]),await body(req,100000))));
      return true;
    }
    deny('MINI_ROUTE_UNKNOWN','小程序接口不存在',404);
  }
  return Object.freeze({handle,enabled});
}
