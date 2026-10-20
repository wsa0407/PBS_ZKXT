# PBS 应用

安装与启动见[仓库 README](../README.md)，现行规范见[架构说明](../docs/architecture.md)。

## 使用流程

1. 产品库维护产品、能力、限制和 BOM；行业示例数据是独立数据包。
2. 项目工作区包含材料、需求理解、PBS 和导出。需求条目、业务场景、待澄清事项属于同一需求理解工作区。
3. 上传材料或在对话中提供原话。材料专家整理来源和需求，需求理解专家组织场景与疑点；按职责认领，不要求所有专家每轮都执行。
4. 在对话里审阅本轮明确范围并直接回复确认。单条需求描述确认不等于批准本轮 PBS 执行。
5. PBS 专家在批准范围内编制、选型和求证。确认前仍可交流；范围变化后需要重新确认。
6. 产品自由组合为项目解决方案，BOM 展示产品组成。导出前查看来源、数量和未完成事项；草稿仍可导出，检查状态保留在文件中。

## 模型与检索配置

根目录 `.env` 提供 BAI_API_KEY、BAI_BASE_URL、APP_MODEL；界面可选择对话模型。
对话和结构化分析都通过 dsh，`app/lib/bai_client.mjs` 仅承担模型列表和向量兼容接口。

向量服务独立配置 EMBED_PROVIDER、EMBED_BASE_URL、EMBED_API_KEY、EMBED_MODEL。
`openai` 使用兼容接口；`dashscope` 使用阿里云原生接口，可填工作空间 `/api/v1` 根地址或完整 embedding 地址。
`APP_EMBED=off` 强制关键词检索；向量不可用时自动回退。`HTTPS_PROXY`/`HTTP_PROXY` 按运行环境配置。
旧的 APP_LLM_CACHE 已停用，不能用它推定 dsh 会缓存模型结果。

## 检查

```sh
npm run check --prefix app
# 或在 app 目录内：npm run check
```

`test/journey.test.mjs` 通过当前 HTTP 对话入口验证材料、理解、人工确认、PBS 和导出。
其他核心测试验证引用、版本、幂等、角色权限、协作恢复、数量、人工修改保护和迁移。
离线测试使用脚本模型；真实模型质量及实际文档解析质量需另行验收。

`seed/` 中部分旧规则和产品用于历史项目引用、迁移与测试，不是当前产品库的数据源。
不要在清理代码时删除已存项目依赖的数据；新行业示例维护方式见 [catalogs/README.md](catalogs/README.md)。
