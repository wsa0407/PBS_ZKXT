export const CONTRACT_VERSION = "1.0.0";
const str = { type: "string", maxLength: 12000 };
const short = { type: "string", minLength: 1, maxLength: 160 };
const integer = { type: "integer", minimum: 0 };
const strings = { type: "array", items: short, maxItems: 100 };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const list = (items, maxItems = 30) => ({ type: "array", items, maxItems });
const loose = { type: "object", additionalProperties: true };
const operation = { operation_id: short };
const tool = (name, description, properties, required = [], write = false) => ({ name, description, inputSchema: object(properties, required), annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: true } });
const requirement = object({ evidence_id: short, text: str, quote: str, category: { type: "string", enum: ["功能", "性能", "环境", "安全", "信创", "集成", "实施", "服务", "商务", "资质", "背景", "范围外"] }, priority: { type: "string", enum: ["必须", "重要", "一般"] }, inferred: { type: "boolean" }, params: list(object({ name: short, value: { type: "number" }, quote: str }, ["name", "value", "quote"])) }, ["evidence_id", "text", "quote", "category", "priority"]);
const scenario = object({ name: str, goal: str, actors: strings, context: str, trigger: str,
  activities: list(object({ text: str, req_ids: strings }, ["text", "req_ids"])), outcomes: strings, boundaries: strings,
  assumptions: list(object({ text: str, reason: str }, ["text", "reason"])),
  links: list(object({ req_id: short, role: { type: "string", enum: ["核心要求", "支撑要求", "适用约束"] } }, ["req_id", "role"])),
  evidence: list(object({ field_path: short, seg_uid: short, quote: str }, ["field_path", "seg_uid", "quote"])),
}, ["name", "links", "evidence"]);
const pbsItem = object({ name: str, parent: short, source: { type: "string", enum: ["自有产品", "外采", "自研", "服务"] },
  product_ref: { type: ["string", "null"] }, req_ids: strings, scenario_ids: strings, matched_capabilities: strings, spec: str, basis: str,
  qty: { type: ["number", "null"] }, qty_quote: str, unit: short, sizing_rule: { type: ["string", "null"] }, evidence_chunks: list(integer),
  blocked_by: { ...object({ product_ref: short, limit: str }, ["product_ref", "limit"]), description: "仅用于另行交付的外采/自研缺口任务，引用无法满足要求的产品；不能与本行product_ref相同。产品自身使用条件写入spec/basis，不填这里。" },
}, ["name", "parent", "source", "req_ids"]);

