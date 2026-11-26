export const simulationNotice=
  '课程合成预览：价格、订单、收付款、退款、联系和签署均为模拟记录；不代表真实银行交易或合格电子签署。';

export function isShowcaseSource(db){
  return db.prepare("SELECT run_mode FROM runtime_installation WHERE singleton_id=1").get()?.run_mode==='SHOWCASE';
}

export function simulated(value){
  return {...value,simulation:true,simulationNotice};
}
