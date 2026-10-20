# PBS Agent 包

本目录可随 PBS Agent 安装到契约兼容的公司 dsh 工作台。包含指令、Skills、工具契约和评测资料；不依赖当前 Vue 界面、SQLite 或 embedding 服务。

宿主注册 `contracts/tools.mjs` 声明的工具，实现项目绑定、权限、持久化、幂等、版本校验和预算。可用 MCP 提供，传输名字由宿主声明。以 `preset.mjs` 的组合加载身份与 Skills，通用 Agent loop 由 dsh 提供。

本地宿主见仓库 `runtime/`；当前业务适配器位于 `app/server/`。将来公司 RAG 实现 search_evidence/read_evidence/list_document_sections，结构化业务服务实现其余契约，不修改业务 Skills。

运行时、SDK 与插件版本必须兼容。项目数据及历史会话另行迁移。
