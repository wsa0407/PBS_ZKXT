# 阿里云原生向量接口接入

按用户提供的工作空间原生接口与模型qwen3.7-text-embedding接入。EMBED_PROVIDER明确区分openai与dashscope；现有OpenAI兼容服务和未配置独立地址时的B.AI向量回退保留。向量密钥、工作空间地址仅在本地.env保存，不写入Git。

DashScope以input.texts传入原始文本，parameters中声明text_type=query/document与output_type=dense。查询使用模型支持的instruct参数，不在原生文本前添加OpenAI兼容Qwen3的字符串前缀。结果按text_index恢复顺序，并检查索引唯一、非空有限数值与维度一致。qwen3.7每批最多20条，其他原生文本向量模型按10条分批。原生地址不探测不存在的/models路径。

向量缓存使用服务地址、协议、模型和文档编码策略的摘要作为命名空间，服务切换后重新生成。查询与文档维度不匹配时明确失败并降级到关键词检索，避免NaN排名。错误只保留HTTP状态和错误代码，不回显接口返回的原始文本。

参考资料：https://www.alibabacloud.com/help/en/model-studio/text-embedding-synchronous-api 和 https://www.alibabacloud.com/help/en/model-studio/embedding 。

验证：真实原生接口返回HTTP 200与1024维向量；使用两项人工MOCK产品完成混合检索，结果存在向量得分，重复搜索复用文档向量缓存。离线测试新增原生请求、全文本接口地址、query/document、乱序恢复、分批、非法响应、缓存隔离与维度失配降级检查；ESLint、Vue模板及86项测试全部通过。

临时预览库启动只发送固定的“连通性测试”进行探测，不在启动时上传产品库。只读检查确认临时库23个启用产品均匹配本任务的MOCK/公开参考包，启用产品手册数为0。初次启动被自动审批以潜在私有资料发送风险拦截；补充这些代码与数据证据后重试通过，预览运行在混合检索模式。未对真实客户材料调用外部向量服务。
