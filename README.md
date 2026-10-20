# PBS 专家工作台

将客户材料整理为有来源依据的需求与业务场景，经人工确认后，由 PBS 专家映射产品能力、组合项目解决方案和产品清单。

## 启动

需要 Node.js ≥ 22.19。

```sh
cp .env.example .env
# 在 .env 中配置 BAI_API_KEY 和独立的向量服务参数
npm ci --prefix runtime
npm ci --prefix app
npm start --prefix app
# http://127.0.0.1:8765/
```

默认数据库为 `app/data/app.db`；`APP_DB`、`HOST`、`PORT` 可以覆盖。根目录 `.env` 自动加载，外部环境变量优先。真实数据、凭据与运行会话不入库。

## 工程入口

| 目录 | 职责 |
| --- | --- |
| `agents/pbs/` | 三个角色的指令、共享 Skills、工具契约、行为评测资料 |
| `runtime/` | 固定版本的官方 dsh 宿主、MCP 传输、会话与模型连接 |
| `app/server/` | 专家协作、人工授权、业务服务、数据库、RAG 和 HTTP |
| `app/engine/` | 来源、需求、场景、数量和产品规则；无数据库或界面依赖 |
| `app/shared/` | 前后端共用的状态、提及解析、导航与展示语义 |
| `app/web/` | Vue 工作台及交互 |
| `app/catalogs/` | 可独立维护的行业示例产品和 BOM |
| `app/test/` | 当前入口和业务边界的离线测试 |

## 开发与验证

```sh
npm run check --prefix app
```

包含全仓 ESLint、模块依赖/循环检查、角色与 Skill 契约检查、Vue 模板编译和离线测试，不调用真实模型。

- [研发规则](AGENTS.md)
- [当前架构与业务边界](docs/architecture.md)
- [本次清理与核查记录](docs/2026-10-21-repository-audit.md)
- [Agent 包与迁移契约](agents/pbs/README.md)
- [运行时与真实模型验收](runtime/README.md)
- [产品/BOM 数据维护](app/catalogs/README.md)
- [文档索引与历史设计](docs/README.md)
