import {closeSync, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync,
  unlinkSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isInsidePath} from '../src/startup-config.mjs';
import {createWechatMiniCodeAdapter} from '../src/wechat-platform.mjs';

const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));

/** Private setup only. No database, website-entry, consent or release mutation. */
export async function obtainPrivateMiniCode(env, options = {}) {
  if (env.BSR_RUN_MODE !== 'showcase' || env.BSR_MINI_CODE_FETCH_CONFIRMED !== '1' ||
      env.BSR_MINI_APP_ID !== env.BSR_WECHAT_APP_ID)
    throw new Error('须在私有 SHOWCASE 环境明确批准取码并核对同一 AppID');
  const output = env.BSR_MINI_CODE_OUTPUT_DIR;
  if (typeof output !== 'string' || !isAbsolute(output) || isInsidePath(repo, output))
    throw new Error('码文件须保存在仓库外全新私有绝对目录');
  const parent = realpathSync(dirname(output));
  if (!lstatSync(parent).isDirectory() || isInsidePath(repo, parent))
    throw new Error('输出目录不能链接到应用仓库');
  let exists = false;
  try { lstatSync(output); exists = true; }
  catch (caught) { if (caught.code !== 'ENOENT') throw new Error('无法核对输出目录'); }
  if (exists) throw new Error('不得覆盖已有目录或文件');
  const adapter = createWechatMiniCodeAdapter({appId: env.BSR_WECHAT_APP_ID,
    appSecret: env.BSR_WECHAT_APP_SECRET}, options);
  // Fetch and validate before creating anything. A failed platform response
  // never changes the current code, receipt or website state.
  const result = await adapter.obtainMiniCode();
  mkdirSync(output, {mode: 0o700});
  const written = [];
  try {
    for (const [name, bytes] of [['code.png', result.bytes],
      ['issuance.json', JSON.stringify(result.provenance, null, 2) + '\n']]) {
      const path = join(output, name), fd = openSync(path, 'wx', 0o600);
      written.push(path);
      try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    }
  } catch {
    for (const path of written.reverse()) { try { unlinkSync(path); } catch {} }
    try { rmdirSync(output); } catch {}
    throw new Error('私有码文件写入失败，现有发布配置未改变');
  }
  // This local record is not an independently signed proof from WeChat.
  return result.provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('参数无效');
    await obtainPrivateMiniCode(process.env);
    process.stdout.write('已保存私有码与无密钥的获取记录；网页入口未启用，仍需平台来源复核和手机验收。\n');
  } catch {
    // Never print the secret, request URL containing a token, raw platform
    // response, OS path or stack to the terminal.
    process.stderr.write('小程序码获取失败；请在私有环境核对配置、发布资格与新输出目录。\n');
    process.exitCode = 1;
  }
}
