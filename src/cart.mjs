import {audit} from './db.mjs';
import {DomainError,normalizeWindow,transaction} from './domain.mjs';

function reject(message,status=400,code='INVALID_CART'){
  const error=new DomainError(message,status);
  error.code=code;
  throw error;
}

function customerId(db,user){
  const id=Number(user?.id);
  if(!Number.isSafeInteger(id)||id<1)reject('请先登录',401,'UNAUTHORIZED');
  const account=db.prepare('SELECT id,role,account_state FROM users WHERE id=?').get(id);
  if(!account||account.account_state!=='ACTIVE')reject('账号不可用',401,'ACCOUNT_DISABLED');
  if(account.role!=='customer')reject('仅顾客可使用购物车',403,'FORBIDDEN');
  return id;
}

function read(db,id){
  const row=db.prepare('SELECT * FROM customer_carts WHERE customer_id=?').get(id);
  if(!row)return {version:0,storeId:null,pickupAt:null,returnAt:null,items:[],updatedAt:null,quoteStatus:'REQUIRES_REQUOTE'};
  const items=db.prepare(`SELECT l.variant_id AS variantId,l.qty,v.name,v.category,v.size,v.style,v.active
    FROM customer_cart_lines l JOIN variants v ON v.id=l.variant_id
    WHERE l.cart_id=? ORDER BY l.variant_id`).all(row.id);
  return {version:row.version,storeId:row.store_id,pickupAt:row.pickup_at,returnAt:row.return_at,
    items,updatedAt:row.updated_at,quoteStatus:'REQUIRES_REQUOTE'};
}

export function getCustomerCart(db,user){return read(db,customerId(db,user));}

function validateInput(input){
  if(!input||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)
    reject('购物车版本无效');
  const storeId=input.storeId;
  if(!Number.isSafeInteger(storeId)||storeId<1)reject('请选择有效取货门店');
  const window=normalizeWindow(input.pickupAt,input.returnAt);
  const raw=input.items??input.lines;
  if(!Array.isArray(raw)||raw.length>12)reject('购物车最多可选 12 种装备');
  const seen=new Set(),items=[];
  for(const line of raw){
    const variantId=line?.variantId,qty=line?.qty;
    if(!Number.isSafeInteger(variantId)||variantId<1||!Number.isSafeInteger(qty)||qty<1||qty>5)
      reject('每种装备的数量需为 1–5 件');
    if(seen.has(variantId))reject('购物车不能重复提交同一规格');
    seen.add(variantId);items.push({variantId,qty});
  }
  items.sort((a,b)=>a.variantId-b.variantId);
  return {expectedVersion:input.expectedVersion,storeId,...window,items};
}

function sameCart(current,next){
  return current.storeId===next.storeId&&current.pickupAt===next.pickupAt&&
    current.returnAt===next.returnAt&&current.items.length===next.items.length&&
    current.items.every((line,index)=>line.variantId===next.items[index].variantId&&line.qty===next.items[index].qty);
}

/** Stores a proposal only. Quote, consent and physical allocation remain separate server operations. */
export function putCustomerCart(db,user,input){
  const desired=validateInput(input);
  return transaction(db,()=>{
    const id=customerId(db,user);
    if(!db.prepare('SELECT id FROM stores WHERE id=?').get(desired.storeId))
      reject('请选择有效取货门店');
    for(const item of desired.items){
      if(!db.prepare('SELECT id FROM variants WHERE id=? AND active=1').get(item.variantId))
        reject('购物车包含不存在或已停用的装备',409,'CART_ITEM_UNAVAILABLE');
    }
    const current=read(db,id);
    if(current.version!==desired.expectedVersion){
      if(sameCart(current,desired))return {...current,unchanged:true};
      const error=new DomainError('购物车已在另一端更新，请刷新后重试',409);
      error.code='CART_STALE';error.currentVersion=current.version;
      throw error;
    }
    if(sameCart(current,desired))return {...current,unchanged:true};
    const updatedAt=new Date().toISOString();
    const existing=db.prepare('SELECT id FROM customer_carts WHERE customer_id=?').get(id);
    const cartId=existing?.id??Number(db.prepare(`INSERT INTO customer_carts
      (customer_id,store_id,pickup_at,return_at,version,updated_at) VALUES(?,?,?,?,1,?)`)
      .run(id,desired.storeId,desired.pickupAt,desired.returnAt,updatedAt).lastInsertRowid);
    if(existing){
      db.prepare(`UPDATE customer_carts SET store_id=?,pickup_at=?,return_at=?,version=version+1,updated_at=?
        WHERE id=?`).run(desired.storeId,desired.pickupAt,desired.returnAt,updatedAt,cartId);
      db.prepare('DELETE FROM customer_cart_lines WHERE cart_id=?').run(cartId);
    }
    const insert=db.prepare(`INSERT INTO customer_cart_lines(cart_id,variant_id,qty,updated_at) VALUES(?,?,?,?)`);
    for(const item of desired.items)insert.run(cartId,item.variantId,item.qty,updatedAt);
    audit(db,id,'CART_UPDATED','customer_cart',cartId,
      {version:current.version+1,storeId:desired.storeId,itemCount:desired.items.length});
    return {...read(db,id),unchanged:false};
  });
}
