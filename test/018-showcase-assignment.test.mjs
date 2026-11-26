import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.mjs';
import {reportFault} from '../src/maintenance.mjs';
import {candidateProvisionAccount} from '../src/identity.mjs';
import {validateRuntimeConfig} from '../src/runtime-config.mjs';
import {initializeShowcase} from '../src/runtime-provenance.mjs';
import {makeShowcaseFixture} from './018-showcase-fixtures.mjs';

const root=resolve(import.meta.dirname,'..');
test('SHOWCASE 故障任务仅自动分派到同店或跨店授权技师',async()=>{
  const fixture=await makeShowcaseFixture();
  try{
    const config=validateRuntimeConfig(fixture.env,{root,publicDir:join(root,'public')});
    initializeShowcase(config,{operator:'018-assignment-test',name:'虚构管理员',
      email:'assignment-admin@example.test',password:'Private#Assignment2026'});
    const db=openDb(fixture.dbPath,{runMode:'showcase'});
    try{
      const admin=db.prepare("SELECT * FROM users WHERE role='admin'").get();
      const staffId=candidateProvisionAccount(db,admin,{name:'虚构南店店员',
        email:'assignment-staff@example.test',role:'staff',storeId:2,
        temporaryPassword:'Private#AssignmentStaff2026',verificationRef:'FICTIONAL-STAFF'},
      {runMode:'showcase'}).id;
      const northTechId=candidateProvisionAccount(db,admin,{name:'虚构北店技师',
        email:'assignment-north-tech@example.test',role:'contractor',storeId:1,
        temporaryPassword:'Private#AssignmentTech2026',verificationRef:'FICTIONAL-TECH'},
      {runMode:'showcase'}).id;
      const staff=db.prepare('SELECT * FROM users WHERE id=?').get(staffId);
      const units=db.prepare("SELECT id FROM units WHERE store_id=2 AND status='AVAILABLE' ORDER BY id LIMIT 2").all();
      assert.equal(units.length,2);
      assert.throws(()=>reportFault(db,staff,{unitId:units[0].id,
        issue:'虚构固定器松动',contractorId:northTechId},true),
        error=>error?.status===400||error?.status===403);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM maintenance').get().n,0);
      assert.equal(db.prepare('SELECT status FROM units WHERE id=?').get(units[0].id).status,'AVAILABLE');
      const unassigned=reportFault(db,staff,{unitId:units[0].id,
        issue:'虚构固定器松动'},true);
      assert.equal(db.prepare('SELECT contractor_id FROM maintenance WHERE id=?').get(unassigned.id).contractor_id,null);
      const southTechId=candidateProvisionAccount(db,admin,{name:'虚构南店技师',
        email:'assignment-south-tech@example.test',role:'contractor',storeId:2,
        temporaryPassword:'Private#AssignmentSouth2026',verificationRef:'FICTIONAL-SOUTH'},
      {runMode:'showcase'}).id;
      const assigned=reportFault(db,staff,{unitId:units[1].id,
        issue:'虚构板底检查'},true);
      assert.equal(db.prepare('SELECT contractor_id FROM maintenance WHERE id=?').get(assigned.id).contractor_id,
        southTechId);
    }finally{db.close();}
  }finally{fixture.cleanup();}
});
