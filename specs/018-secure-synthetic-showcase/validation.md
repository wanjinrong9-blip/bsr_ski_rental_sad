# 018 本机合成预览验证记录

2026-11-26 收口：T041 的旧依赖“尚无 Git 发布包”已解决。源码与设计文档已获用户授权上传 GitHub，本轮再次检查受跟踪/暂存路径与公开代码的私钥/token 标记，禁入项为零；018 已列 43/43 任务完成。本机业务范围完成不表示云端、真实微信、支付或正式营业已验收；平台门槛继续由 019 跟踪。

更新：2026-11-20。**Phase 1–5 / T001–T038 已完成隔离本机验证**；Phase 6 的 Node 回归、四套本机浏览器流程及 FR/SC 映射已通过。T041 的实际仓库发布包审计尚未执行，因此 018 的发布门槛仍保持打开。不得用本记录宣称云端、真实收付款或 BSR 商业政策已验收。

## T001：修改前基线与来源完整性

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 完整 Node 回归 | **143/143**，失败 0 | 018 夹具加入前的现有测试，最终重跑通过；原始输出保存在被忽略的 `test-results/018-phase1-full-baseline.log` |
| 候选身份与来源 | **34/34** | `candidate-*.test.mjs` 加 `016-candidate-gate.test.mjs`；临时私有数据库与证书 |
| 017 本机可信代理 | **3/3** | `017-trusted-proxy.test.mjs`；本机 HTTPS/代理边界 |
| DEMO 核心业务 | **35/35** | `workflows`、`fulfillment`、`damage`、`store-access`、`service-upgrade` 五组测试 |
| 018 合成夹具 | **2/2** | `018-showcase-fixtures.test.mjs`；仅临时目录和内存数据库 |

第一次全量运行恰逢 019 测试断言修改，断言误读创建响应中的 `lines`，并非服务端业务失败。将断言移至订单详情响应后，单项及完整回归均通过。没有把这次失败计作稳定通过。

运行中的本机演示源 `data/bsr.sqlite` 采用 WAL。使用 Node 文件读取做只读 SHA-256；完整回归前后主文件及 WAL 的大小和摘要一致：

| 文件 | 字节 | 运行前后 SHA-256 |
| --- | ---: | --- |
| `data/bsr.sqlite` | 282624 | `60e7e451b86aabb04ed510d2609be3674d193d1b99924949a98a3941155836a9` |
| `data/bsr.sqlite-wal` | 4120032 | `14dc3e6d8c52a0f5e4a41995d7eaef410d87ab1c2eaed3033315ccd301aa4991` |

这是该测试时间窗的文件级未改动证据，不代替 SQLite 一致性备份。没有配置可供只读取摘要的持久 CANDIDATE 源；候选和 017 测试都生成并清理独立临时来源，不触及运行中的演示库或备份。

## T002：模式分支审计

| 位置 | 当前分支职责 | 018 所需拆分 |
| --- | --- | --- |
| `src/runtime-config.mjs:89–119` | 只认可 demo/candidate；候选要求私有 DB/备份、精确 HTTPS 来源、TLS 或可信代理及密钥 | 将这些入口安全条件扩展到 SHOWCASE，保留 demo 默认回环 |
| `src/runtime-provenance.mjs:21–64,88–113` | 启动前在内存快照检查 CANDIDATE 来源、READY、管理员和演示数据禁入 | SHOWCASE 有独立来源标记和完整合成数据检查；禁止候选库改名转换 |
| `src/db.mjs:407–427,458` | `seed(db)` 和演示订单仅在 demo 分支；candidate 跳过 | 新模式不能触发 `seed(db)`；schema 与演示插数分开 |
| `src/catalog-upgrade.mjs:23–52` | `ALTER` 结构升级与 `coreValues`、演示规格/单件/价格插入混合 | 结构迁移复用，演示数据仅 demo，SHOWCASE 用独立合成数据 |
| `src/identity.mjs:53–250` | 管理 Cookie、会话、限速、首次改密、撤销与账号开通；部分文字/审计名称写死 candidate | SHOWCASE 复用管理身份边界并用准确模式语义记录 |
| `src/server.mjs:36–46,87,154–203,281–328,352–390,503–579,696–721` | 同一个 `isCandidate` 同时控制 Cookie/SSE/Origin/代理/TLS 安全与购物车、目录、报价、预约、签付等业务禁用 | 分成 `managedSecurity = candidate/showcase` 与 `transactionsBlocked = candidate`；逐条核对角色/对象权限，候选仍禁交易 |
| `public/app.js:50–55,225–281,327,352,376–378,501–577` | `candidate || demo===false` 推断候选，混用管理登录、未批准说明和交易关闭页面 | 用明确能力字段决定业务页面；管理会话同属 candidate/showcase |
| `public/fulfillment.js:75`、`public/damage.js:63–64` | `candidate || demo===false` 决定是否发送旧演示会话头 | SHOWCASE 走管理 Cookie；交易是否可用另行判断 |

