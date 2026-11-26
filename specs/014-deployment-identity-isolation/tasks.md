# Tasks: 正式运行身份与演示数据隔离

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[接口契约](contracts/identity-and-setup.md)、[quickstart.md](quickstart.md)  
**Status**: 2026-11-17 本机实施与验收任务 53/53 项已完成；T048 的独立审阅者用时 23 秒通过本机辨识检查。未上传 GitHub、未发布公网；该结论不等于 BSR 业务或正式部署验收。

**Tests**: 规格中的每个故事都有独立验收，宪章要求改身份/数据库时做自动及浏览器验证。先写失败测试，再实现对应行为。

**Format**: `[P]` 表示可与同阶段其他不同文件任务并行；`[USn]` 对应规格的第 n 个故事。路径均以 `bsr-app/` 为根。

## Phase 1 — Setup（隔离基线）

**Goal**: 让后续候选模式试验不会触及现有演示库。

- [x] T001 在 `specs/014-deployment-identity-isolation/quickstart.md` 记录当前演示库的 011 可恢复备份检查方式、隔离临时路径规则及实际开始实施时的基线结果；不把私有库/备份复制到发布目录。
- [x] T002 [P] 在 `test/candidate-fixtures.mjs` 建立每次测试独立的数据文件、备份目录、回环端口和清理辅助函数；默认不读取 `data/bsr.sqlite`，也不靠 `NODE_ENV=test` 保护原库。
- [x] T003 在 `test/candidate-contract.test.mjs` 使用 T002 的隔离夹具固定默认演示模式的现有 `/api/bootstrap`、登录响应及 013 回环限制基线，先确认测试对旧行为有辨识力。

## Phase 2 — Foundational（所有故事共用的边界）

**Goal**: 提供运行用途、来源标记及独立的身份数据结构；不开放候选业务访问。

- [x] T004 在 `src/runtime-config.mjs` 解析明确的 `demo`/`candidate` 用途、回环地址、候选 HTTPS 证书/密钥配对、与主机端口一致的安全来源和私有数据/备份路径；未知、空白及冲突值拒绝，省略用途时仅为演示。
- [x] T005 在 `src/runtime-provenance.mjs` 实现不创建文件或 WAL/SHM 的来源预检；区分不存在、候选 READY、演示、无标记、半初始化和高版本，拒绝路径别名进入公开目录。
- [x] T006 在 `src/db.mjs` 规划并创建单例 `runtime_installation` 结构（`singleton_id=1`、`run_mode=DEMO|CANDIDATE`、唯一 `instance_id`、非负 `schema_version`、`init_state=INITIALIZING|READY|BLOCKED`、首个管理员引用）及 `runtime_checks`、`initial_admin_event` 审计结构；保留既有订单/库存主键。
- [x] T007 在 `src/db.mjs` 为候选账号、会话与失败尝试加入 `account_state=ACTIVE|DISABLED`、`provisioning_method=OFFLINE_ADMIN|VERIFIED_SELF`、`must_change_password`、`auth_epoch`、会话撤销及 10 分钟窗口/15 分钟暂停所需结构；迁移不把演示身份提升为候选身份。
- [x] T008 在 `src/runtime-provenance.mjs` 约束双向模式匹配：无标记旧库只许保留演示用途，候选标记库不能由演示种子路径打开；预检失败只输出非秘密类别。

**Checkpoint**: 共享结构与只读预检可独立测试；候选业务启动仍保持关闭。

## Phase 3 — US1 操作员明确选择运行用途（P1；安全闸门）

**Independent Test**: 默认演示可启动；至少 8 类候选配置失败均不创建目标文件、目录、WAL/SHM 或监听；已准备好的候选夹具能通过复检且仍仅回环。

