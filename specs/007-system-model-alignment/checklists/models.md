# Model Quality Checklist: 需求与系统分析设计模型一致性

**Purpose**: Reviewer-owned checklist for requirement and diagram quality  
**Created**: 2026-10-27  
**Feature**: [spec.md](../spec.md)  
**Review Ownership**: `[x]` means a reviewer judges the written requirement/model criterion satisfied; it does not mean the application is implemented.

## Business evidence and use cases

- [x] CHK001 Are business actors, workers and entities distinguished for each core business scenario? [Spec FR-002/003]
- [x] CHK002 Does every asserted as-is action carry a source or an explicit pending-interview label? [Spec FR-003]
- [x] CHK003 Are the 15 system use cases linked to observable actor value rather than menu names? [Spec FR-004]
- [x] CHK004 Are preconditions, postconditions, extension steps and stakeholder interests specified for every UC? [Spec FR-005]

## Analysis model consistency

- [x] CHK005 Are the six class modules defined with names, attributes, operations and correct relation types? [Spec FR-006]
- [x] CHK006 Do sequence messages match the referenced UC steps, including exception branches and responsible actors? [Spec FR-007]
- [x] CHK007 Are triggers, guards and effects stated for all complex state transitions? [Spec FR-008]
- [x] CHK008 Are terms such as current store/home store, read/unresolved and assessed/repaired used consistently? [Spec FR-010]

## Data design and final document

- [x] CHK009 Are PK/FK, cardinalities, uniqueness and historical snapshots specified in each ERD module? [Spec FR-009]
- [x] CHK010 Is the old-to-new UC number mapping based on semantics and reflected in figure captions? [Spec FR-011]
- [x] CHK011 Does the traceability matrix cover every required FR/BR and expose unfinished evidence? [Spec FR-010]
- [x] CHK012 Are title, numbering, diagrams, typography and image readability requirements specific enough for PDF review? [Spec FR-012]
- [x] CHK013 Are unapproved commercial policies and local demo services consistently labeled? [Spec FR-013]

## Notes

- 2026-11-13 文本及图源复核：五对业务图均区分执行者/工人/实体，现状箭头附 EV 或待访谈；15 项 UC 规约逐项具利益、前后置与扩展；六类状态的边编号在 `updates/analysis-states.tex` 逐项解释守卫和副作用。六组 ERD 与《数据字典》明确键、基数、历史快照和目标/现有差异；旧新编号按语义映射。`requirement.txt` 的 56 个源编号已全部在《需求追溯矩阵》出现，FR-S01/S02 属横向运行约束，不虚构业务用例；商业政策和模拟资金仍标待批准/生产缺口。
- 2026-11-13 4.8 复核：六组类图中四条组合关系均已在整体端加实心菱形；S-UC05/10/11 将顾客与专员、技师与经理、顾客与经理拆为独立泳道，动作与异常标签可对应规约。最终 72 页 A4 PDF 已编译，图示页 13–18、21–22、34–46、53–56 与封面、目录、附录逐页渲染检查，首条消息、连线、表框及图注无重叠或裁切；Tectonic 无 overfull 警告。勾选仅表示书面模型质量审阅，不表示 BSR 已批准现状、蓝图或商业规则。
