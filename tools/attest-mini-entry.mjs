import {createHash,createHmac} from 'node:crypto';
import {readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isInsidePath} from '../src/startup-config.mjs';
import {validateMiniCodeImage} from '../src/mini-entry.mjs';

// This signs a local operator approval and image digest. It cannot establish
// that WeChat issued the image; the operator must inspect platform provenance
// and complete real-phone acceptance separately before setting READY.
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const projectReal=realpathSync.native(root);
const env=process.env;
if(env.BSR_RUN_MODE!=='showcase'||env.BSR_MINI_CODE_PLATFORM_REVIEWED!=='1')
  throw new Error('须在 SHOWCASE 中完成平台来源人工核对后，才可签署本地图片');
const appId=env.BSR_MINI_APP_ID,qrFile=env.BSR_MINI_RELEASE_QR_FILE;
const receiptFile=env.BSR_MINI_RELEASE_RECEIPT_FILE,key=env.BSR_MINI_RELEASE_ATTEST_KEY;
if(typeof appId!=='string'||!/^wx[A-Za-z0-9]{16}$/.test(appId)||
    appId!==env.BSR_WECHAT_APP_ID||typeof key!=='string'||!/^([a-f0-9]{64}|[a-f0-9]{128})$/i.test(key))
  throw new Error('AppID 或私有签署密钥配置无效');
if(typeof qrFile!=='string'||!isAbsolute(qrFile)||
    typeof receiptFile!=='string'||!isAbsolute(receiptFile))
  throw new Error('码与凭据须使用私有绝对路径');
if(isInsidePath(root,resolve(qrFile))||isInsidePath(root,resolve(receiptFile)))
  throw new Error('码与凭据须存放在项目目录之外');
const realImage=realpathSync.native(qrFile),imageStat=statSync(realImage);
const receiptParent=realpathSync.native(dirname(receiptFile));
if(!imageStat.isFile()||imageStat.size<100||imageStat.size>2*1024*1024||
    isInsidePath(projectReal,realImage)||isInsidePath(projectReal,receiptParent)||
    resolve(realImage)===resolve(receiptFile))
  throw new Error('码与凭据不能位于公开目录或超出尺寸');
const bytes=readFileSync(realImage);
validateMiniCodeImage(bytes);
const approvedAt=new Date();
const payload={version:1,source:'operator-attested',appId,
  page:'pages/catalog/index',scene:'home',
  imageSha256:createHash('sha256').update(bytes).digest('hex'),
  approvedAt:approvedAt.toISOString(),
  expiresAt:new Date(approvedAt.getTime()+90*86400000).toISOString()};
const mac=createHmac('sha256',Buffer.from(key,'hex'))
  .update(JSON.stringify(payload)).digest('hex');
const receipt=JSON.stringify({...payload,mac})+'\n';
// Do not silently overwrite a previous approval. Use a new receipt path for
// each image/version; a partial write cannot pass the loader's MAC check.
writeFileSync(receiptFile,receipt,{encoding:'utf8',mode:0o600,flag:'wx'});
process.stdout.write('已保存本地图片完整性与人工批准凭据；真实微信签发和手机扫码仍待独立验收。\n');
