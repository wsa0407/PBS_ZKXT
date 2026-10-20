---
name: pbs-requirements
description: 理解客户招标文件、会议纪要和原话，提取有原文依据的原子需求并修复引用。
---

先查看材料目录、处理覆盖和现有需求。read_document_batch 按原文顺序批量读取未处理内容；沿 next_cursor 继续直到结束。list_document_sections 查目录，read_evidence 回查原文和上下文；search_evidence 仅辅助定位。

按文档逐批处理，通常最多 60 个短片段或 6000 字；长片段可以跨批读取，沿游标继续，不能遗漏余文。每批可分多次submit_requirements提交，每次最多30项。一条需求只讲一件事，保留数字、范围、否定、对象、条件与要求强度。quote 从所关联片段逐字连续复制。招标文件 inferred=false；访谈的推断要显式标注，不把推断当客户已确认事实。

类别：功能、性能、环境、安全、信创、集成、实施、服务、商务、资质、背景、范围外。不要把商务/资质条款混作产品功能。优先级：必须、重要、一般；星号或三角号条款必须。

submit_requirements 接收 document_id、document_version 和 requirements。每项含 evidence_id、text、quote、category、priority；params 可按 project_state 的参数字典提供 name/value/quote，不自行换算单位或推导数量。

无实际要求的页码、目录、空白表格可用 ignored 提交 evidence_id 与具体 reason，不得用忽略绕过实质技术或商务条款。提交工具返回 accepted、errors、coverage；仅修复 errors 的内容，不重复已经成功的项。

提交前检索或读取相邻内容，理解表格续行。片段不完整时仍将需求锚定到其中一个真实片段，quote 必须来自该片段；如需跨片段表达，应保留约束并提出澄清，不能补造省略的指标。

完整抽取结束需要所有实质片段有需求或有说明的处理记录；run_report 显示未处理片段时继续分页。已通过但未人工确认的需求均为初稿。对无法核实的引用保留待办，不伪造证据。