- [x] T009 [P] [US1] 在 `test/candidate-startup.test.mjs` 先写模式空白/未知、非回环 HOST、非法端口、证书/密钥缺失或不配对、安全来源缺失/冲突、公开目录路径及备份目录缺陷的失败测试，并核对零副作用。
- [x] T010 [P] [US1] 在 `test/candidate-contract.test.mjs` 先写默认演示与候选健康/引导信息区分测试，候选不得称已上线或暴露数据路径。
- [x] T011 [US1] 在 `tools/candidate-setup.mjs` 实现只读 `preflight` 命令：输出用途、来源、阻断码与 `needs_init`/`ready`，不得导入会立即 `openDb` 的服务入口。
- [x] T012 [US1] 在 `src/server.mjs` 把用途和只读复检放在 `openDb` 与监听之前；候选直接在回环地址使用 HTTPS 证书/密钥，演示保持原 HTTP；候选缺初始化、来源冲突或证书条件时非零退出，保留 013 回环闸门。
- [x] T013 [US1] 在 `src/server.mjs` 使 `/api/health` 与 `/api/bootstrap` 返回正确用途及候选能力摘要，候选响应不得泄漏路径/秘密，默认演示字段继续兼容。
- [x] T014 [US1] 运行 `test/candidate-startup.test.mjs` 和 `test/candidate-contract.test.mjs`，将逐项结果及未覆盖平台路径写入 `specs/014-deployment-identity-isolation/quickstart.md`；未通过不得进入 US2。

## Phase 4 — US2 正式候选从干净数据开始（P1；可用最小闭环）

**Independent Test**: 使用预检通过的空夹具初始化后仅有一个首个管理员，演示业务六类记录均为零；重复、并发、中断及旧库提升被拒；无批准目录时不能预约。

- [x] T015 [P] [US2] 在 `test/candidate-data.test.mjs` 先写零演示账号/订单/库存/价目/照片/流水、首个管理员恰好一个及重复/并发初始化断言。
- [x] T016 [P] [US2] 在 `test/candidate-startup.test.mjs` 先写演示库、无标记库和高版本库被候选只读拒绝、原文件与关键行数不变的测试。
- [x] T017 [US2] 在 `src/db.mjs` 把建表/安全结构迁移、演示 `seed()`、`seedDemoOrders()` 分离；候选空库绝不执行固定账号、示例门店和订单填充，演示空库仍按旧路径填充。
- [x] T018 [US2] 在 `src/catalog-upgrade.mjs` 拆开结构/历史回填与示例变体、单件、价目插入；候选不得运行示例新增，演示的 8% 押金和旧报价语义保持。
- [x] T019 [US2] 在 `src/db.mjs` 的 `upgradeOperations` 与 `src/fulfillment-schema.mjs` 的升级路径中隔离演示排班、人员档案及费率补录；候选只执行经审查的结构变化。
- [x] T020 [US2] 在 `tools/candidate-setup.mjs` 实现交互式 `init-admin`：先验证非预置、实例唯一凭据，不在命令参数/回显/日志中保存秘密；来源标记、管理员及初始化审计原子提交，重复/并发只能有一个首个管理员。
- [x] T021 [US2] 在 `src/runtime-provenance.mjs` 复检候选单例来源、`READY`、兼容版本和首个管理员唯一性；半初始化或双向模式混用时拒绝业务启动，不自动删除文件。
- [x] T022 [US2] 在 `src/server.mjs` 阻止候选无获批门店、装备和价目时的预约；`/api/bootstrap` 不返回演示目录、演示汇率或把演示损坏/超时政策表述为已批准。
- [x] T023 [US2] 运行 `test/candidate-data.test.mjs` 与对应候选启动测试，并把空目录、原库不变及并发初始化证据写入 `specs/014-deployment-identity-isolation/quickstart.md`。

## Phase 5 — US3 每位用户用受管理的身份访问（P1）

**Independent Test**: 用预先初始化的隔离候选夹具完成六角色、两门店和技师指派矩阵；安全连接登录不返回脚本令牌；来源、限速、退出、权限变更及受控开通均按契约验收。

