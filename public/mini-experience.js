export function miniExperienceStatus(info){
  const enabled=info?.miniExperience?.access==='MEMBERS_ENABLED';
  return {
    enabled,
    label:enabled?'体验成员可扫码':'小程序体验筹备中',
    description:enabled?'已添加的体验成员可使用项目负责人分享的体验码进入。普通访客请先使用网页；正式发布入口单独开放。':'体验权限准备完成后，将向已授权成员提供体验码。',
    connection:info?.miniBackend?.configured===true
      ?'本实例已启用小程序登录服务；首次使用请按提示验证并关联顾客账号。'
      :'体验包使用受控顾客账号登录，与网页共用记录；真实微信身份绑定尚未启用。手机联通仍需体验包与合法请求域名配置正确。'
  };
}
