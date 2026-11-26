// One metadata-only SSE connection per origin, shared by all role tabs.
// No session credentials, customer records or order bodies cross this channel.
const ports=new Set();let events=null,lastConnected=null;
function publish(type,data){for(const port of ports){try{port.postMessage({type,data});}catch{ports.delete(port);}}}
function connect(){
  if(events)return;
  events=new EventSource('/api/events');
  events.addEventListener('connected',event=>{lastConnected=JSON.parse(event.data);publish('connected',lastConnected);});
  events.addEventListener('change',event=>publish('change',JSON.parse(event.data)));
  events.onerror=()=>{lastConnected=null;publish('offline',null);};
}
onconnect=event=>{
  const port=event.ports[0];ports.add(port);port.start();
  port.onmessage=message=>{
    if(message.data?.type!=='detach')return;
    ports.delete(port);port.close();
    if(!ports.size){events?.close();events=null;lastConnected=null;}
  };
  if(lastConnected)port.postMessage({type:'connected',data:lastConnected});
  connect();
};
