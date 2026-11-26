import {realpathSync} from 'node:fs';
import {basename,dirname,resolve,sep} from 'node:path';

// The current application contains demo accounts and simulated payments.
// Keep this runtime on the local machine until a separate hosted mode exists.
export function isInsidePath(parent,candidate){
  const normalize=value=>{
    const path=resolve(value);
    return process.platform==='win32'?path.toLowerCase():path;
  };
  const root=normalize(parent),target=normalize(candidate);
  return target===root||target.startsWith(root.endsWith(sep)?root:root+sep);
}

function canonicalizeProspectivePath(path){
  let current=resolve(path);
  const missing=[];
  for(;;){
    try{return resolve(realpathSync.native(current),...missing.reverse());}
    catch(error){
      if(!['ENOENT','ENOTDIR'].includes(error?.code))throw error;
      const parent=dirname(current);
      if(parent===current)throw error;
      missing.push(basename(current));
      current=parent;
    }
  }
}

export function validatePreviewConfig({host,port,dbPath,publicDir}){
  const requestedHost=String(host??'127.0.0.1');
  const safeHost=requestedHost.toLowerCase();
  if(!['127.0.0.1','::1','localhost'].includes(safeHost))
    throw new Error('本地演示只能监听 127.0.0.1、::1 或 localhost；当前配置禁止对外开放');

  const portText=String(port??4173);
  if(!/^\d+$/.test(portText)||!Number.isSafeInteger(Number(portText))||Number(portText)<1||Number(portText)>65535)
    throw new Error('PORT 必须是 1–65535 的整数');

  if(typeof dbPath!=='string'||!dbPath.trim()||typeof publicDir!=='string'||!publicDir.trim())
    throw new Error('数据库路径与公开资源目录必须明确指定');
  const databasePath=resolve(dbPath),publicPath=resolve(publicDir);
  const publicReal=realpathSync.native(publicPath);
  const projectReal=realpathSync.native(dirname(publicPath));
  if(!isInsidePath(projectReal,publicReal))
    throw new Error('公开资源目录不能链接到项目目录之外');
  if(isInsidePath(publicPath,databasePath)||isInsidePath(publicReal,canonicalizeProspectivePath(databasePath)))
    throw new Error('BSR_DB_PATH 不能指向公开资源目录或其链接目标');

  return {host:safeHost,port:Number(portText),dbPath:databasePath};
}