- [x] T024 [P] [US3] 在 `test/candidate-identity.test.mjs` 先写候选登录仅返回用户摘要、受保护会话、退出/过期/撤销旧会话 401，以及演示登录保持兼容的契约测试。
- [x] T025 [P] [US3] 在 `test/candidate-origin-limit.test.mjs` 先写候选所有写入缺失/不匹配 Origin 返回 403、账号或来源 10 分钟 5 次失败后暂停 15 分钟返回 429、业务数据零改变的测试。
- [x] T026 [P] [US3] 在 `test/candidate-access.test.mjs` 先写两顾客、两店店员/经理、受派与未受派技师、经营/管理员的对象读写拒绝矩阵，以及角色/门店/指派变化后的旧会话撤销。
- [x] T027 [US3] 在 `src/identity.mjs` 实现候选账号状态、会话 `auth_epoch`、有效期及撤销检查；候选不接受 `x-bsr-session`，不把可重用凭据写到 JSON、URL 或日志。
- [x] T028 [US3] 在 `src/server.mjs` 实现候选登录/退出的受保护 Cookie（`HttpOnly; Secure; SameSite=Strict`、无 Domain、最长 8 小时），所有候选请求按当前账号状态和权限读取，演示保持原响应。
- [x] T029 [US3] 在 `src/identity.mjs` 实现按标准化账号与来源分别计数的失败登录限速，计数过期清理及不泄露账号存在性的错误；在 `src/server.mjs` 统一使用 429 与非秘密重试提示。
- [x] T030 [US3] 在 `src/server.mjs` 对候选全部状态变更请求验证与本机 HTTPS 来源完全一致的可信来源，缺失也拒绝，不采信转发头；保留演示兼容路径。
- [x] T031 [US3] 在 `src/server.mjs` 关闭候选自助注册/恢复；增加仅授权管理员可用的账号开通与首次凭据更换路径，未核验顾客、无门店员工或越权高权限创建均拒绝。
- [x] T032 [US3] 在 `src/workforce.mjs`、`src/maintenance.mjs` 及 `src/server.mjs` 的角色/门店/技师指派与凭据变更路径更新授权版本或撤销会话，确保旧会话立即 401；012 对象授权仍逐请求检查。
- [x] T033 [US3] 在 `public/app.js` 按候选能力隐藏演示账号、统一密码、一键角色入口、自助注册/恢复；候选请求仅依赖安全会话，不读写 `sessionStorage` 令牌。
- [x] T034 [P] [US3] 在 `public/damage.js` 移除候选照片读取对脚本令牌的依赖，保持顾客本人及受派技师权限和私有缓存清理。
- [x] T035 [P] [US3] 在 `public/fulfillment.js` 移除候选合同打印读取对脚本令牌的依赖，保留打印权限和原演示流程。
- [x] T036 [US3] 在 `test/candidate-browser-smoke.mjs` 使用应用直接提供的回环 HTTPS 验证候选登录、刷新、退出、受控开通、照片/合同、跨标签与 390px 布局；证书私钥只用于隔离测试且不入库，不因普通 HTTP 成功而判定候选通过。
- [x] T037 [US3] 运行 US3 三组自动测试及本机安全入口浏览器流程，把授权矩阵、失败/限速/撤销和跳过原因写入 `specs/014-deployment-identity-isolation/quickstart.md`。

## Phase 6 — US4 操作员审阅迁移和恢复边界（P2）

**Independent Test**: 三种旧数据副本只读拒绝且原文件/订单零改变；候选私有备份目录的链接逃逸被拒；隔离恢复保留订单快照并使恢复前会话失效。

- [x] T038 [P] [US4] 在 `test/candidate-provenance.test.mjs` 先写演示、无标记/混合、版本不兼容库的候选拒绝及源文件哈希/关键行数不变测试。
- [x] T039 [P] [US4] 在 `test/candidate-backup.test.mjs` 先写备份目录位于公开目录、词头相似兄弟目录、符号链接与 Windows junction 的接受/拒绝矩阵。
- [x] T040 [US4] 在 `tools/backup-verify.mjs` 和 `src/runtime-config.mjs` 加入备份路径词法加真实路径检查，候选照片、日志、配置与备份不得经链接进入 `public` 或发布产物。
- [x] T041 [US4] 在 `src/runtime-provenance.mjs` 提供不修改源库的来源/版本/演示资料阻断摘要；无标记旧库继续仅供本地演示，014 不执行历史数据迁移。
- [x] T042 [US4] 在 `tools/candidate-setup.mjs` 定义隔离恢复后复检与候选会话失效步骤；按 011 清单比对 NOK 订单金额、合同版本和库存号，不覆盖现有运行库。
- [x] T043 [US4] 运行 `test/candidate-provenance.test.mjs`、`test/candidate-backup.test.mjs` 和隔离恢复演练，记录源库哈希、恢复对照和无法创建链接的环境限制到 `specs/014-deployment-identity-isolation/quickstart.md`。

## Phase 7 — US5 审阅者辨认真实成熟度（P2）

**Independent Test**: 分别打开演示与隔离候选的登录/订单/项目说明，审阅者 1 分钟内能辨认用途、支付/签署/价目限制；需求覆盖项均有真实状态。

