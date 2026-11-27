import test from 'node:test';
import assert from 'node:assert/strict';
import {publicReleaseInfo} from '../src/release-info.mjs';
import {miniExperienceStatus} from '../public/mini-experience.js';

test('experience member access is reported independently of backend configuration and official code',()=>{
  const info=publicReleaseInfo();
  assert.equal(info.requirementsBaseline,'4.14');
  assert.equal(info.miniExperience.access,'MEMBERS_ENABLED');
  assert.equal(info.miniBackend.configured,false);
  assert.equal(info.officialMiniEntry.status,'off');
  assert.equal(Object.hasOwn(info,'qrUrl'),false);
  const ui=miniExperienceStatus(info);
  assert.equal(ui.enabled,true);assert.match(ui.label,/体验成员/);
  assert.match(ui.connection,/真实微信身份绑定尚未启用/);
  assert.doesNotMatch(JSON.stringify(info),/wxid|teacher|AppSecret|password|email|qrUrl/i);
});
test('configured backend does not turn on official scan; state inputs cannot inject UI content',()=>{
  const info=publicReleaseInfo({miniBackendEnabled:true,officialEntryStatus:'<script>secret</script>'});
  assert.equal(info.miniBackend.configured,true);assert.equal(info.officialMiniEntry.status,'off');
  const ui=miniExperienceStatus(info);assert.match(ui.connection,/已启用/);
  assert.doesNotMatch(JSON.stringify(ui),/<script|secret/);
  assert.equal(publicReleaseInfo({miniBackendEnabled:'true'}).miniBackend.configured,false);
});
