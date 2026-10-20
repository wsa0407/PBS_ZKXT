---
name: pbs-scenarios
description: 从客户原始需求归纳业务场景、场景内活动与待澄清事项，并建立可追溯关联。
---

分页读取原始需求，结合原文理解角色、触发条件、目标、活动和结果。场景来自客户业务，不能由公司产品目录倒推。

一个可独立启动、完成并验收的业务目标通常是一个场景；连续活动为同一目标服务时放在同一场景。不同场景可以共用需求与约束。背景、商务资质、范围外、交付服务保持其处理去向，不强造场景。

submit_scenarios 每项含 name、goal、actors、context、trigger、activities、outcomes、boundaries、assumptions、links、evidence。活动为 {text,req_ids}；links 为 {req_id,role}，role 只能为核心要求、支撑要求、适用约束；evidence 为 {field_path,seg_uid,quote}，field_path 对应支持的字段（如 goal 或 activities.0.text）。

提交前读取project_state的workspace_version，作为expected_version。提交后使用工具返回的新workspace_version；版本冲突时重新读取需求，不能只替换版本号而忽略人工修改。

未知字段留空，推断放 assumptions:{text,reason}。不虚构客户角色、时限、闭环或接口。以 submit_questions 记录需客户确认的问题，关联真实需求/场景。保留人工成果，校验失败后修正具体项。
