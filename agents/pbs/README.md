# PBS Agent 包

本目录可随 PBS Agent 安装到契约兼容的公司 dsh 工作台。包含指令、Skills、工具契约和评测资料；不依赖当前 Vue 界面、SQLite 或 embedding 服务。

宿主注册 `contracts/tools.mjs` 声明的工具，实现项目绑定、权限、持久化、幂等、版本校验和预算。可用 MCP 提供，传输名字由宿主声明。以 `preset.mjs` 的组合加载身份与 Skills，通用 Agent loop 由 dsh 提供。

本地宿主见仓库 `runtime/`；当前业务适配器位于 `app/server/`。将来公司 RAG 实现 search_evidence/read_evidence/list_document_sections，结构化业务服务实现其余契约，不修改业务 Skills。

三个职责独立维护：

- `roles/materials/AGENTS.md`：材料拆解、原文回查和覆盖。
- `roles/understanding/AGENTS.md`：需求理解、场景和待澄清事项。
- `roles/pbs/AGENTS.md`：确认范围内的PBS编制、产品匹配和多轮求证。

根目录 `AGENTS.md` 保存共用业务概念、证据、授权及简短表达规则。每份角色文件定义目标、输入、能力、成果责任、边界、协作与完成条件。具体工作方法维护在共享 Skills，避免角色指令变成重复的操作手册。

`roles.mjs` 定义当前角色权限及咨询方向；`collaboration_state.capabilities` 返回当前活动可用的业务工具与咨询对象。`contracts/collaboration.mjs` 是咨询、答复、人工补充的可迁移契约。角色会话存储隔离；当前宿主顺序调度，允许专家在后续活动中继续咨询。

## 群聊收件与文字确认

新聊天消息无 @ 时投递三个角色，有 @ 时仅投递指定角色，支持多选提及。各角色通过只读收件活动中的 `respond_to_message` 判断是否认领；全部接收者完成判断后，只有认领者进入问答或业务执行。无关角色保持安静，认领记录和用户消息持久化；这不是按关键词选择一个专家的路由器。

需要人工确认时在聊天中展示范围与版本，通过 `request_confirmation` 可提出局部范围供用户审阅。用户直接回复，由收件专家解释意图，宿主校验原话、请求关联、版本和范围后执行。用户发送前未展示的请求、含修改/疑问/条件的回复及过期范围不会被当作有效确认。右侧原有范围审阅入口仍可使用。

公司工作台迁移时还需实现 `conversation-store.mjs` 的收件/认领持久化及 `conversation-review.mjs` 的对话确认契约；仅复制提示词不能获得投递、幂等和人工授权保障。

## 共享技能与按需加载

十五个 Skills 对三个角色全部可见，不分配角色专属技能白名单。按具体缺口选择，表格顺序不代表调用顺序：

| 技能 | 方法与适用范围 |
| --- | --- |
| pbs-requirements | 材料拆条、需求初稿、引用及全文覆盖 |
| pbs-scenarios | 客户目标、活动、场景边界与需求关联 |
| pbs-products | 产品匹配、能力缺口、PBS、方案及 BOM 读取 |
| pbs-evidence | 来源、版本、连续引用和证据冲突 |
| pbs-clarification | 未知事项、客户问题和补充影响 |
| pbs-collaboration | 专家咨询、追问、处置及人工介入 |
| [pbs-document-map](skills/pbs-document-map/SKILL.md) | 长标书、多附件、续表、版本关系和解析缺损 |
| [pbs-requirement-quality](skills/pbs-requirement-quality/SKILL.md) | 歧义、复合要求、重复、冲突及无依据扩展 |
| [pbs-interface-boundaries](skills/pbs-interface-boundaries/SKILL.md) | 接口语义、客户自备系统和交付/联调责任 |
| [pbs-acceptance](skills/pbs-acceptance/SKILL.md) | 可核验条件、指标工况及验证证据 |
| [pbs-capacity-sizing](skills/pbs-capacity-sizing/SKILL.md) | 设备、容量、带宽、存储、许可与 BOM 计量 |
| [pbs-option-analysis](skills/pbs-option-analysis/SKILL.md) | 产品组合、自研/外采路径、约束与不确定性比较 |
| [pbs-traceability](skills/pbs-traceability/SKILL.md) | 原文到 PBS 的双向对应、漏项和假覆盖 |
| [pbs-change-impact](skills/pbs-change-impact/SKILL.md) | 变更基准、受影响成果与确认范围 |
| [pbs-low-altitude](skills/pbs-low-altitude/SKILL.md) | 按需选择的低空任务、机库、感知和平台专业核查 |

宿主为每个角色调用同一个 `pbsPreset`，挂载同一 `skills/` 目录。dsh 先将有效技能的名称、描述呈现给模型，模型通过 `skill` 按需加载正文。所有文件使用 `name`、`description` frontmatter，不关闭模型自动调用。技能目录只发现直接子目录中的 `SKILL.md`，不能自行增加角色子目录层级。

共享的是方法和可发现性，业务写权限仍由宿主按角色、活动模式和确认范围强制执行。材料专家可阅读产品技能，咨询活动也可阅读场景技能，但均不能因此越权保存成果。无需每轮加载全部技能或按固定顺序执行。

新增技能使用当前已有业务工具，正文自包含；外部链接仅说明方法来源，不要求业务 Agent 浏览网页、执行 shell 或读取辅助文件。分析记录没有独立台账/API 的，使用本次摘要、咨询答复或实际已支持的成果字段，不能用提示词宣称新增了系统功能。行业核查单独维护，不将低空规则写死进通用角色或其他项目。

当前 preset 的 `watch: false` 表示没有运行中目录热更新；新增/删除技能在下一次宿主激活重新发现，正文后续加载读取当前文件，历史已经加载的内容不会被自动改写。发布指令应在活动边界生效，不承诺正在生成中的模型即时采用新规则。

## 当前运行机制的差距

目标是职责清楚、协作路径由 Agent 决定。当前代码仍有材料完成后的自动交接，咨询方向仍限制为 PBS→理解/材料、理解→材料；材料不能发起咨询，PBS 也尚不能作为咨询目标。角色与技能不虚构这些能力，完整双向协作需继续调整宿主队列、工具目标与循环依赖处理，不能只放宽提示词。

另外，现有抽取适配器及旧抽取路径仍会把 ★/▲ 条款保守标为“必须”，审核策略也使用该标记。技能要求核对原文含义，但调整提示词不会改变这些硬编码规则；后续需将原文要求强度与重点审阅标记解耦，不能把当前“必须”自动解释为正式废标依据。

共享技能可读取产品证据；目前咨询答复的引用校验只接纳项目材料片段，尚未支持产品依据类型。需要返回产品事实引用时必须扩展契约与校验，不得伪造材料来源。

宿主还需实现持久队列、事件、人工确认包、写入屏障、会话恢复与预算，不能只复制指令文件就获得完整协作行为。本地参考实现为 `collaboration-store/approval/tools/api.mjs` 与 `collaboration.mjs`。对话仅展示真实提交的业务问答，不展示模型内部推理。

运行时、SDK 与插件版本必须兼容。项目数据及历史会话另行迁移。
