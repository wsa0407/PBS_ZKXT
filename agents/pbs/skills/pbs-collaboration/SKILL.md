---
name: pbs-collaboration
description: 围绕具体业务缺口发起专家咨询、回答与追问，记录采用结果并处理用户补充；适用于需要跨职责求证的协作活动。
---

## 选择协作而非固定串联

所有角色共享本方法，先读取 collaboration_state.capabilities 中的 consultation_targets 和 business_tools；实际可投递对象和可用工具以宿主授权为准。原文定位与材料完整性找材料专家，客户意图和场景边界找需求理解专家，产品能力与交付组成找 PBS 专家。能独立核实的问题直接处理，不为展示协作而制造往返，不规定每次必须按上述顺序调用。

本技能不授予任何角色额外写入或人工确认权限。当前宿主未暴露的双向咨询、交接或通知操作不能靠聊天模拟；说明限制和具体待办，不声称已送达。

## 发起与接续

读取 collaboration_state 核对真实咨询、确认范围和人工输入。ask_expert 提供 operation_id、实际允许的 target、具体 question；references 只引用本项目真实编号。问题说明疑点、已核对内容及对当前成果的影响。追问使用 followup_to 关联本角色已收到的答复，并指出新增疑点。

工具返回 waiting 只证明已受理，不代表专家已回答。保存必要的本次进度，结束本次活动，不轮询；收到接续后读取真实答复，再选择继续求证或推进当前工作。不得用模型记忆或对话结尾猜测答案。

## 回答与采用

被咨询时使用 submit_expert_answer，关联当前 consultation_id。说明结论、必要依据与 unknowns，区分 source_fact、human_confirmed、analysis、unknown；需要证据时选择 pbs-evidence。咨询期间只读业务成果，不能把解答变为擅自修订。

发问方通过 record_consultation_outcome 记录 adopted、partial、rejected 或 human_pending，解释理由并关联实际成果。专家答复与客户确认分开；收到答复不自动采纳，采纳解释也不等于成果已保存。

同一问题没有新信息时不重复提问，不能把收到的问题原样推回发问方。遇到相互依赖、工具拒绝、预算不足或无法核实时，提交已有证据、明确未知和需要谁决定，避免无结论的循环。

## 人工补充

宿主安排处理补充时，先 read_interventions 读取原话和其他待处理上下文。仅处理本次定向消息，其他消息用于理解影响；不能把转述当成正式客户答复。

acknowledge_intervention 按实际结果报告：只读解答或工作指令用 read_only；已保存调整用 adjusted 并关联本次成功 operation_ids；涉及已确认范围变化先 propose_change，再用 requires_confirmation 关联回执；确实无法判断时使用 needs_clarification。

“已接收”“已送达”“已调整”具有不同事实依据。旧版本答复不能支持新范围；人工纠正到达后以重新加载的上下文和宿主写入限制为准。