- [x] T044 [P] [US5] 在 `public/app.js` 标明演示或候选用途，候选空业务目录及身份限制可理解；订单/费用页面持续说明真实交易、签署和 BSR 政策未验收。
- [x] T045 [P] [US5] 在 `README.md` 增加候选离线预检、首个管理员、私有备份、仅本机安全入口的非秘密操作说明，不给出默认正式凭据或公开部署指令。
- [x] T046 [US5] 在 `docs/需求覆盖与升级审计.md`、`docs/项目推进计划.md` 更新 014 实际实现/测试状态，并保持 005 技能默认值和顾客独立确认缺口可见。
- [x] T047 [US5] 核对 `../usecase/requirement.txt`、`../usecase/系统规约.md` 及 `../output/BSR设计需求文档_LaTeX/main.tex` 中受影响的身份、数据来源、系统用例和设计图；仅在实现与模型一致后更新，改图需重新渲染检查，不把候选写成正式上线。
- [x] T048 [US5] 在 `specs/014-deployment-identity-isolation/quickstart.md` 记录演示/候选双用途界面审阅耗时和缺口；隔离 Chrome 截图与 23 秒计时支持 SC-007 的本机通过结论。

## Phase 8 — Polish & Cross-Cutting Verification

- [x] T049 [P] 在 `test/candidate-startup.test.mjs` 补首次初始化中断、重复、并发和旧库/模式双向混用边界；确认所有失败路径无业务副作用。
- [x] T050 [P] 在 `test/candidate-identity.test.mjs` 补会话恢复、角色变更并发、管理员开通重复邮箱、强制首登改密和不同来源限速边界。
- [x] T051 运行 `npm test`、`node test/preview-smoke.mjs` 和全部候选隔离测试/浏览器流程；把实际通过、失败、跳过与 011–013 回归结果写入 `specs/014-deployment-identity-isolation/quickstart.md`。
- [x] T052 核对 `specs/014-deployment-identity-isolation/spec.md` 的 FR-001～FR-015、SC-001～SC-007 与测试证据，记录未达到项及原因；不得用任务勾选替代正式验收。
- [x] T053 核对 `docs/项目推进计划.md` 与 `docs/需求覆盖与升级审计.md` 的状态，只在证据齐全时标记“本地候选验收”；公开站点、真实支付/签署、BSR 批准和容量仍保持独立缺口。

## Dependencies & Execution Order

- Setup T001–T003 先于 Foundational T004–T008；T003 使用 T002 的夹具，T001 可与 T002 并行。基础边界完成后才进入任何故事。
- US1 是安全闸门；US2 的空库初始化依赖 US1 的预检接口。US3 使用预先初始化的测试夹具，业务交付顺序在 US2 后，但其身份模块和测试可在基础层完成后独立开发。US4 的旧数据/备份检查可与 US3 并行；US5 等待相关界面与文档事实形成。
- 每个故事先写其失败测试，再完成模型/服务/接口，随后单独验证；任务中的 `[P]` 仅用于不同文件且无未完成依赖的工作。共享 `src/server.mjs`、`src/db.mjs` 的改动按 T 号顺序集成，避免并行覆盖。
- 最后 T049–T053 汇总回归、浏览器、恢复和追溯证据；任何失败不标记故事完成。

## Parallel Examples

- US1：T009 的启动失败测试与 T010 的用途响应测试可并行写入不同文件；随后 T011–T013 顺序集成。
- US2：T015 的空库/初始化测试与 T016 的旧库拒绝测试可并行；`db.mjs` 和 `catalog-upgrade.mjs` 的写入门槛需先约定，T017–T022 顺序整合。
- US3：T024、T025、T026 可并行建立不同测试矩阵；T034 和 T035 可在候选会话契约确定后分别处理照片与合同模块。
- US4：T038 的来源测试与 T039 的路径测试可并行；真实路径实现和恢复演练依赖两者的失败证据。
- US5：T044 的界面文案与 T045 的操作说明可并行，追溯与结论随后更新。

## Implementation Strategy

**安全检查点**：先完成 Setup、Foundational 与 US1，证明错误候选配置不会污染演示数据或开放访问。  
**最小可用候选**：再完成 US2，才具备独立空数据空间及唯一管理员；此时仍不能称为可公开服务。  
**增量完成**：US3 实现受管理身份及浏览器会话，US4 验证旧库/备份边界，US5 对齐界面和课程交付物。每阶段独立验收后才进入下一阶段的最终结论。  
**边界**：不在任何阶段自动部署、初始化 Git、上传 GitHub、开放外网或对真实资金/签署给出上线承诺。



