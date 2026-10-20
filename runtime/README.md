# PBS 本地 dsh 宿主

固定依赖官方 DeepSeek Harness/SDK `0.2.1-rc.2`。运行时不包含 PBS 业务逻辑；业务包在 `../agents/pbs/`，本地业务适配在 `../app/server/agent-adapter.mjs`。

## 安装与启动

要求 Node ≥22.19。仓库根目录执行：

```sh
npm ci --prefix runtime
npm ci --prefix app
npm start --prefix app
```

BAI 与 embedding 沿用仓库根目录 `.env`。密钥仅从环境注入子进程；生成的 profile 配置只记录凭据引用。代理在 dsh 子进程内通过独立 dispatcher 接入。

`host.mjs` 使用官方 `sdk` profile，按角色加载共用规范、独立职责、同一组共享 Skills 和项目绑定的 MCP 服务；未指定角色的受限结构化分析仅加载分析指令与 submit_result 工具，不加载业务 Skills。默认禁用 shell、任意文件操作、子 Agent、插件管理等与业务无关的模型工具。通用 loop、流式模型处理、会话日志及恢复均使用官方实现。

本地会话与动态配置保存在 `.state/`，已加入 Git 忽略。公司工作台应自行托管这些基础能力，加载同一份 PBS Agent 包与工具契约。

## 验证

```sh
node runtime/scripts/smoke.mjs --live
node app/scripts/verify-harness.mjs --live
# 仅为合成测试材料明确授权 PBS 编制：
node app/scripts/verify-harness.mjs --live --approve-test-scope
```

这两个命令必须显式提供 `--live`，会真实调用已配置的 BAI。前者验证工具错误恢复与持久会话；后者走当前协作入口，在合成材料上验证需求、场景和人工确认前不生成 PBS。只有追加 `--approve-test-scope` 才确认本次合成范围并继续 PBS。业务验收脚本始终创建独立临时数据库，不支持向实际项目数据库注入测试数据。离线检查使用 `npm run check --prefix app`。

应用层通过 `collaboration_*` 和 `conversation_*` 表保存活动、角色会话、咨询、收件与认领；`agent_operations` 和 `agent_coverage` 保存幂等结果及材料处理记录。`agent_runs` 仅保留历史兼容。取消执行先关闭 dsh、阻止后续写入并等待在途工具结束，再结束项目任务锁。

默认限制每次运行 15 分钟、160 个模型步骤、100 万累计 token；同一工具的同类校验错误重复5次停止尝试。整轮协作另设 300 万累计 token 上限。可以通过 `.env.example` 中的预算参数调整。达到预算会保留草稿，不把任务标记成业务项目完成。
