import { NON_DELIVERABLE } from "./extract.mjs";
import { CONFIRMED, triggeredRules } from "./sizing.mjs";
import { dice } from "./text.mjs";

export const IMPACTS = ["影响废标风险", "影响报价", "影响方案"];

const SYSTEM = `你是经验丰富的售前解决方案专家。阅读需求清单，找出“不问清楚就没法准确报价或设计方案”的地方，生成要向客户澄清的问题。

关注：
1. 范围模糊的说法，例如“相关系统”“适当扩展”“等”“具体在实施阶段确定”。
2. 责任边界不清，例如谁提供材料、谁负责供电土建、谁承担费用。
3. 指标缺少测量口径，例如准确率怎么测、由谁测。
4. 同一事项在不同地方说法不一致。
5. 客户诉求与产品能力的冲突（见“已知风险”），需要客户确认能否调整要求。

规则：
- 已经在“需求原文”或“已确定参数”里写明的内容，不要再问。
- 每个问题必须关联具体需求 ID（req_ids），并说明为什么要问（reason）。
- impact 只能取：${IMPACTS.join("、")}。
- suggested_answer 给出客户不回复时我们建议采用的默认假设，必须与原文一致。
- 每个问题不超过 80 字，一个问题只问一件事。
- 不要重复“已有问题”里已经覆盖的内容。最多 6 个问题，按重要程度排序。

只输出 JSON：{"questions":[{"req_ids":["R010"],"question":"...","reason":"...","impact":"影响报价","suggested_answer":"..."}]}`;

function checklistQuestions({ doc, industry, checklists }) {
  const text = doc.fullText;
  const out = [];
  for (const item of checklists.items) {
    const applies = item.industries.includes("*") || item.industries.includes(industry);
    if (!applies) continue;
    if (item.when && !item.when.some((k) => text.includes(k))) continue;
    if (item.keywords.some((k) => text.includes(k))) continue;
    out.push({ source: "行业检查清单", topic: item.topic, req_ids: [], question: item.question, reason: `检查项「${item.topic}」在材料中没有提到`, impact: item.impact, suggested_answer: "" });
  }
  return out;
}

// Parameters that feed a rule this project needs (used by a PBS line, or triggered by the text) but are not confirmed.
export function paramQuestions({ resolved, leaves = [], sizing, text = "" }) {
  const needs = new Map();
  const add = (rule) => {
    for (const name of rule.inputs) needs.set(name, [...(needs.get(name) ?? []), rule.name]);
  };
  const ruleById = new Map(sizing.rules.map((r) => [r.id, r]));
  for (const leaf of leaves) if (leaf.sizing_rule && ruleById.has(leaf.sizing_rule)) add(ruleById.get(leaf.sizing_rule));
  for (const { rule } of triggeredRules(text, resolved, sizing)) add(rule);

  const out = [];
  for (const [name, users] of needs) {
    const param = resolved[name];
    if (!param || CONFIRMED.has(param.status)) continue;
    const affects = [...new Set(users)].join("、");
    let question;
    if (param.status.startsWith("多处取值不一致")) {
      const detail = param.candidates.map((c) => `${c.seg_id} 写 ${c.value}`).join("，");
      question = `「${param.label}」多处说法不同（${detail}），测算以哪个为准？`;
    } else if (param.status === "按规则推算") {
      question = `材料没有直接给出「${param.label}」，按经验规则推算为 ${param.value}${param.unit ?? ""}，请确认实际数量。`;
    } else if (param.value === null) {
      question = `材料没有给出「${param.label}」，无法测算数量，请向客户确认。`;
    } else {
      question = `材料没有给出「${param.label}」，暂按 ${param.value}${param.unit ?? ""} 估算，请向客户确认。`;
    }
    out.push({
      source: "测算参数检查",
      topic: param.label,
      param: name,
      req_ids: [...new Set(param.candidates.map((c) => c.req_id))],
      question,
      reason: `直接影响「${affects}」的数量`,
      impact: "影响报价",
      suggested_answer: param.value === null ? "" : `按 ${param.value}${param.unit ?? ""} 测算`,
    });
  }
  return out;
}

export function isDuplicate(question, existing) {
  return existing.some((q) => dice(q.question, question) >= 0.45 || (q.topic && question.includes(q.topic)));
}

/** existing: questions already in the project that must be kept; new ones are deduplicated against them. */
export async function buildClarifications({ doc, industry, requirements, resolved, leaves = [], conflicts = [], checklists, sizing, llm, existing = [] }) {
  const questions = [];
  const keep = (q) => {
    if (isDuplicate(q.question, [...existing, ...questions])) return;
    questions.push(q);
  };
  checklistQuestions({ doc, industry, checklists }).forEach(keep);
  paramQuestions({ resolved, leaves, sizing, text: doc.fullText }).forEach(keep);

  const reqList = requirements
    .filter((r) => r.category !== "背景")
    .map((r) => `${r.id} [${r.category}][${r.priority}${r.star ? "★" : ""}] ${r.text}${r.quote && r.quote !== r.text ? `（原文：${r.quote}）` : ""}`)
    .join("\n");
  const known = Object.values(resolved)
    .filter((p) => CONFIRMED.has(p.status))
    .map((p) => `- ${p.label}：${p.value}${p.unit ?? ""}`)
    .join("\n");
  const risks = conflicts.map((c) => `- ${c.product_name} 与 ${c.req_id} 冲突：${c.evidence}`).join("\n");
  const asked = [...existing, ...questions];
  const user = `项目：${doc.title || "（未命名）"}

需求原文：
${reqList}

已确定参数：
${known || "（无）"}

已知风险：
${risks || "（无）"}

已有问题：
${asked.map((q) => `- ${q.question}${q.answer ? `（客户已答复：${q.answer}）` : ""}`).join("\n") || "（无）"}`;

  const data = await llm.json({ step: "clarify", system: SYSTEM, user, maxTokens: 4000 });
  const reqIds = new Set(requirements.filter((r) => !NON_DELIVERABLE.has(r.category) || r.star).map((r) => r.id));
  for (const q of data.questions ?? []) {
    if (!q.question) continue;
    keep({
      source: "模型识别",
      topic: "",
      req_ids: (q.req_ids ?? []).filter((id) => reqIds.has(id)),
      question: String(q.question),
      reason: String(q.reason ?? ""),
      impact: IMPACTS.includes(q.impact) ? q.impact : "影响方案",
      suggested_answer: String(q.suggested_answer ?? ""),
    });
  }

  const order = Object.fromEntries(IMPACTS.map((x, i) => [x, i]));
  return questions.sort((a, b) => order[a.impact] - order[b.impact]);
}
