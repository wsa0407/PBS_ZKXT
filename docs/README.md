# 文档索引

## 当前规范

- [研发规则](../AGENTS.md)：代码层次、权限边界、数据保护和验证命令。
- [当前架构](architecture.md)：实际执行入口、人工确认、角色协作与迁移边界。
- [Agent 包](../agents/pbs/README.md)：三个角色、共享 Skills 和公司工作台适配要求。
- [运行时](../runtime/README.md)：dsh 配置、生命周期和真实模型验证。
- [产品与 BOM 数据](../app/catalogs/README.md)：独立数据包维护。
- [仓库核查记录](2026-10-21-repository-audit.md)：本轮清理、验证及剩余限制。

## 历史资料

`PBS_Agent_设计方案.md`、`PBS_Agent_技术设计.md`、`superpowers/specs/` 和
`superpowers/plans/` 保留各阶段设计与验收证据。它们描述的是记录时的实现或计划，
其中固定工作流、旧生成器、快捷按钮和未确认 PBS 执行等描述已被后续修改取代。
不要将历史记录与当前规范合并为同时生效的要求。

[业务资料准备清单](PBS_Agent_业务资料准备清单.md) 是资料收集参考，不是运行时依赖。
新增或修改行为时同步当前规范；历史验收结论只证明当时所执行的检查。
