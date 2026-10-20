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

`host.mjs` 使用官方 `sdk` profile，加载 PBS preset、专属 Skills 和项目绑定的 MCP 服务。默认禁用 shell、任意文件操作、子 Agent、插件管理等与业务无关的模型工具。通用 loop、流式模型处理、会话日志及恢复均使用官方实现。

本地会话与动态配置保存在 `.state/`，已加入 Git 忽略。公司工作台应自行托管这些基础能力，加载同一份 PBS Agent 包与工具契约。

## 验证

```sh
node runtime/scripts/smoke.mjs
node app/scripts/verify-harness.mjs
```

这两个命令会真实调用已配置的 BAI，分别验证官方运行时的工具错误恢复/持久会话，以及合成材料上的需求纠错、场景和 PBS。业务验收脚本默认使用独立临时数据库；显式传入 `--db=/absolute/path.db` 才会向指定数据库新增合成测试项目。

应用层通过 `agent_runs`、`agent_operations` 和 `agent_coverage` 保存运行状态、幂等结果及材料处理记录。停止任务先关闭 dsh、阻止后续写入并等待在途工具结束，再结束项目任务锁。

默认限制每次运行 15 分钟、160 个模型步骤、100 万累计 token；同一工具的同类校验错误重复5次停止尝试。可以通过 `.env.example` 中的预算参数调整。达到预算会保留草稿，不把任务标记成业务项目完成。
