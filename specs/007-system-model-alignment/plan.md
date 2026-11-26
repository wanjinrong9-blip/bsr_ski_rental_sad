# Implementation Plan: 需求与系统分析设计模型一致性

**Branch**: `007-system-model-alignment`（Spec Kit 逻辑标识；尚无 Git 分支） | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**：系统规约 UC-01～UC-15、需求台账与项目大纲。阶段 0 的现状核对和建模决策见 [research.md](research.md)。本计划产出课程设计需求文档及其图示；不表示图已重绘或 BSR 已签字。

## Summary

以现行需求编号为基线，先核对旧 LaTeX 文档与当前系统规约的编号、术语和业务政策，形成证据与差异台账；随后按六章课程目录分别完善业务序列、系统用例、模块类图、分析序列、状态图、数据层 ERD 与三层设计，最后编译 PDF 并逐页审阅。所有图由用例的名称、字段、事件和规则推导；现状事实、演示实现、目标流程和待 BSR 决策明确区分。

## Technical Context

**Language/Version**：中文 Markdown 需求基线；现有 LaTeX `ctexart` 工程；可编辑图源以项目现有绘图方式为准，不改变业务代码。  
**Primary Dependencies**：`usecase/` 文本、`output/BSR设计需求文档_LaTeX/main.tex`、`body.tex`、`updates/`、现有图片和课程示例；应用 `src/` 与测试只作核对证据。  
**Storage**：Markdown/TeX/图源/导出图片/PDF 文件；不新增业务数据库表。  
**Testing**：需求编号与追溯完整性检查、图文一致性审阅、LaTeX 编译诊断和 PDF 逐页视觉检查；必要时运行现有 Node/浏览器流程核实行为。  
**Target Platform**：A4 中文设计需求文档及可编辑分析设计图集。  
**Project Type**：系统分析与设计文档工程，与现有 Web 演示对照。  
**Performance Goals**：无运行性能变更；文档目标是 15 个 UC 全覆盖、关键模型可读、目录/图号/引用无缺漏。  
**Constraints**：六章目录、学生万锦融/信管2402、设计需求文档而非论文；图示尽量与老师课件示例一致；正式金额 NOK、时区 Europe/Oslo；待批准政策不得写成事实。  
**Scale/Scope**：15 个系统用例；六组分析类图、至少九张核心分析序列图、六类对象状态图与按模块拆分的 ERD；不把代码缺口同时作为本功能实施任务。

## Constitution Check

*GATE：计划阶段检查是否遵守原则，模型和 PDF 的实际质量在任务实施后再验收。*

| 原则 | 设计门槛 | 阶段 0 / 阶段 1 判断 |
| --- | --- | --- |
| I 业务价值与可追溯需求 | 每个业务图标来源/待访谈；FR/BR→UC→模型→验收有映射 | 通过 / 通过；旧编号差异进入映射表 |
| II 合同、金额与政策真实性 | NOK、政策版本、历史快照及模拟资金状态在图文一致 | 通过 / 通过；正式商业条款仍待 BSR 批准 |
| III 单件库存与跨店一致性 | 单件编号、时段占用、归属/所在店分离和异店归还进入类/状态/ERD | 通过 / 通过；目标模型与当前表差异显式标注 |
| IV 最小权限与顾客隐私 | 顾客本人/技师本人/经理职责进用例和序列；图中不含真实个人资料 | 通过 / 通过；验证实际授权仍依赖应用测试 |
| V 可验证变更与数据可恢复 | 编号、图号、字段、状态、PDF 有检查；历史数据设计不回写 | 通过 / 通过；文档任务不修改运行数据库 |

**Gate outcome**：未发现需豁免的原则。旧 LaTeX 与新规约的编号不一致是真实差距，已列为首个任务，不在计划中宣称解决。

## Project Structure

### Documentation (this feature)

```text
specs/007-system-model-alignment/
├── spec.md
├── plan.md                 # 本文件
├── research.md             # 阶段 0：现有文档与建模决策
├── data-model.md           # 阶段 1：六组领域实体及 ERD 映射
├── quickstart.md           # 阶段 1：图文/PDF 验证路径
├── contracts/
│   ├── traceability.md     # 编号与双向追溯契约
│   └── diagram-conventions.md # 图示的元素与审阅约束
└── tasks.md                # 已按 speckit-tasks 生成的实施任务清单
```

### Existing source and target artifacts

