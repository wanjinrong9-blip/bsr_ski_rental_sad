import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync,
  writeFileSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createWechatMiniCodeAdapter} from '../src/wechat-platform.mjs';
import {obtainPrivateMiniCode} from '../tools/fetch-mini-code.mjs';

const previousEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
after(() => {
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;
});
const config = {appId: 'wx1234567890abcdef', appSecret: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'};
const token = 'synthetic-private-platform-token-123456789';
// Layout fixture only: this image is not a WeChat-issued code.
const image = readFileSync(new URL('../mini-program/assets/bsr-logo.png', import.meta.url));
const json = data => new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});
const fake = () => {
  let calls = 0;
  return {fetchImpl: async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (++calls === 1) {
      assert.equal(url, 'https://api.weixin.qq.com/cgi-bin/stable_token');
      assert.deepEqual(JSON.parse(options.body), {grant_type: 'client_credential',
        appid: config.appId, secret: config.appSecret});
      return json({access_token: token, expires_in: 7200});
    }
    assert.equal(calls, 2);
    const endpoint = new URL(url);
    assert.equal(endpoint.origin + endpoint.pathname, 'https://api.weixin.qq.com/wxa/getwxacodeunlimit');
    assert.equal(endpoint.searchParams.get('access_token'), token);
    assert.deepEqual(JSON.parse(options.body), {page: 'pages/catalog/index', scene: 'home',
      check_path: true, env_version: 'release', width: 430});
    return new Response(image, {headers: {'content-type': 'image/png'}});
  }, calls: () => calls};
};

test('official-code adapter uses fixed release endpoints and returns no platform secret or token', async () => {
  const network = fake();
  const result = await createWechatMiniCodeAdapter(config, network).obtainMiniCode();
  assert.equal(network.calls(), 2);
  assert.deepEqual(result.bytes, image);
  assert.equal(result.provenance.appId, config.appId);
  assert.equal(result.provenance.envVersion, 'release');
  assert.equal(result.provenance.imageSha256, createHash('sha256').update(image).digest('hex'));
  assert.ok(!JSON.stringify(result.provenance).includes(token));
  assert.ok(!JSON.stringify(result.provenance).includes(config.appSecret));
});

test('code acquisition rejects platform JSON errors, redirects, oversize and corrupt images without details', async () => {
  for (const bad of [json({errcode: 45009, errmsg: config.appSecret + token}),
    new Response('redirect', {status: 302}),
    new Response('x', {headers: {'content-length': String(2 * 1024 * 1024 + 1)}}),
    new Response(Buffer.alloc(2 * 1024 * 1024 + 1)),
    new Response(image.subarray(0, 80)),
    new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {headers: {'content-type': 'image/jpeg'}})]) {
    let calls = 0;
    const adapter = createWechatMiniCodeAdapter(config, {fetchImpl: async () =>
      ++calls === 1 ? json({access_token: token, expires_in: 7200}) : bad});
    await assert.rejects(adapter.obtainMiniCode(), error => {
      assert.equal(error.code, 'WECHAT_CODE_UNAVAILABLE');
      assert.ok(!String(error).includes(config.appSecret));
      assert.ok(!String(error).includes(token));
      return true;
    });
    assert.equal(calls, 2);
  }
});

test('invalid token response and timeout stop without retry or credential leakage', async () => {
  let calls = 0;
  const adapter = createWechatMiniCodeAdapter(config, {fetchImpl: async () => {
    calls++;
    return json({errcode: 40013, errmsg: config.appSecret});
  }});
  await assert.rejects(adapter.obtainMiniCode(), error => error.code === 'WECHAT_CODE_UNAVAILABLE');
  assert.equal(calls, 1);
  const timeout = createWechatMiniCodeAdapter(config, {timeoutMs: 25,
    fetchImpl: (_url, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error(token)), {once: true});
    })});
  await assert.rejects(timeout.obtainMiniCode(), error =>
    error.code === 'WECHAT_CODE_UNAVAILABLE' && !String(error).includes(token));
});

test('test network injection cannot be configured in production', () => {
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createWechatMiniCodeAdapter(config, fake()), error =>
      error.code === 'WECHAT_TEST_ADAPTER_FORBIDDEN');
  } finally { process.env.NODE_ENV = 'test'; }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bsr-code-fetch-'));
  t.after(() => {
    const actual = realpathSync(root);
    assert.match(relative(realpathSync(tmpdir()), actual), /^bsr-code-fetch-[^\\/]+$/);
    rmSync(actual, {recursive: true, force: true});
  });
  const output = join(root, 'new-code');
  return {root, output, env: {BSR_RUN_MODE: 'showcase', BSR_MINI_CODE_FETCH_CONFIRMED: '1',
    BSR_WECHAT_APP_ID: config.appId, BSR_MINI_APP_ID: config.appId,
    BSR_WECHAT_APP_SECRET: config.appSecret, BSR_MINI_CODE_OUTPUT_DIR: output}};
}

test('private setup writes image and public provenance only, without enabling the site', async t => {
  const f = fixture(t), network = fake();
  await obtainPrivateMiniCode(f.env, network);
  assert.deepEqual(readdirSync(f.output).sort(), ['code.png', 'issuance.json']);
  assert.deepEqual(readFileSync(join(f.output, 'code.png')), image);
  const manifest = readFileSync(join(f.output, 'issuance.json'), 'utf8');
  assert.ok(!manifest.includes(token) && !manifest.includes(config.appSecret));
  assert.equal(f.env.BSR_MINI_ENTRY_STATE, undefined);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.output).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.output, 'code.png')).mode & 0o777, 0o600);
  }
});

test('missing approval, AppID mismatch, repository paths and existing output fail before network', async t => {
  const f = fixture(t);
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  mkdirSync(f.output);
  writeFileSync(join(f.output, 'keep'), 'untouched');
  let calls = 0;
  for (const env of [f.env, {...f.env, BSR_RUN_MODE: 'demo'},
    {...f.env, BSR_MINI_CODE_FETCH_CONFIRMED: '0'},
    {...f.env, BSR_MINI_APP_ID: 'wx0000000000000000'},
    {...f.env, BSR_MINI_CODE_OUTPUT_DIR: join(repo, 'private-do-not-create')}]) {
    await assert.rejects(obtainPrivateMiniCode(env, {fetchImpl: async () => { calls++; }}));
  }
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(f.output, 'keep'), 'utf8'), 'untouched');
});

test('platform failure leaves no output bundle', async t => {
  const f = fixture(t);
  await assert.rejects(obtainPrivateMiniCode(f.env, {fetchImpl: async () => json({errcode: 40013})}));
  assert.deepEqual(readdirSync(f.root), []);
});
