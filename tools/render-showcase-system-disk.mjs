import {randomBytes} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync,
  rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isInsidePath} from '../src/startup-config.mjs';

// Offline configuration only: no network, database access or service commands.
const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const templates = join(repo, 'deploy', 'aliyun');
const files = Object.freeze({
  'showcase-system-disk.env': 'showcase-system-disk.env.template',
  'proxy-secret-showcase.conf': 'proxy-secret-showcase.conf.template',
  'nginx-showcase.conf': 'nginx-showcase.conf.template'
});

function fail(message) { throw new Error(message); }

function parse(args) {
  const [command, ...rest] = args;
  if (!['render', 'check'].includes(command) || rest.length !== 4)
    fail('用法：render|check --domain bsrski.cn --output-dir 私有绝对路径');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!['--domain', '--output-dir'].includes(key) || options[key] || !value)
      fail('参数无效或重复');
    options[key] = value;
  }
  const domain = options['--domain'];
  if (typeof domain !== 'string' || domain.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*bsrski\.cn$/.test(domain))
    fail('域名须为 bsrski.cn 或其合法小写子域名，不带协议、端口或路径');
  const output = options['--output-dir'];
  if (!output || !isAbsolute(output)) fail('输出目录须使用私有绝对路径');
  return {command, domain, output: resolve(output)};
}

function privateTarget(output) {
  if (isInsidePath(repo, output)) fail('输出目录不能位于应用仓库内');
  // Require an existing parent, and resolve its links before writing anything.
  const parent = realpathSync(dirname(output));
  if (!lstatSync(parent).isDirectory() || isInsidePath(repo, parent))
    fail('输出父目录无效或链接回应用仓库');
  return output;
}

function content(domain, secret) {
  const result = {};
  for (const [name, template] of Object.entries(files)) {
    const text = readFileSync(join(templates, template), 'utf8')
      .replaceAll('__SHOWCASE_DOMAIN__', domain)
      .replaceAll('__SHOWCASE_PROXY_SECRET__', secret)
      .replace(/\r\n/g, '\n');
    if (/__[A-Z0-9_]+__/.test(text)) fail('部署模板含未替换的占位符');
    result[name] = text;
  }
  return result;
}

function readPrivateBundle(output) {
  const info = lstatSync(output);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      isInsidePath(repo, realpathSync(output))) fail('配置目录无效');
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700)
    fail('私有配置目录权限须为 0700');
  if (readdirSync(output).sort().join('|') !== Object.keys(files).sort().join('|'))
    fail('配置文件清单不完整或包含额外文件');
  const result = {};
  for (const name of Object.keys(files)) {
    const path = join(output, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600))
      fail('配置文件类型、大小或私有权限无效');
    result[name] = readFileSync(path, 'utf8');
  }
  return result;
}

function check(output, domain) {
  const bundle = readPrivateBundle(output);
  const matches = [...bundle['showcase-system-disk.env']
    .matchAll(/^BSR_PROXY_SECRET=([a-f0-9]{64})$/gm)];
  if (matches.length !== 1 || /^(.)\1+$/.test(matches[0][1]))
    fail('代理密钥缺失、重复或格式无效');
  const expected = content(domain, matches[0][1]);
  for (const name of Object.keys(files)) {
    if (bundle[name] !== expected[name])
      fail('配置与受审模板不一致：请检查域名、密钥、路径与入口开关');
  }
}

function render(output, domain) {
  // One secret for this bundle; candidate and other bundles remain separate.
  const bundle = content(domain, randomBytes(32).toString('hex'));
  // mkdir without recursive cannot replace an existing directory or link.
  mkdirSync(output, {mode: 0o700});
  const written = [];
  try {
    for (const [name, text] of Object.entries(bundle)) {
      const path = join(output, name);
      const fd = openSync(path, 'wx', 0o600);
      written.push(path);
      try { writeFileSync(fd, text, {encoding: 'utf8'}); }
      finally { closeSync(fd); }
    }
    check(output, domain);
  } catch (error) {
    // Remove only files created by this invocation; never recursively delete.
    for (const path of written.reverse()) {
      try { unlinkSync(path); } catch {}
    }
    try { rmdirSync(output); } catch {}
    throw error;
  }
}

try {
  const {command, domain, output} = parse(process.argv.slice(2));
  privateTarget(output);
  if (command === 'render') render(output, domain);
  else check(output, domain);
  process.stdout.write(command === 'render'
    ? '已生成并校验私有配置；未部署、启用服务或开放端口。\n'
    : '私有配置一致性校验通过；不代表目标机语法或容量验收。\n');
  if (process.platform === 'win32')
    process.stdout.write('Windows 文件访问权限需操作员核验；目标 Ubuntu 仍须核验权限。\n');
} catch {
  // Do not echo OS paths, file contents, secrets or thrown upstream details.
  process.stderr.write('部署配置生成或检查失败：请核对参数、私有目录、文件权限与配置一致性。\n');
  process.exitCode = 1;
}
