export function createOrderAlerts(ctx){
  const {state,esc,icon,api,pageHead,empty,dateText,toast,render}=ctx;
  const enabled=()=>!!state.user&&state.user.role!=='customer';
  const counts=()=>state.orderAlerts?.counts||{new:0,unresolved:0,urgent:0};
  const marker=(count,label)=>count?`<span class="order-alert-mark" role="img" aria-label="${esc(label)} ${count} 笔" title="${esc(label)} ${count} 笔">!</span>`:'';
  const indicator=(key,label)=>`<span class="order-alert-indicator" data-order-indicator="${key}" data-indicator-label="${esc(label)}">${marker(counts()[key],label)}</span>`;
  let inflight=null;
  async function load(announce=false){
    if(!enabled()){state.orderAlerts=null;return;}
    const userId=state.user.id,key=`${userId}:${state.alertView}:${state.alertPage}:${state.alertSearch}`;
    if(inflight?.key===key)return inflight.promise;
    const previous=state.orderAlerts;
    const promise=api(`/api/order-alerts?${new URLSearchParams({view:state.alertView,page:state.alertPage,search:state.alertSearch})}`).then(data=>{
      if(state.user?.id!==userId||key!==`${state.user.id}:${state.alertView}:${state.alertPage}:${state.alertSearch}`)return;
      state.orderAlerts=data;state.alertPage=data.page;
      if(announce&&previous&&data.counts.new>previous.counts.new)toast(`收到 ${data.counts.new-previous.counts.new} 笔新增${data.kind==='maintenance'?'维修工单':'订单'}，请查看订单提醒`);
    }).finally(()=>{if(inflight?.key===key)inflight=null;});
    inflight={key,promise};return promise;
  }
  function strip(includeOnCenter=false){
    if(!enabled()||(!includeOnCenter&&state.route==='order-alerts'))return '';
    const c=counts();
    return `<div class="order-alert-strip"><div class="alert-strip-title">${icon('bell')}<b>订单提醒</b><span>${state.user.role==='contractor'?'仅本人维修工单':'业务待办实时更新'}</span></div><div class="alert-strip-actions"><button data-alert-view="new">${marker(c.new,'新增待阅')}新增订单 <b>${c.new}</b></button><button data-alert-view="unresolved">${marker(c.unresolved,'未解决订单')}未解决订单 <b>${c.unresolved}</b></button><button class="alert-strip-link" data-alert-view="unresolved">查看全部 ${icon('chevron')}</button></div></div>`;
  }
  function updateIndicators(){
    if(!enabled())return;
    for(const el of document.querySelectorAll('[data-order-indicator]'))el.innerHTML=marker(counts()[el.dataset.orderIndicator],el.dataset.indicatorLabel);
    const slot=document.getElementById('order-alert-strip');if(slot)slot.innerHTML=strip();
  }
  const entryPayload=item=>({id:item.id,noticeVersion:item.noticeVersion});
  async function read(items){
    const visible=items.filter(Boolean);if(!visible.length)return;
    await api('/api/order-alerts/read','POST',{kind:state.user.role==='contractor'?'maintenance':'reservation',entries:visible.map(entryPayload)});
    await load();updateIndicators();
    for(const order of state.orders)if(visible.some(r=>r.kind==='reservation'&&r.id===order.id)&&order.attention)order.attention.isNew=false;
  }
  function page(){
    const data=state.orderAlerts;if(!data)return empty('正在读取订单提醒','请稍候','bell');
    if(data.kind==='summary'){
      const c=data.counts;
      return `${pageHead('OPERATIONS OVERVIEW','订单提醒汇总','按门店与状态查看未闭环业务；此岗位不展示顾客身份、订单号或单笔详情。')}
        <div class="order-alert-metrics">${[['new','新增待阅',c.new],['unresolved','未解决订单',c.unresolved],['urgent','优先关注',c.urgent]].map(([key,label,count])=>`<div class="alert-metric"><div><span>${label}</span>${marker(count,label)}</div><strong>${count}<small> 笔</small></strong></div>`).join('')}</div>
        <section class="card order-alert-register"><div class="alert-register-head"><div><div class="kicker">STORE STATUS</div><h2>门店业务状态</h2></div><button class="btn secondary small" data-alert-read-summary ${c.new?'':'disabled'}>汇总新增标为已阅</button></div>
        <div class="alert-record-list">${data.byStoreStatus.map(group=>`<article class="alert-record"><div class="alert-record-symbol">${icon('clipboard')}</div><div class="alert-record-content"><div class="alert-record-heading"><b>${esc(group.storeName)}</b><span class="tag">${esc(group.statusLabel)}</span></div><p>未闭环 ${group.count} 笔 · 新增待阅 ${group.new} 笔 · 优先关注 ${group.urgent} 笔</p></div></article>`).join('')||empty('暂无未闭环订单','门店出现待办后，汇总会自动更新。','check')}</div></section>`;
    }
    const c=data.counts,repair=data.kind==='maintenance';
    const cards=[['new','新增订单',c.new,repair?'新分配、安排更新或退回待查看':'尚未查看的新增待阅订单'],['unresolved','未解决订单',c.unresolved,repair?'尚未验收入库或报废的本人任务':'待支付、取货、归还或复核，尚未闭环'],['urgent','优先关注',c.urgent,repair?'已逾期或标为紧急的维修工单':'逾期归还、超时取货或押金待复核']];
    return `${pageHead('ORDER ATTENTION','订单提醒中心',repair?'只展示分配给你的维修工单；不开放顾客身份、取货码与支付信息。':'先看新增，再处理未闭环事项。查看提醒与完成订单是两件事。')}
      <div class="order-alert-metrics">${cards.map(([key,label,count,note])=>`<button class="alert-metric ${state.alertView===key?'selected':''}" data-alert-view="${key}" aria-pressed="${state.alertView===key}"><div><span>${label}</span>${marker(count,label)}</div><strong>${count}<small> 笔</small></strong><p>${note}</p>${icon(key==='new'?'bell':key==='urgent'?'clock':'clipboard')}</button>`).join('')}</div>
      <section class="card order-alert-register"><div class="alert-register-head"><div><div class="kicker">${repair?'MY MAINTENANCE ORDERS':'WORK QUEUE'}</div><h2>${{new:'新增待阅',unresolved:'未解决订单',urgent:'优先关注'}[state.alertView]} <span>${data.total} 笔</span></h2></div><div class="alert-register-tools"><form data-form="alert-search"><input class="input" name="query" value="${esc(state.alertSearch)}" aria-label="搜索订单提醒" maxlength="100" placeholder="${repair?'工单号 / 装备 / 门店':'订单号 / 顾客 / 门店'}"><button class="btn secondary small" aria-label="搜索提醒">${icon('search')}</button></form><button class="btn secondary small" data-alert-read-page ${data.items.some(r=>r.isNew)?'':'disabled'}>本页新增标为已读</button></div></div>
      <div class="alert-queue-tabs" role="group" aria-label="提醒类型">${cards.map(([key,label,count])=>`<button class="${state.alertView===key?'active':''}" data-alert-view="${key}" aria-pressed="${state.alertView===key}">${label}<span>${count}</span></button>`).join('')}</div>
      <div class="alert-record-list">${data.items.map(r=>`<article class="alert-record ${r.isNew?'is-new':''} ${r.urgent?'is-urgent':''}" data-alert-record="${r.id}"><div class="alert-record-symbol">${icon(repair?'wrench':'clipboard')}</div><div class="alert-record-content"><div class="alert-record-heading"><b>${esc(r.code)}</b>${r.isNew?'<span class="alert-new-label">新增待阅</span>':''}<span class="tag ${r.urgent?'warn':''}">${esc(r.statusLabel)}</span>${marker(1,r.reason)}</div><p>${esc(r.reason)}</p><div class="alert-record-meta"><span>${esc(r.storeName)}</span>${r.customerName?`<span>${esc(r.customerName)}</span>`:''}${r.equipment?`<span>${esc(r.equipment)}</span>`:''}<span>${r.status==='HOLD'?'暂留截止':repair?'计划完成':r.status==='ACTIVE'?'约定归还':'约定取货'} ${dateText(r.dueAt)}</span><span>创建 ${dateText(r.createdAt)}</span></div>${repair?`<div class="alert-record-issue">${esc(r.summary)}</div>`:''}</div><div class="alert-record-actions"><button class="btn ${r.urgent?'':'secondary'} small" data-alert-open="${r.id}">${repair?'处理工单':['staff','manager'].includes(state.user.role)?'查看并处理':'查看订单'} ${icon('arrow')}</button>${r.isNew?`<button class="alert-read-button" data-alert-read="${r.id}">标为已读</button>`:'<span class="alert-read-label">已读 · 业务待闭环</span>'}</div></article>`).join('')||empty(state.alertSearch?'没有匹配的提醒':state.alertView==='new'?'新增提醒已读完':state.alertView==='urgent'?'暂无优先关注事项':'当前没有未解决订单',state.alertSearch?'可调整搜索词，或切换其他提醒类型。':'业务状态变化后会自动更新；标为已读不会关闭订单。','check')}</div>
      <div class="alert-pagination"><span>共 ${data.total} 笔 · 每页 ${data.pageSize} 笔</span><div><button class="btn secondary small" data-alert-page="${data.page-1}" ${data.page===1?'disabled':''}>上一页</button><b>${data.page} / ${data.pages}</b><button class="btn secondary small" data-alert-page="${data.page+1}" ${data.page===data.pages?'disabled':''}>下一页</button></div></div></section>
      <div class="alert-explainer">${icon('info')}<p><b>提醒不等于异常。</b>${repair?'“未解决”包括等待经理验收的工单；验收通过或报废后自动移出。':'“未解决”指尚未完成的业务，正常租赁中的订单也会列入；已完成、已取消和失效暂留自动移出。'}已读状态按账号保存，刷新或重新登录仍然保留；不会替其他同事消除提醒。</p></div>`;
  }
  async function act(target){
    if(!enabled())return false;
    const summary=target.closest('[data-alert-read-summary]');if(summary){await api('/api/order-alerts/read','POST',{kind:'summary'});await load();render();toast('汇总新增已标为已阅，未解决业务仍保留');return true;}
    const view=target.closest('[data-alert-view]');if(view){state.alertView=view.dataset.alertView;state.alertPage=1;await ctx.navigate('order-alerts');return true;}
    const pagination=target.closest('[data-alert-page]');if(pagination){state.alertPage=Number(pagination.dataset.alertPage);await ctx.navigate('order-alerts');return true;}
    const bulk=target.closest('[data-alert-read-page]');if(bulk){await read(state.orderAlerts.items.filter(r=>r.isNew));render();toast('本页新增已标为已读，未解决业务仍保留');return true;}
    const one=target.closest('[data-alert-read]');if(one){await read([state.orderAlerts.items.find(r=>r.id===Number(one.dataset.alertRead))]);render();toast('已读；业务完成后将自动移出未解决队列');return true;}
    const open=target.closest('[data-alert-open]');if(open){
      const record=state.orderAlerts.items.find(r=>r.id===Number(open.dataset.alertOpen));if(!record)return true;
      if(record.kind==='maintenance'){
        await read([record]);await ctx.openRepair(record.id);
      }else{
        const order=await api(`/api/reservations/${record.id}`);if(record.isNew){await read([record]);order.attention.isNew=false;}
        ctx.orderModal(order);
      }
      return true;
    }
    return false;
  }
  async function submit(form){if(form.dataset.form!=='alert-search')return false;state.alertSearch=String(new FormData(form).get('query')||'').trim();state.alertPage=1;await ctx.navigate('order-alerts');return true;}
  function reset(){state.orderAlerts=null;state.alertView='unresolved';state.alertPage=1;state.alertSearch='';}
  return {enabled,load,strip,indicator,marker,page,act,submit,read,updateIndicators,reset};
}