高风险点是将 `demo:false` 直接当作“不可预约”，以及让 SHOWCASE 误入 `catalog-upgrade` 的演示插数分支。后续先写 T004/T005 失败矩阵，再动运行代码。

## T003：合成夹具

`test/018-showcase-fixtures.mjs` 在系统临时目录创建独立路径、测试证书和端口；数据库初始不存在。清理前核实真实路径仍位于临时目录且名称为 `bsr-018-showcase-*`。`assertNoDemoMarkers` 检查配置和合成数据，`assertNoDemoRows` 检查 SQLite 文本字段；对 `@bsr.demo`、`Demo123!`、`BR-DEMO` 均拒绝。测试只用虚构字符串及内存数据库，不复制当前演示源。

Phase 1 之后已按 T004/T005 先写失败测试，再实现 Phase 2 的独立安全模式。真实交易、微信正式身份和云端权限均不在 Phase 1/2 验收范围。

## Phase 2 / T004–T011：独立用途、安全边界与旧模式回归

| 任务 | 完成结果 | 验证 |
| --- | --- | --- |
| T004/T005 先失败测试 | 新增启动矩阵和旧模式兼容测试；实现前 SHOWCASE 配置/来源测试按预期失败，新库 CHECK 白名单测试按预期失败 | `test/018-showcase-startup.test.mjs`、`test/018-showcase-compatibility.test.mjs`；实现后 **8/8** |
| T006 配置 | 显式 `BSR_RUN_MODE=showcase`；省略模式仍为 demo；私有数据库、独立备份、精确 HTTPS 来源、有效 TLS 或 017 可信本机代理均为启动前只读校验 | 直连/代理非法参数、公开和备份路径、无效模式测试拒绝，且不创建数据库 |
| T007/T008 来源与迁移 | 新库 CHECK 接受 `SHOWCASE` 并有 `showcase_dataset` 标记结构；旧库不重建 CHECK；目录、运营和履约结构升级与课程演示数据补录分离 | 空 SHOWCASE 库无演示用户、商品、库存和订单；DEMO/CANDIDATE 重复迁移不改变原来源、订单报价和行数 |
| T009 来源预检 | 以内存快照核对精确用途、READY、版本、首个管理员、数据集实例/版本、至少 2 店 20 单件及禁入的演示账号、口令、编号 | 错误来源与未初始化启动零副作用；正向虚构来源、删除数据集标记、混入演示口令/编号测试 **2/2** |
| T010 受管理边界 | SHOWCASE 复用受管理 Cookie、限速、Origin 和 017 代理校验；Cookie 与 CANDIDATE 隔离，候选仍禁交易。独立 `showcaseWorkflowPending` 暂停未验收的报价、预约、签署、付款及履约接口 | 会话/代理专项 **2/2**；实际 HTTPS 启动和业务暂停专项 **1/1**，未产生订单；管理账号入口可用 |
| T011 回归与文件完整性 | 全量 Node **158/158**、候选+017+018 专项 **52/52**，失败 0 | 全量日志 `test-results/018-phase2-full.log`；运行中的演示主库与 WAL 在本次回归前后摘要一致 |