```text
../usecase/
├── requirement.txt         # 需求编号与业务规则源
├── 系统规约.md             # UC-01～UC-15 用例源
├── 项目大纲.md             # 六章与目录结构
└── 系统总体计划.md         # 全系统交付次序
../output/BSR设计需求文档_LaTeX/
├── main.tex                # 样式、目录与主文件
├── body.tex                # 当前正文（存在旧 UC 编号）
├── updates/                # 当前各章节增补文件
├── media/                  # 现有导出图片
└── diagrams/               # 计划新增的可编辑图源及编号索引
src/                       # 现有系统；仅作行为核对
test/                      # 现有自动及浏览器验证
docs/需求覆盖与升级审计.md  # 实现/目标差距证据
```

**Structure Decision**：文本基线保留在 `usecase/`，正式排版仍在现有 LaTeX 项目中维护，不另起一套互不关联的文档；图源与导出图片分开，按图号/UC/模块命名。业务代码本轮不修改。

## Phase 0: Outline & Research

已完成本地资料核对，见 [research.md](research.md)：

1. 旧 LaTeX 正文用 UC01～UC17 和增补 UC18～UC24；新系统规约用 UC-01～UC-15，须先建立逐项语义映射。
2. 现状业务序列需证据；无访谈的节点不能被旧图或系统截图自动证明。
3. 六组类图和模块 ERD 是审阅单元；分析序列图按核心 UC、状态图按复杂对象独立绘制。
4. 数据设计由分析类和关系导出，同时列目标模型与当前 SQLite 表差距。
5. 编译成功不等于模型正确，最终须同时检查内容、图形和版式。

## Phase 1: Design & Contracts

1. [data-model.md](data-model.md)：以六组领域实体为索引，定义恒定身份、关联、状态、快照与模块 ERD；标旧实现差距。
2. [contracts/traceability.md](contracts/traceability.md)：规定需求、UC、图、数据实体、测试证据的记录格式及编号映射；审阅者可以双向查找。
3. [contracts/diagram-conventions.md](contracts/diagram-conventions.md)：规定业务/分析序列、类图、状态图和 ERD 必要元素及教师样例的图形表达要求。
4. [quickstart.md](quickstart.md)：给出当前可运行的文本/编译核查入口与人工图形检查；未完成的图明确标待绘。

### 实施顺序

1. 盘点 `body.tex` 和 `updates/` 全部旧 UC、图号、交叉引用及重复/缺失项，建立旧→新编号表；尚无同义映射的旧项保留为“待确认”，不强行合并。
2. 为五个重点业务场景核对现状证据并重画业务序列与目标蓝图；目标图标出负责岗位、业务实体及信息流自动化。
3. 按 UC-01～UC-15 更新系统用例图、关键字段字典和涉众利益；再画六组分析类图、核心序列图、对象状态图。
4. 从分析类导出分模块 ERD，核对 PK/FK、基数、约束、历史政策/合同/费率版本；对照现有数据库，形成差距表。
5. 把模型和规约写回六章 LaTeX 正文，统一图号、标题编号、术语和页面样式，编译并逐页核查 A4 可读性。
6. 更新 `docs/需求覆盖与升级审计.md` 中的文档/模型状态；代码缺口交给单独功能规格处理，不在图纸里假称完成。

### 验证与回退

- 文档编辑前保留现有 `main.tex`、`body.tex`、`updates/` 和图片的可恢复副本或版本快照；对图与章节按模块替换，发现编译/图义回归可恢复上一版。
- 自动核对旧/新 UC 编号、FR/DR/BR/NFR 追溯、图号唯一性、所有图片路径和 `\input` 存在性；人工复核业务实体关系与异常分支。
- 用内置 LaTeX 编译诊断确认构建成功，逐页检查目录、图注、表格和图片边界。浏览器/Node 测试仅用于核对系统实现描述，不代替 BSR 签字。
- 任何未证实的现状、商业费率或系统生产能力应保持标签和待决责任，不为追求“100% 覆盖”而虚构证据。

## Post-design Constitution Recheck

阶段 1 产物的范围限于可追溯的模型和课程文档；没有重写业务规则、访问权限或运行数据库。五条宪章原则均有对应图示/字段/状态审阅点，设计门槛通过。**实际图、PDF 和 BSR 业务确认尚未完成**；下一步由 `$speckit-tasks` 生成具体绘图、改稿和验证任务。
