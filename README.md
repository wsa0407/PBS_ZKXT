# DZ AI Platform

PBS 智能拆解系统：把客户需求（用户描述、会议纪要、招标文件）拆成 PBS 清单，并逐项匹配产品库。

```
app/    应用代码（启动、测试、目录说明见 app/README.md）
docs/   设计方案、技术设计、业务资料准备清单
```

快速开始：

```bash
cp .env.example .env   # 填写 BAI_API_KEY
cd app
npm install
npm start              # http://127.0.0.1:8765/
```

提交前在 `app/` 下执行 `npm run check`（ESLint、前端模板编译检查、离线测试）。