本次回归前后 `data/bsr.sqlite` 均为 282624 字节、SHA-256 `60e7e451b86aabb04ed510d2609be3674d193d1b99924949a98a3941155836a9`；`data/bsr.sqlite-wal` 均为 4120032 字节、SHA-256 `14dc3e6d8c52a0f5e4a41995d7eaef410d87ab1c2eaed3033315ccd301aa4991`。这证明测试时间窗中演示源文件未改变，不替代数据库备份或未来恢复演练。

**Phase 2 闸门（历史记录）**：当时不会从空白 SHOWCASE 文件自动生成数据；只有人为构造的完整虚构 READY 测试源可供自动测试启动。Phase 3 已将其替换为受控线下初始化；业务流程仍由服务端 409 暂停。

## Phase 3 / T012–T020：一次性合成安装与六角色受管理身份

| 检查 | 本机证据 |
| --- | --- |
| 先失败后实现 | `test/018-showcase-init.test.mjs` 在 `initializeShowcase` 缺失时失败；`test/018-showcase-identity.test.mjs` 在 SHOWCASE 岗位档案、初班次与模式限定开通缺失时失败。实现后分别 **6/6**、**4/4**。 |
| T014–T016 来源与目录 | 新私有库一次事务提交 `SHOWCASE`/`READY` 来源、匹配实例 ID 且 `synthetic=1` 的唯一数据集标记、首位管理员和审计；插入 **2** 家明确虚构门店、**12** 款规格、**48** 件唯一编号装备、**24** 条 NOK 示例政策。每件押金为 `round(retail_nok × 0.08)`；预约数为 **0**。结构通过 `integrity_check=ok` 与外键检查 0 错。 |
| T015 原子性与隔离 | 强凭据或管理员输入无效时不创建数据库；故障注入后业务行与来源行均回滚，残留结构文件不得作为 READY 启动；并发双进程仅一方成功。重复初始化、残缺来源和 DEMO/CANDIDATE 文件转换均拒绝，前后文件摘要一致。 |
| T017 离线操作 | `test/018-showcase-cli.test.mjs` **2/2**：`preflight` 不创建 DB、输出不含秘密；`init` 要求交互 TTY 和隐藏输入，拒绝额外命令行参数及非交互凭据。 |
| T018 六类身份 | `test/018-showcase-phase3.test.mjs` 通过真正的本机 HTTPS 服务端开通顾客、租赁专员、门店经理、检修技师、经营负责人，加初始权限管理员合计 **6** 个不同账号。新账号首次登录必须改密，旧会话随之失效；非管理员不能查看账号清单，退出后旧会话无效。5 个非顾客岗位有虚构员工档案，3 个门店或检修岗位有首班次；已知演示密码、`@bsr.demo` 和自助注册被拒绝。 |
| T019 页面 | `test/018-showcase-phase3-browser.mjs` 在隔离 HTTPS Chrome 中通过：登录后才能访问目录、管理员在界面开通账号并退出、顾客首次改密、合成数据告知持续可见、桌面及 390px 页面无横向溢出且无 JS 异常。合成截图位于被忽略的 `test-results/showcase-phase3-*.png`。 |
| T020 回归 | 在 Phase 4 失败测试加入前，全量 `node --test test/*.test.mjs` **171/171**，失败 0；包含现有候选登录、权限、代理和 DEMO 业务测试。单独 Phase 3 专项 **13/13**。 |

**历史 Phase 3 闸门**：当时目录仅供登录后只读查看，`bookingEnabled=false`，交易接口返回 `SHOWCASE_WORKFLOW_PENDING`。Phase 4 后该闸门已由按运行用途划分的业务能力取代；SHOWCASE 可模拟完整业务，CANDIDATE 仍禁交易。

## Phase 4 测试先行状态（历史红灯）

`test/018-showcase-rental.test.mjs` 的 4 例、`test/018-showcase-operations.test.mjs` 的 2 例最初在预期的 `SHOWCASE_WORKFLOW_PENDING` 闸门处失败；`test/018-showcase-access.test.mjs` 当时仅 1/3 通过。这是 T021–T023 的实现前基线。下表记录解除闸门后的结果。

