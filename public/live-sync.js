export function createLiveUpdates({connected,change,offline}){
  let worker=null,events=null,attached=false,fallback=false;
  function receive(type,data){if(type==='connected')connected(data);else if(type==='change')change(data);else offline();}
  function fallbackConnect(){
    if(events||document.hidden)return;
    events=new EventSource('/api/events');
    events.addEventListener('connected',event=>receive('connected',JSON.parse(event.data)));
    events.addEventListener('change',event=>receive('change',JSON.parse(event.data)));
    events.onerror=()=>offline();
  }
  function fallbackVisibility(){
    if(!fallback)return;
    if(document.hidden){events?.close();events=null;offline();}else fallbackConnect();
  }
  function attach(){
    if(attached)return;attached=true;
    if('SharedWorker' in window){
      try{
        worker=new SharedWorker('/live-sync-worker.js',{name:'bsr-live-sync-v1'});
        worker.port.onmessage=event=>receive(event.data.type,event.data.data);worker.port.start();
        worker.onerror=()=>{worker.port.close();worker=null;fallback=true;fallbackConnect();};
        return;
      }catch{worker=null;}
    }
    // Browsers without SharedWorker keep a stream only while this tab is visible.
    fallback=true;fallbackConnect();
  }
  function detach(){attached=false;worker?.port.postMessage({type:'detach'});worker?.port.close();worker=null;events?.close();events=null;}
  window.addEventListener('pagehide',detach);
  window.addEventListener('pageshow',event=>{if(event.persisted)attach();});
  document.addEventListener('visibilitychange',fallbackVisibility);
  attach();return {close:detach};
}
