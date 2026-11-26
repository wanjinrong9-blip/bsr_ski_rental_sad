import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb,hashPassword} from '../src/db.mjs';
import {getCustomerCart,putCustomerCart} from '../src/cart.mjs';
import {futureDate} from './future-date.mjs';

const dir=mkdtempSync(join(tmpdir(),'bsr-cart-019-'));
const dbs=[];
const open=(name,options={})=>{const db=openDb(join(dir,name),options);dbs.push(db);return db;};
const window={storeId:1,pickupAt:futureDate(7),returnAt:futureDate(8)};
const customer=db=>db.prepare("SELECT id,role FROM users WHERE email='customer@bsr.demo'").get();
const staff=db=>db.prepare("SELECT id,role FROM users WHERE email='staff@bsr.demo'").get();
after(()=>{for(const db of dbs.reverse())db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

test('同一顾客跨连接共享购物车，版本冲突保留胜出方，不影响库存和订单',()=>{
  const a=open('shared.sqlite'),b=open('shared.sqlite');
  const user=customer(a);
  const beforeOrders=a.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
  const beforeUnits=a.prepare("SELECT COUNT(*) AS n FROM units WHERE status='AVAILABLE'").get().n;
  assert.deepEqual(getCustomerCart(a,user).items,[]);
  assert.equal(getCustomerCart(a,user).version,0);
  const first=putCustomerCart(a,user,{expectedVersion:0,...window,items:[{variantId:1,qty:1}]});
  assert.equal(first.version,1);
  assert.equal(getCustomerCart(b,user).items[0].variantId,1);
  assert.throws(()=>putCustomerCart(b,user,{expectedVersion:0,...window,items:[{variantId:3,qty:1}]}),
    error=>error.status===409&&error.code==='CART_STALE'&&error.currentVersion===1);
  assert.equal(getCustomerCart(a,user).items[0].variantId,1);
  const next=putCustomerCart(b,user,{expectedVersion:1,...window,items:[{variantId:3,qty:2}]});
  assert.equal(next.version,2);
  assert.equal(getCustomerCart(a,user).items[0].qty,2);
  const retry=putCustomerCart(b,user,{expectedVersion:1,...window,items:[{variantId:3,qty:2}]});
  assert.equal(retry.version,2);
  assert.equal(retry.unchanged,true);
  assert.equal(a.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,beforeOrders);
  assert.equal(a.prepare("SELECT COUNT(*) AS n FROM units WHERE status='AVAILABLE'").get().n,beforeUnits);
});

test('同一账号内报价上下文变化使版本增长；无效写入回滚且不覆盖另一顾客',()=>{
  const db=open('validation.sqlite');const user=customer(db);
  const otherId=Number(db.prepare(`INSERT INTO users(name,email,password_hash,role,created_at)
    VALUES(?,?,?,'customer',?)`).run('虚构顾客','other-cart@example.test',hashPassword('Strong#Other123'),new Date().toISOString()).lastInsertRowid);
  const other={id:otherId,role:'customer'};
  const first=putCustomerCart(db,user,{expectedVersion:0,...window,items:[{variantId:1,qty:1}]});
  putCustomerCart(db,other,{expectedVersion:0,...window,items:[{variantId:2,qty:1}]});
  const revised=putCustomerCart(db,user,{expectedVersion:first.version,...window,returnAt:futureDate(9),items:[{variantId:1,qty:1}]});
  assert.equal(revised.version,2);assert.equal(revised.quoteStatus,'REQUIRES_REQUOTE');
  for(const invalid of [
    {...window,items:[{variantId:1,qty:6}]},
    {...window,items:[{variantId:1,qty:1},{variantId:1,qty:1}]},
    {...window,items:[{variantId:999999,qty:1}]},
    {...window,storeId:999999,items:[{variantId:1,qty:1}]},
    {...window,pickupAt:futureDate(-2),items:[{variantId:1,qty:1}]}
  ])assert.throws(()=>putCustomerCart(db,user,{expectedVersion:2,...invalid}));
  assert.equal(getCustomerCart(db,user).version,2);
  assert.equal(getCustomerCart(db,other).items[0].variantId,2);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('购物车拒绝匿名、员工和已停用顾客',()=>{
  const db=open('roles.sqlite');const user=customer(db);
  assert.throws(()=>getCustomerCart(db,null),error=>error.status===401);
  assert.throws(()=>putCustomerCart(db,staff(db),{expectedVersion:0,...window,items:[]}),error=>error.status===403);
  db.prepare("UPDATE users SET account_state='DISABLED' WHERE id=?").run(user.id);
  assert.throws(()=>getCustomerCart(db,user),error=>error.status===401&&error.code==='ACCOUNT_DISABLED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_carts').get().n,0);
});

test('审计落库失败时购物车与行项目一起回滚',()=>{
  const db=open('rollback.sqlite');const user=customer(db);
  db.exec(`CREATE TRIGGER fail_cart_audit BEFORE INSERT ON audit_log
    WHEN NEW.action='CART_UPDATED' BEGIN SELECT RAISE(ABORT,'injected cart audit failure'); END;`);
  assert.throws(()=>putCustomerCart(db,user,{expectedVersion:0,...window,items:[{variantId:1,qty:1}]}));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_carts').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_cart_lines').get().n,0);
  db.exec('DROP TRIGGER fail_cart_audit');
  assert.equal(putCustomerCart(db,user,{expectedVersion:0,...window,items:[{variantId:1,qty:1}]}).version,1);
});

test('旧演示库重复初始化只补表，不改历史订单；候选初始化无演示种子',()=>{
  const db=open('migration.sqlite');
  const original=db.prepare('SELECT id,quote_json FROM reservations ORDER BY id').all();
  db.exec('DROP TABLE customer_cart_lines; DROP TABLE customer_carts;');
  db.close();dbs.pop();
  const reopened=open('migration.sqlite');
  assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE name='customer_carts'").get());
  assert.deepEqual(reopened.prepare('SELECT id,quote_json FROM reservations ORDER BY id').all(),original);
  const again=open('migration.sqlite');
  assert.deepEqual(again.prepare('SELECT id,quote_json FROM reservations ORDER BY id').all(),original);
  const candidate=open('candidate.sqlite',{runMode:'candidate',initialize:true});
  assert.equal(candidate.prepare('SELECT COUNT(*) AS n FROM customer_carts').get().n,0);
  assert.equal(candidate.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
  assert.equal(candidate.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
