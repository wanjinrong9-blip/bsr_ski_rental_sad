# Tasks: 受控 HTTPS 入口的本机演练

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[代理契约](contracts/proxy-boundary.md)  
**Status**: 2026-11-18 本机自动化、代理浏览器与恢复演练通过；阿里云与组织验收未开始。只有真实完成并有本机证据的任务才勾选。

## Phase 1 — Setup 与安全基线

- [x] T001 验证运行演示库备份、完整性、外键与隔离恢复；保留 016 的 127/127 基线。2026-11-18 私有备份完整性 `ok`、外键错误 0、隔离恢复 `PASS`；破坏性测试只使用临时数据库。
- [x] T002 [P] [US1] 在 `test/017-trusted-proxy.test.mjs` 建 17 类错误配置与旧入口兼容红灯；失败前不创建候选库或外网监听。实现前 0/2，之后专项通过。
- [x] T003 [P] [US2] 在同一专项建立请求伪造、双客户来源桶、Cookie/Origin 与候选交易关闭红灯；测试代理只在回环地址启动。

## Phase 2 — US1 管理员可核查可信配置

- [x] T004 [US1] 修改 `src/runtime-config.mjs`：显式候选传输默认 `direct-tls`，代理模式校验唯一 HTTPS origin、64 字符随机 hex 密钥、私有候选库/备份，并禁止 demo 选择代理；配置预检保持只读。
- [x] T005 [US1] 复核 `src/startup-config.mjs` 的回环绑定未放宽；017 专项、原本地启动与候选启动安全测试通过。

## Phase 3 — US2 候选账号经受控代理访问

- [x] T006 [US2] 新建 `src/proxy-boundary.mjs`，在路由前验证原始报文中唯一 Host、代理密钥、HTTPS 协议和单值合法客户 IP；拒绝 absolute-form URL、重复/伪造安全头；只在成功时设置可信请求来源。
- [x] T007 [US2] 调整 `src/identity.mjs` 的来源限速：受控代理模式只用 T006 验证后的客户 IP，直连 HTTPS 继续用 socket IP；原始 `X-Forwarded-For` 永不作为凭据。
- [x] T008 [US2] 调整 `src/server.mjs`：所有 API、静态和健康检查先过 T006；仅代理候选内部使用 HTTP，原候选直连仍 HTTPS，demo 仍回环 HTTP。保留候选精确 Origin、Secure Cookie 和交易阻断。
- [x] T009 [US2] `test/017-trusted-proxy.test.mjs` 验证 29 类伪造/直连拒绝、代理账号登录与退出；甲的五次失败触发来源限速后返回 429，乙用独立的经清洗 IP 仍可正常登录，伪造来源头不影响来源桶。

## Phase 4 — US3 阿里云准备材料与恢复

- [x] T010 [P] [US3] 在 `deploy/aliyun/` 建不含密钥的 Nginx HTTPS→回环样例、候选运行环境变量模板与 ECS 购买后核对表；明确数据盘自动挂载、应用一致性备份、证书/域名/安全组和地域备案条件，不创建公网入口。
- [x] T011 [US3] `test/017-trusted-proxy.test.mjs` 使用临时候选库验证代理入口重启、备份、隔离恢复及旧会话撤销；正式数据盘、证书和 ECS 尚需购买后复验。

## Phase 5 — 综合验证与记录

- [x] T012 [P] 完整 Node 130/130、隔离演示及直连候选浏览器通过；新增 `test/017-proxy-browser.mjs` 通过外观域名映射和本机 HTTPS 代理验证 390px 登录/退出、Secure Cookie、受保护页面及预约阻断。
- [x] T013 更新 `README.md`、`docs/云端预览准备.md`、`docs/项目推进计划.md` 和 017 验收记录；单列 018 安全合成数据全功能预览，不在核心业务设计需求 PDF 加云端私有预览。
- [x] T014 已复核 SC-001～SC-005 的本机证据：专项 3/3、完整 Node 130/130 和三类隔离浏览器通过。服务继续只监听回环；无 GitHub 上传或阿里云资源创建，真实域名/证书/安全组/备案保留待办。

## Dependencies & Parallel Work

T001–T003 先于实现；T004–T005 构成配置门槛。T006 → T007/T008 → T009 是请求边界链。T010 可与源代码在不同文件并行；T011 在安全入口稳定后进行。T012–T014 最后统一验收。每项任务的业务价值分别对应 US1、US2、US3；云端实际开放和完整功能合成数据预览不在本包验收范围。