export const TOOLS = [
  tool("project_state", "读取绑定项目的真实状态、材料目录、参数字典、成果版本和业务分组。首先调用。", {}),
  tool("list_document_sections", "分页枚举整份标书的原文片段与处理状态；不能以Top-K替代全文覆盖。", { document_id: short, cursor: integer, limit: { type: "integer", minimum: 1, maximum: 30 } }, ["document_id"]),
  tool("read_document_batch", "按原文顺序批量读取片段。后续分页携带上页document_version和next_cursor。完整拆解优先用此工具。", { document_id: short, document_version: short, cursor: short, limit: { type: "integer", minimum: 1, maximum: 60 } }, ["document_id"]),
  tool("read_evidence", "按稳定来源ID读取原文及相邻片段，核对版本。", { evidence_id: short, document_version: short, neighbors: { type: "integer", minimum: 0, maximum: 3 } }, ["evidence_id"]),
  tool("search_evidence", "检索项目材料或公司产品知识，命中不是完整覆盖证明。", { query: str, domain: { type: "string", enum: ["materials", "products"] }, limit: { type: "integer", minimum: 1, maximum: 12 } }, ["query", "domain"]),
  tool("list_requirements", "分页读取已保存的真实原始需求；unverified_only可只列需要修复原文引用的项。", { cursor: integer, limit: { type: "integer", minimum: 1, maximum: 50 }, unverified_only: { type: "boolean" } }),
  tool("list_scenarios", "分页读取场景全文、来源和需求映射。", { cursor: integer, limit: { type: "integer", minimum: 1, maximum: 20 } }),
  tool("list_pbs", "分页读取现有PBS明细、产品关联、数量依据和待审状态。", { cursor: integer, limit: { type: "integer", minimum: 1, maximum: 30 } }),
  tool("submit_requirements", "校验并保存原始需求初稿，逐项返回accepted/errors。失败项修正后用新operation_id再次提交；已成功项不重复提交。", { ...operation, document_id: short, document_version: short, requirements: list(requirement), ignored: list(object({ evidence_id: short, reason: str }, ["evidence_id", "reason"])) }, ["operation_id", "document_id", "document_version", "requirements"], true),
  tool("submit_scenarios", "校验来源和需求关联，保存场景初稿。必须填写links:[{req_id,role}]和evidence:[{field_path,seg_uid,quote}]。expected_version取project_state的workspace_version或上次提交返回的新版本。", { ...operation, expected_version: short, scenarios: list(scenario, 12) }, ["operation_id", "expected_version", "scenarios"], true),
  tool("submit_questions", "保存需要客户确认的问题，关联真实需求和场景，不自行回答。", { ...operation, questions: list(object({ question: str, reason: str, impact: { type: "string", enum: ["影响方案", "影响报价", "影响废标风险"] }, req_ids: strings, scenario_ids: strings, field_paths: strings }, ["question", "reason", "impact"])) }, ["operation_id", "questions"], true),
  tool("read_product", "读取真实产品的能力、限制、资料和BOM组成。", { product_id: short }, ["product_id"]),
  tool("submit_pbs", "分批合并PBS草稿，校验来源、约束、需求与场景、数量。同名更新未人工修改的草稿；其他项和人工成果保留。删除须另提人工变更。expected_version取project_state的pbs_version。", { ...operation, expected_version: short, items: list(pbsItem, 80) }, ["operation_id", "expected_version", "items"], true),
  tool("submit_solutions", "将已保存PBS产品项自由组合为本客户的解决方案，不写入共享产品库。expected_version取project_state的pbs_version。", { ...operation, expected_version: short, solutions: list(object({ id: short, name: str, req_ids: strings, scenario_ids: strings, item_ids: list(integer), design_notes: str }, ["id", "name", "req_ids", "scenario_ids", "item_ids"])) }, ["operation_id", "expected_version", "solutions"], true),
  tool("run_report", "检查已保存成果、文档覆盖、引用、需求关联、PBS缺口与待审问题。", {}),
  tool("propose_change", "用户要求修改或确认现有成果时提交人工变更卡片，不直接覆盖已有成果。", { ...operation, action: loose }, ["operation_id", "action"], true),
  tool("finish_task", "记录本次工作结果。以校验报告决定草稿状态，不能确认业务需求或标记项目完成。", { summary: str, remaining: strings }, ["summary"]),
];

// Transport-independent boundary validation; hosts must enforce it before every execution.
export function validateArguments(schema, value, path = "arguments") {
  if (Array.isArray(schema.type)) {
    for (const type of schema.type) {
      try { validateArguments({ ...schema, type }, value, path); return; } catch { /* Try the next declared type. */ }
    }
    throw new Error(`${path} 类型无效`);
  }
  if (schema.type === "null") { if (value !== null) throw new Error(`${path} 必须为null`); return; }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须为对象`);
    for (const key of schema.required ?? []) if (value[key] === undefined) throw new Error(`${path}.${key} 必填`);
    for (const [key, v] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validateArguments(child, v, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} 不允许`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path} 数组无效或过大`);
    value.forEach((v, i) => validateArguments(schema.items, v, `${path}[${i}]`));
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new Error(`${path} 文本无效`);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${path} 数值无效`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} 必须为布尔值`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} 不在允许范围`);
}
