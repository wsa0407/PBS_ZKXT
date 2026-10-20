# PBS Agent 包

本目录可随 PBS Agent 安装到契约兼容的公司 dsh 工作台。包含指令、Skills、工具契约和评测资料；不依赖当前 Vue 界面、SQLite 或 embedding 服务。

宿主注册 `contracts/tools.mjs` 声明的工具，实现项目绑定、权限、持久化、幂等、版本校验和预算。可用 MCP 提供，传输名字由宿主声明。以 `preset.mjs` 的组合加载身份与 Skills，通用 Agent loop 由 dsh 提供。

本地宿主见仓库 `runtime/`；当前业务适配器位于 `app/server/`。将来公司 RAG 实现 search_evidence/read_evidence/list_document_sections，结构化业务服务实现其余契约，不修改业务 Skills。

三个职责独立维护：

- `roles/materials/AGENTS.md`：材料拆解、原文回查和覆盖。
- `roles/understanding/AGENTS.md`：需求理解、场景和待澄清事项。
- `roles/pbs/AGENTS.md`：确认范围内的PBS编制、产品匹配和多轮求证。

根目录 `AGENTS.md` 保存共用业务规范，`roles.mjs` 定义角色权限及咨询方向。`contracts/collaboration.mjs` 是咨询、答复、人工补充的可迁移契约。角色会话存储隔离；当前宿主顺序调度，允许专家在后续活动中继续咨询。共用 Skills 按需读取，工具权限仍由宿主强制执行。

宿主还需实现持久队列、事件、人工确认包、写入屏障、会话恢复与预算，不能只复制指令文件就获得完整协作行为。本地参考实现为 `collaboration-store/approval/tools/api.mjs` 与 `collaboration.mjs`。对话仅展示真实提交的业务问答，不展示模型内部推理。

运行时、SDK 与插件版本必须兼容。项目数据及历史会话另行迁移。
