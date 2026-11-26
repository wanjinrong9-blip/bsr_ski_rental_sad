import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(repo, 'tools', 'render-showcase-system-disk.mjs');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bsr-deploy-render-'));
  t.after(() => {
    const base = realpathSync(tmpdir());
    const actual = realpathSync(root);
    const offset = relative(base, actual);
    assert.match(offset, /^bsr-deploy-render-[^\\/]+$/);
    rmSync(actual, { recursive: true, force: true });
  });
  return root;
}

function call(...args) {
  return spawnSync(process.execPath, [tool, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 10000
  });
}

test('renders and checks one private single-disk bundle without printing its secret', t => {
  const root = fixture(t);
  const bundle = join(root, 'private');
  const created = call('render', '--domain', 'preview.bsrski.cn', '--output-dir', bundle);
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(readdirSync(bundle).sort(), [
    'nginx-showcase.conf', 'proxy-secret-showcase.conf', 'showcase-system-disk.env'
  ]);
  const env = readFileSync(join(bundle, 'showcase-system-disk.env'), 'utf8');
  const proxy = readFileSync(join(bundle, 'proxy-secret-showcase.conf'), 'utf8');
  const nginx = readFileSync(join(bundle, 'nginx-showcase.conf'), 'utf8');
  const envSecret = /^BSR_PROXY_SECRET=([a-f0-9]{64})$/m.exec(env)?.[1];
  const proxySecret = /proxy_set_header X-BSR-Proxy-Secret "([a-f0-9]{64})";/m.exec(proxy)?.[1];
  assert.ok(envSecret && envSecret === proxySecret);
  assert.ok(!created.stdout.includes(envSecret));
  assert.ok(!created.stderr.includes(envSecret));
  assert.ok(!/__[-A-Z0-9]+__/.test(env + proxy + nginx));
  assert.match(env, /^BSR_PUBLIC_ORIGIN=https:\/\/preview\.bsrski\.cn$/m);
  assert.match(env, /^BSR_DB_PATH=\/var\/lib\/bsr\/data\/showcase\.sqlite$/m);
  assert.match(env, /^BSR_MINI_ENTRY_STATE=OFF$/m);
  assert.match(nginx, /^\s*server_name preview\.bsrski\.cn;$/m);
  assert.doesNotMatch(env + nginx, /Demo123!|\/srv\/bsr|data\/bsr\.sqlite/);
  const checked = call('check', '--domain', 'preview.bsrski.cn', '--output-dir', bundle);
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(!checked.stdout.includes(envSecret));
  if (process.platform !== 'win32') {
    assert.equal(statSync(bundle).mode & 0o777, 0o700);
    for (const name of readdirSync(bundle))
      assert.equal(statSync(join(bundle, name)).mode & 0o777, 0o600);
  }
});

test('rejects unapproved or malformed domains before creating output', t => {
  const root = fixture(t);
  for (const [index, domain] of [
    'localhost', '127.0.0.1', 'https://bsrski.cn', '*.bsrski.cn',
    'bsrski.cn.attacker.example', 'bsrski.cn/path', 'example.invalid'
  ].entries()) {
    const bundle = join(root, `bad-${index}`);
    const result = call('render', '--domain', domain, '--output-dir', bundle);
    assert.notEqual(result.status, 0);
    assert.ok(!readdirSync(root).includes(`bad-${index}`));
  }
});

test('never overwrites an existing bundle or writes inside the repository', t => {
  const root = fixture(t);
  const bundle = join(root, 'existing');
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'sentinel'), 'untouched');
  const existing = call('render', '--domain', 'bsrski.cn', '--output-dir', bundle);
  assert.notEqual(existing.status, 0);
  assert.equal(readFileSync(join(bundle, 'sentinel'), 'utf8'), 'untouched');

  const inRepo = call('render', '--domain', 'bsrski.cn', '--output-dir',
    join(repo, 'private-do-not-create'));
  assert.notEqual(inRepo.status, 0);
});

test('checker rejects secret mismatch and leftover placeholders without echoing them', t => {
  const root = fixture(t);
  const bundle = join(root, 'private');
  assert.equal(call('render', '--domain', 'bsrski.cn', '--output-dir', bundle).status, 0);
  const envPath = join(bundle, 'showcase-system-disk.env');
  const original = readFileSync(envPath, 'utf8');
  const secret = /^BSR_PROXY_SECRET=([a-f0-9]{64})$/m.exec(original)?.[1];
  writeFileSync(envPath, original.replace(secret, 'a'.repeat(64)));
  const mismatch = call('check', '--domain', 'bsrski.cn', '--output-dir', bundle);
  assert.notEqual(mismatch.status, 0);
  assert.ok(!mismatch.stdout.includes(secret));
  assert.ok(!mismatch.stderr.includes(secret));

  writeFileSync(envPath, original.replace(secret, '__SHOWCASE_PROXY_SECRET__'));
  const placeholder = call('check', '--domain', 'bsrski.cn', '--output-dir', bundle);
  assert.notEqual(placeholder.status, 0);
  assert.ok(!placeholder.stdout.includes(secret));
  assert.ok(!placeholder.stderr.includes(secret));
});

test('checker refuses a public listener, demo data path, enabled Mini entry and changed proxy', t => {
  const root = fixture(t), bundle = join(root, 'private');
  assert.equal(call('render', '--domain', 'bsrski.cn', '--output-dir', bundle).status, 0);
  const envPath = join(bundle, 'showcase-system-disk.env');
  const original = readFileSync(envPath, 'utf8');
  const secret = /^BSR_PROXY_SECRET=([a-f0-9]{64})$/m.exec(original)[1];
  for (const changed of [
    original.replace('HOST=127.0.0.1', 'HOST=0.0.0.0'),
    original.replace('/var/lib/bsr/data/showcase.sqlite', '/opt/bsr/app/data/bsr.sqlite'),
    original.replace('BSR_MINI_ENTRY_STATE=OFF', 'BSR_MINI_ENTRY_STATE=READY')
  ]) {
    writeFileSync(envPath, changed);
    const result = call('check', '--domain', 'bsrski.cn', '--output-dir', bundle);
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  writeFileSync(envPath, original);
  const nginxPath = join(bundle, 'nginx-showcase.conf');
  writeFileSync(nginxPath, readFileSync(nginxPath, 'utf8').replace('127.0.0.1:4175', '127.0.0.1:4173'));
  assert.notEqual(call('check', '--domain', 'bsrski.cn', '--output-dir', bundle).status, 0);
});

test('directory links cannot redirect generation into the repository or alias a bundle', t => {
  const root = fixture(t), repoLink = join(root, 'repo-link');
  symlinkSync(repo, repoLink, 'junction');
  const result = call('render', '--domain', 'bsrski.cn', '--output-dir',
    join(repoLink, 'private-do-not-create'));
  assert.notEqual(result.status, 0);
  assert.ok(!readdirSync(repo).includes('private-do-not-create'));
  const bundle = join(root, 'private');
  assert.equal(call('render', '--domain', 'bsrski.cn', '--output-dir', bundle).status, 0);
  const bundleLink = join(root, 'bundle-link');
  symlinkSync(bundle, bundleLink, 'junction');
  assert.notEqual(call('check', '--domain', 'bsrski.cn', '--output-dir', bundleLink).status, 0);
});
