import {parentPort,workerData} from 'node:worker_threads';
import {initializeCandidate} from '../src/runtime-provenance.mjs';

parentPort.postMessage({ready:true});
const start=new Int32Array(workerData.start);
Atomics.wait(start,0,0);
try{
  const result=initializeCandidate({runMode:'candidate',dbPath:workerData.path},workerData.admin);
  parentPort.postMessage({ok:true,status:result.status});
}catch(error){
  parentPort.postMessage({ok:false,code:error.code||error.name});
}
