import {DatabaseSync} from 'node:sqlite';
import {hashPassword} from '../src/db.mjs';

export function identityFixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE runtime_installation(
      singleton_id INTEGER PRIMARY KEY,run_mode TEXT NOT NULL,instance_id TEXT NOT NULL,init_state TEXT NOT NULL
    );
    CREATE TABLE stores(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
      role TEXT NOT NULL,store_id INTEGER REFERENCES stores(id),created_at TEXT NOT NULL,
      account_state TEXT NOT NULL DEFAULT 'ACTIVE',provisioning_method TEXT,verified_at TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,auth_epoch INTEGER NOT NULL DEFAULT 1,
      phone TEXT DEFAULT '',address TEXT DEFAULT '',birth_year INTEGER,height_cm INTEGER,weight_kg INTEGER,shoe_size TEXT
    );
    CREATE TABLE sessions(
      token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL,
      issued_at TEXT,auth_epoch INTEGER NOT NULL DEFAULT 1,revoked_at TEXT
    );
    CREATE TABLE auth_attempt_buckets(
      dimension TEXT NOT NULL CHECK(dimension IN ('ACCOUNT','SOURCE')),key_hash TEXT NOT NULL,window_started_at TEXT NOT NULL,
      failed_count INTEGER NOT NULL DEFAULT 0,blocked_until TEXT,PRIMARY KEY(dimension,key_hash)
    );
    CREATE TABLE audit_log(
      id INTEGER PRIMARY KEY,actor_id INTEGER,action TEXT NOT NULL,target_type TEXT NOT NULL,
      target_id INTEGER,detail_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO runtime_installation(singleton_id,run_mode,instance_id,init_state) VALUES(1,'CANDIDATE','candidate-test-instance','READY')").run();
  db.prepare("INSERT INTO stores(id,name) VALUES(1,'North'),(2,'South')").run();
  const now='2026-11-16T00:00:00.000Z';
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,store_id,created_at,provisioning_method,verified_at) VALUES(1,'Admin','admin@example.test',?,'admin',NULL,?,'OFFLINE_ADMIN',?)")
    .run(hashPassword('StrongAdmin123!'),now,now);
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,store_id,created_at,provisioning_method,verified_at) VALUES(2,'Staff','staff@example.test',?,'staff',1,?,'OFFLINE_ADMIN',?)")
    .run(hashPassword('StrongStaff123!'),now,now);
  return db;
}

export function fakeRequest(cookie='',origin='https://127.0.0.1:4174',source='127.0.0.1'){
  return {headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{})},socket:{remoteAddress:source}};
}
export const requestCookie=header=>header.split(';')[0];