## Phase 4 / T021–T032：合成租赁全流程

| 范围 | 已通过的本机证据 |
| --- | --- |
| 预约与金额 | `018-showcase-rental.test.mjs` **4/4**：按起租/归还区间显示剩余数量、护目镜与护膝、NOK 逐件 8% 参考价值押金、09:00/16:00 服务端边界、创建时复核库存、重复提交与双顾客抢最后两件、政策快照与取消释放。 |
| 跨角色履约 | `018-showcase-operations.test.mjs` **2/2**：合同先签、模拟付款、具名备货、核码交付、无损归还自动模拟退押；另一单经 24 小时内虚构照片、技师评估、经理核价、押金抵扣与超额补差分支。`018-showcase-assignment.test.mjs` **1/1** 验证技师自动分派限同店或跨店授权。 |
| 权限与模拟语义 | `018-showcase-access.test.mjs` **3/3**：本人、本店、技师本人、经理、经营与管理员对象边界；伪造 Host、Origin、代理密钥或停用旧会话不能写入。`018-showcase-simulation.test.mjs` **3/3**：报价、订单、合同、纸质见证、店员现场收款、退款和模拟联系具有可读与机器可读的 `simulation=true` 标记；打印合同显著声明无真实交易。 |
| 真浏览器 | `node test/018-showcase-browser.mjs` 通过：本机 HTTPS 可信代理、六个独立受管理账号、两笔正常/受损终态订单；桌面与 390px 顾客**在网页上**选租期、加购、阅读勾选规则并预约，员工在网页上查看待办和执行交付；十二个角色页面视图无横向溢出或 JS 异常。`node test/018-showcase-phase3-browser.mjs` 的登录、开通、首次改密和移动布局也再次通过。 |

## Phase 5 / T033–T038：私有备份、恢复与重启

先写 `018-showcase-restore.test.mjs` 产生预期失败：旧清单无 SHOWCASE 来源字段，专用恢复命令尚不存在。实现后恢复专项 **5/5**，`018-showcase-migration.test.mjs` **2/2**，既有候选恢复及备份专项 **8/8**。清单含模式、实例 ID、结构/数据集版本、SHA-256、`integrity=ok`、外键错误 0 和恢复演练 `PASS`，不写密码或附件内容。专用恢复程序只接受 SHOWCASE、私有备份目录、同名普通文件清单和不存在的目标；候选/演示来源、实例/版本不符、坏哈希及已有目标都在发布前拒绝。恢复副本的所有旧会话撤销，账号 `auth_epoch` 增加，记录 `SHOWCASE_RESTORED` 审计。两笔合成订单、价目、明细与来源快照经备份、独立恢复和两次重启后保持一致；`integrity_check=ok`、`foreign_key_check=0`，原来源主文件摘要不变。Windows 当前环境拒绝创建测试用文件符号链接（`EPERM`），该负面子路径未实测；公开路径和常规路径拒绝已通过。

## Phase 6 / T039–T043：回归、视觉与交付边界

`npm` 在当前 PowerShell 环境未进入 PATH，因此用包脚本等价命令 `node --test test/*.test.mjs` 执行：**191/191 通过，0 失败、0 跳过**，原始输出在被忽略的 `test-results/018-full-final.log`。首次全量运行因新增提案列表模拟包装误把 `{items:[]}` 当作数组而为 190/191，修复后单项 7/7 与全量 191/191 均通过。`017-proxy-browser.mjs` 首次遇 Chrome `DevToolsActivePort` 临时文件 `EBUSY`，重跑通过；`candidate-browser-smoke.mjs` 通过；`preview-smoke.mjs` 的旧购物车 localStorage 断言改为核对当前账号购物车接口后通过。这些脚本均使用隔离临时数据和回环入口。

