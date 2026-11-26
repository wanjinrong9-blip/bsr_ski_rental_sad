export const jobs={
 customer:{name:'自助租赁顾客',scope:'选择装备、预约与付款，查看本人订单、照片鉴定、押金和补差进度。',limit:'只能查看本人业务，不操作库存或核定损坏费用。'},
 staff:{name:'门店租赁专员',scope:'核码交付、逐件归还验收、核对技师照片与资料、联系顾客及登记核实补差。',limit:'可提交门店复核，不替代技师鉴定或经理核价。'},
 manager:{name:'门店运营经理',scope:'管理每日排班、库存调拨与价目，复核损坏鉴定、核定押金结算，验收维修及跟进超时。',limit:'核价须基于照片、鉴定和店员复核；不能跳过证据或重复收款。'},
 contractor:{name:'装备检修技师',scope:'处理分配给本人的维修与受损鉴定，24H内反馈初步受损程度、上传照片并记录成本。',limit:'只看本人任务，不查看顾客联系方式或自行批准扣款。'},
 owner:{name:'跨店运营总监',scope:'面向公司经营决策，查看各门店订单、营收、库存利用及损坏结算汇总，评估扩店与资源配置。',limit:'不是前台店员；当前系统中只读分析，不执行交付、退款或维修验收。'},
 admin:{name:'平台运维与权限管理员',scope:'维护账号、岗位权限及审计记录，协助排查平台运行问题。',limit:'不是业务经理；不核定损坏费用、不操作押金结算，报表仅提供演示只读视图。'}
};
export function createServiceUI(ctx){
 const{state,esc,icon,dateText,api,modal,modalHeader,pageHead,toast}=ctx;
 let reviewVersion=null;
 function workflow(flow){if(!flow)return '';return `<section class="responsibility-flow"><div class="current-responsibility"><div><span>当前进度</span><b>${esc(flow.current)}</b></div><div><span>当前处理人</span><b>${esc(flow.handler?.name||'待分派')}</b></div></div><details><summary>查看每一步进度与处理人</summary><ol>${flow.steps.map(s=>`<li class="flow-${s.status.toLowerCase()}"><i>${s.status==='DONE'?'✓':s.status==='SKIPPED'?'—':'·'}</i><div><b>${esc(s.label)}</b><span>${s.status==='SKIPPED'?'无需此步骤':esc(s.handler?.name||'待分派')}</span><small>${s.at?dateText(s.at):s.dueAt?'反馈截止 '+dateText(s.dueAt):{CURRENT:'正在处理 / 待执行',WAITING:'等待前序步骤',SKIPPED:'',DONE:'已完成'}[s.status]}</small></div></li>`).join('')}</ol></details></section>`;}
 function sla(c){if(!c.sla?.dueAt)return '';const done=!!c.sla.firstFeedbackAt;return `<div class="assessment-sla ${c.sla.overdue||c.sla.late?'overdue':''}">${icon('clock')}<div><b>受损程度检验 · 24H内反馈</b><span>负责人：${esc(c.assessor_name||'待指派技师')} · 截止 ${dateText(c.sla.dueAt)}</span><small>${done?'已于 '+dateText(c.sla.firstFeedbackAt)+'反馈初评'+(c.sla.late?'（超时）':''):c.sla.overdue?'已超时，门店经理需立即跟进':'自疑似受损归还建单起计时；反馈初步受损程度，不等同24小时维修完工。'}</small></div></div>`;}
 function rolesPage(){return `${pageHead('ROLES & RESPONSIBILITIES','岗位职责与处理边界','“跨店运营总监”负责经营决策，“平台运维与权限管理员”负责系统账号与运行；两者都不是门店核价经理。')}<div class="job-grid">${Object.entries(jobs).map(([role,job])=>`<article class="card job-card ${state.user?.role===role?'mine':''}"><div>${icon(role==='contractor'?'wrench':role==='admin'?'shield':role==='owner'?'chart':'users')}<span>${state.user?.role===role?'当前岗位':'岗位说明'}</span></div><h2>${job.name}</h2><p>${job.scope}</p><div><b>权限边界</b><p>${job.limit}</p></div></article>`).join('')}</div>`;}
 async function act(target){const open=target.closest('[data-staff-review]');if(!open)return false;const o=await api(`/api/reservations/${open.dataset.staffReview}`),ready=o.damage.cases.length&&o.damage.cases.every(c=>['SUBMITTED','APPROVED'].includes(c.status));
  reviewVersion=o.staffReviewVersion;
  modal(`${modalHeader('店员复核 · 提交经理核价',`${esc(o.code)} · 当前操作人 ${esc(state.user.name)}`)}${workflow(o.workflow)}<div class="banner ${ready?'':'warn'}">${icon('info')}<div>${ready?'请核对归还实物、顾客合同及技师照片资料。此操作只提交门店复核，不扣款、不退款。':'尚有受损件未提交照片或初步鉴定。请等待负责人在24小时内反馈；不能跳过证据直接结算。'}</div></div><form data-form="staff-review"><input name="id" type="hidden" value="${o.id}">${[['identity','已核对顾客与订单 / 合同信息'],['items','已核对实物归还、单件编号及数量'],['evidence','已核对照片对应部位、技师受损等级与费用依据']].map(([key,label])=>`<label class="damage-check"><input type="checkbox" name="${key}" required ${ready?'':'disabled'}><span>${label}</span></label>`).join('')}<div class="field"><label>门店复核说明（顾客可见）</label><textarea name="note" minlength="5" maxlength="2000" required></textarea></div><div class="action-row"><button class="btn" ${ready?'':'disabled'}>完成店员复核，提交经理核价</button></div></form>`,true);return true;
 }
 async function submit(form){if(form.dataset.form!=='staff-review')return false;const f=form.elements;await api(`/api/reservations/${f.id.value}/staff-review`,'POST',{reviewVersion,checks:Object.fromEntries(['identity','items','evidence'].map(k=>[k,f[k].checked])),note:f.note.value});ctx.orderModal(await api(`/api/reservations/${f.id.value}`));toast('店员复核已提交，下一步由门店运营经理核价');return true;}
 return{workflow,sla,rolesPage,act,submit};
}
