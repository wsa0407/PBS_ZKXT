const text = { type: "string", minLength: 1, maxLength: 6000 };
const id = { type: "string", minLength: 1, maxLength: 160 };
const ids = { type: "array", items: id, maxItems: 40 };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: obj(properties, required), annotations: { readOnlyHint: name.startsWith("read_") || name === "collaboration_state", destructiveHint: false, idempotentHint: true } });
export const COLLABORATION_TOOLS = [
  tool("collaboration_state", "读取本次协作阶段、已确认范围、真实咨询与人工补充。身份由宿主绑定。", {}),
  tool("ask_expert", "向另一专家提出具体问题，持久化并立即返回咨询编号。等待答案时结束本次活动，工作台会自动恢复；不要轮询。", { operation_id: id, target: { type: "string", enum: ["materials", "understanding"] }, question: text, references: ids, followup_to: id }, ["operation_id", "target", "question"]),
  tool("submit_expert_answer", "向当前咨询提交真实答复。原文事实必须有已回读并匹配的引用；咨询不允许修改业务成果。", { operation_id: id, consultation_id: id, answer: text, nature: { type: "string", enum: ["source_fact", "human_confirmed", "analysis", "unknown"] }, unknowns: ids, evidence: { type: "array", maxItems: 12, items: obj({ evidence_id: id, document_version: id, quote: text }, ["evidence_id", "document_version", "quote"]) } }, ["operation_id", "consultation_id", "answer", "nature"]),
  tool("record_consultation_outcome", "记录本角色如何使用已答复咨询，references为真实需求/场景/PBS引用，不冒充人工确认。", { operation_id: id, consultation_id: id, outcome: { type: "string", enum: ["adopted", "partial", "rejected", "human_pending"] }, explanation: text, references: ids }, ["operation_id", "consultation_id", "outcome", "explanation"]),
  tool("read_interventions", "读取待处理用户原话并产生实际送达回执。必须先读取才能处理；口头补充不等同正式招标答疑。", {}),
  tool("acknowledge_intervention", "记录人工补充处理结果。adjusted必须提供本次实际成功写入的operation_ids；requires_confirmation必须已有变更卡片；只读回答不得冒称修改成果。", { operation_id: id, intervention_id: id, outcome: { type: "string", enum: ["read_only", "adjusted", "requires_confirmation", "needs_clarification"] }, explanation: text, operation_ids: ids, references: ids }, ["operation_id", "intervention_id", "outcome", "explanation"]),
];