桌面与 390px 人工查看了 `test-results/showcase-*.png` 合成截图：登录、顾客购物车和结账、员工待接单操作弹窗与交付、技师档案和鉴定、经理每日排班与受损结算、经营报表、管理员审计。经理结算截图显示 NOK 180 损坏费、押金抵扣和 NOK 316 模拟退款，且页面提示不发生真实资金或联系。截图仅在被忽略的 `test-results/`，不含真实顾客或真实受损照片。

| 视图 | 桌面 | 390px |
| --- | --- | --- |
| 顾客订单与预约 | [桌面](../../test-results/showcase-lifecycle-customer-desktop.png) | [手机](../../test-results/showcase-lifecycle-customer-mobile.png) |
| 顾客结账金额与规则 | [桌面](../../test-results/showcase-customer-checkout-desktop.png) | [手机](../../test-results/showcase-customer-checkout-mobile.png) |
| 店员待接单操作 | [桌面](../../test-results/showcase-staff-prep-action-desktop.png) | [手机](../../test-results/showcase-staff-prep-action-mobile.png) |
| 技师鉴定 | [桌面](../../test-results/showcase-contractor-damage-cases-desktop.png) | [手机](../../test-results/showcase-contractor-damage-cases-mobile.png) |
| 经理每日排班 | [桌面](../../test-results/showcase-manager-shifts-desktop.png) | [手机](../../test-results/showcase-manager-shifts-mobile.png) |
| 经理费用结算 | [桌面](../../test-results/showcase-manager-settlement-desktop.png) | [手机](../../test-results/showcase-manager-settlement-mobile.png) |
| 经营与审计 | [经营桌面](../../test-results/showcase-owner-reports-desktop.png) · [审计桌面](../../test-results/showcase-admin-audit-desktop.png) | [经营手机](../../test-results/showcase-owner-reports-mobile.png) · [审计手机](../../test-results/showcase-admin-audit-mobile.png) |

T041 当前只完成源目录预审：`public/` 内无 `.sqlite`、私钥、备份或照片文件；公开代码扫描未发现私有口令或代理密钥；`.gitignore` 排除 `/data/`、`/test-results/`、`.env*`、私有证书及部署密钥。**工作区确有被排除的演示数据库与历史备份；尚无 Git 仓库或实际发布包，不能声称最终打包检查通过。**在准备 GitHub 成品时必须检查实际文件清单，再关闭 T041；本次没有初始化 Git、上传或开放云端。

### FR/SC 证据映射

| 要求 | 证据或剩余边界 |
| --- | --- |
| FR-001～004 | 启动/来源矩阵 `018-showcase-startup`、`compatibility`、`init`、`identity`；六角色真实 HTTPS 登录、管理开通和首登改密。 |
| FR-005～006 | `018-showcase-rental`、`operations`、六角色浏览器；NOK 示例价与逐件 8% 押金快照。 |
| FR-007 | `018-showcase-simulation`、合同打印及页面合成提示；真实支付与有效签章明确排除。 |
| FR-008～010 | `018-showcase-rental`、`operations`、`assignment`、`access`、`018-showcase-browser`；并发、权限、24 小时鉴定、具名进度与红色提醒。 |
| FR-011～012 | `018-showcase-restore`、`migration`、`compatibility`；来源严格互斥、恢复会话失效、旧模式回归。 |
| FR-013～014 | 合成数据初始化与附件限制、`public/` 预审、191/191 Node、四套浏览器回归。实际发布包检查仍为 T041；云端与商业验收不在本要求内。 |
| SC-001～002 | 六账号各自登录并执行本职操作；同一合成来源的正常与受损订单达到终态并保留具名阶段、金额及政策。 |
| SC-003～004 | 角色/对象/代理负面矩阵通过；并发最后单件和幂等下单无重复占用或模拟流水。 |
| SC-005 | 两订单隔离恢复、`integrity_check=ok`、外键错误 0、旧会话失效；既有 DEMO/CANDIDATE 兼容性矩阵保持原来源。 |
| SC-006 | 桌面与 390px 顾客网页预约、员工网页交付均通过；金额与签署页面持续标“合成/模拟”。仅回环代理，本轮无云资源。 |
