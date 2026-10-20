import { CATEGORIES, NON_DELIVERABLE } from "./extract.mjs";
import { normalize } from "./text.mjs";

const SYSTEM = `你是售前解决方案专家。客户回复了一个澄清问题，请把答复转成对项目的具体变更建议，交给人工确认。

可用的变更类型：
1. set_param：客户答复给出了测算参数的确切值。name 只能取参数字典中的值，value 为数字。
2. update_requirement：答复改变了已有需求的内容。给出 code 和新的 text；需要时可改 priority 或 category。
3. add_requirement：答复提出了新需求。给出 text、category、priority。
4. remove_requirement：答复明确说某需求不需要了。给出 code 和 reason。

规则：
- 只依据客户答复，不要推测答复没说的内容。
- quote 填客户答复中支撑这条变更的原话，逐字复制。
- 答复只是确认现有内容、没有带来变化时，changes 给空数组，并在 summary 中说明“确认现有内容，无需变更”。
- category 只能取：${CATEGORIES.join("、")}；priority 只能取：必须、重要、一般。

只输出 JSON：
{"summary":"一句话说明答复带来的影响","changes":[{"type":"set_param","name":"dock_count","value":12,"quote":"..."},{"type":"update_requirement","code":"R003","text":"...","quote":"..."},{"type":"add_requirement","text":"...","category":"功能","priority":"重要","quote":"..."},{"type":"remove_requirement","code":"R010","reason":"...","quote":"..."}]}`;

/**
 * Turn a customer's answer into change proposals. Every change is validated against the
 * project (codes exist, params known, quotes come from the answer) before the user sees it.
 */
export async function proposeChanges({ question, answer, requirements, params, sizing, llm }) {
  const dictionary = Object.entries(sizing.params)
    .map(([name, spec]) => `- ${name}：${spec.label}（${spec.unit}）当前 ${params[name]?.value ?? "未知"}（${params[name]?.status ?? "缺失"}）`)
    .join("\n");
  const related = new Set(question.req_ids ?? []);
  const reqList = requirements
    .filter((r) => r.status !== "已删除" && r.category !== "背景")
    .map((r) => `${related.has(r.code) ? "* " : ""}${r.code} [${r.category}][${r.priority}] ${r.text}`)
    .join("\n");
  const user = `澄清问题：${question.question}
${question.param ? `该问题对应测算参数：${question.param}\n` : ""}客户答复：${answer}

参数字典：
${dictionary}

需求清单（* 为问题关联的需求）：
${reqList}`;

  const data = await llm.json({ step: "answer", system: SYSTEM, user, maxTokens: 3000 });
  const byCode = new Map(requirements.map((r) => [r.code, r]));
  const answerText = normalize(answer);
  const changes = [];
  const dropped = [];
  for (const c of data.changes ?? []) {
    const quoteOk = Boolean(c.quote) && answerText.includes(normalize(c.quote));
    const base = { quote: String(c.quote ?? ""), quoteVerified: quoteOk };
    if (c.type === "set_param") {
      const spec = sizing.params[c.name];
      const value = Number(c.value);
      if (!spec || !Number.isFinite(value)) {
        dropped.push(`参数 ${c.name} 不在字典中或数值无效`);
        continue;
      }
      if (!answerText.includes(String(Math.abs(value)))) {
        dropped.push(`「${spec.label}=${value}」在客户答复中找不到这个数字`);
        continue;
      }
      changes.push({ ...base, type: "set_param", name: c.name, label: spec.label, unit: spec.unit, value, before: params[c.name]?.value ?? null });
    } else if (c.type === "update_requirement" || c.type === "remove_requirement") {
      const req = byCode.get(String(c.code));
      if (!req || req.status === "已删除") {
        dropped.push(`需求 ${c.code} 不存在`);
        continue;
      }
      if (c.type === "remove_requirement") {
        changes.push({ ...base, type: c.type, code: req.code, before: req.text, reason: String(c.reason ?? "") });
      } else {
        if (!c.text) continue;
        changes.push({
          ...base,
          type: c.type,
          code: req.code,
          before: req.text,
          text: String(c.text),
          priority: ["必须", "重要", "一般"].includes(c.priority) ? c.priority : req.priority,
          category: CATEGORIES.includes(c.category) ? c.category : req.category,
        });
      }
    } else if (c.type === "add_requirement") {
      if (!c.text) continue;
      const category = CATEGORIES.includes(c.category) ? c.category : "功能";
      changes.push({
        ...base,
        type: c.type,
        text: String(c.text),
        category,
        priority: ["必须", "重要", "一般"].includes(c.priority) ? c.priority : NON_DELIVERABLE.has(category) ? "一般" : "重要",
      });
    }
  }
  return { summary: String(data.summary ?? ""), changes, dropped };
}
