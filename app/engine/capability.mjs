import { NON_DELIVERABLE } from "./extract.mjs";

export const PRIORITIES = ["必须", "重要", "一般"];

const SYSTEM = `你是业务架构师。任务：把客户需求推演成业务场景，再从场景里的业务活动归纳“业务能力”。

什么是业务能力：业务要具备的本事，用业务语言描述，与具体产品无关。例如“夜间目标发现”“交通事件自动识别”“无人值守起降”，而不是“红外热成像吊舱”“VisionAI”。

规则：
1. 只依据给定的需求和背景，不得凭空增加客户没有提出的内容。
2. 先按“谁（who）、在哪（where）、何时（when）、做什么（what）、为什么（why）”推演场景。每个场景包含若干业务活动。
3. 每条能力必须挂接一个具体的业务活动（activity），不允许没有活动的能力。
4. 每条能力用 req_ids 关联它所服务的需求编号，至少一个。
5. **能力名称和描述中禁止出现任何产品名称、品牌、型号或产品代号**。只讲业务上需要什么。
6. 一条能力只表达一件事。性质相近的需求归并成一条能力，不要把每条需求各变成一条能力，也不要把多件事塞进一条。
7. 背景、商务、资质类需求（以及标为“范围外”的需求）不产生能力。
8. priority：其关联需求中有“必须”的填“必须”，否则按“重要”“一般”。
9. 如果有些需求无法归入任何能力，把它们的编号放进 uncovered，并说明原因。

只输出 JSON：
{"scenes":[{"who":"交警支队","where":"高速公路","when":"全天候","what":"巡逻发现事故","why":"缩短事故响应时间","activities":["自动巡逻","事故发现"]}],
"capabilities":[{"name":"夜间目标发现","description":"夜间在道路上发现车辆和人员","activity":"自动巡逻","req_ids":["R003"],"priority":"必须"}],
"uncovered":[{"req_id":"R010","reason":"..."}]}`;

const productNamePattern = (names) => {
  const parts = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  if (!parts.length) return null;
  return new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
};

/** Names a capability must not contain: every product name in the library, plus its code part (e.g. "SkyOps"). */
export function productNames(products) {
  const names = [];
  for (const p of products) {
    names.push(p.name);
    for (const word of p.name.split(/[\s（）()]+/)) if (/^[A-Za-z][A-Za-z0-9+-]{2,}$/.test(word)) names.push(word);
  }
  return names;
}

export function reqLine(r) {
  const flags = `${r.star ? "★" : ""}${r.triangle ? "▲" : ""}${r.inferred ? "（推断）" : ""}`;
  return `${r.id} [${r.category}][${r.priority}${flags}] ${r.text}`;
}

/**
 * requirements: engine-shaped (id, text, category, priority ...) of the requirements to model.
 * Returns validated capabilities; anything that breaks a rule is dropped with a note.
 */
export async function buildCapabilities({ project, requirements, products, existing = [], llm }) {
  const usable = requirements.filter((r) => !NON_DELIVERABLE.has(r.category) || r.star);
  const reqList = usable.map(reqLine).join("\n");
  const kept = existing.length
    ? `\n\n已由人工确认的能力（保留不变，不要重复，也不要改写）：\n${existing.map((c) => `- ${c.name}（活动：${c.activity}；关联：${c.req_ids.join("、")}）`).join("\n")}`
    : "";
  const user = `项目：${project.name}（客户：${project.customer || "未填"}，行业：${project.industry || "未填"}）

需求清单：
${reqList}${kept}`;

  const data = await llm.json({ step: "capability", system: SYSTEM, user, maxTokens: 6000 });
  const known = new Set(requirements.map((r) => r.id));
  const forbidden = productNamePattern(productNames(products));
  const notes = [];
  const seen = new Set(existing.map((c) => c.name));
  const capabilities = [];

  for (const raw of data.capabilities ?? []) {
    const name = String(raw.name ?? "").trim();
    const activity = String(raw.activity ?? "").trim();
    const description = String(raw.description ?? "").trim();
    if (!name) continue;
    if (!activity) {
      notes.push(`能力「${name}」没有挂接业务活动，已丢弃`);
      continue;
    }
    if (forbidden?.test(`${name}${description}${activity}`)) {
      notes.push(`能力「${name}」中出现了产品名称，业务能力不应涉及产品，已丢弃`);
      continue;
    }
    const reqIds = [...new Set((raw.req_ids ?? []).map(String))].filter((id) => known.has(id));
    if (!reqIds.length) {
      notes.push(`能力「${name}」没有关联到任何真实存在的需求，已丢弃`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    capabilities.push({
      name,
      description,
      activity,
      req_ids: reqIds,
      priority: PRIORITIES.includes(raw.priority) ? raw.priority : "重要",
    });
  }

  const scenes = (data.scenes ?? [])
    .map((s) => ({
      who: String(s.who ?? ""),
      where: String(s.where ?? ""),
      when: String(s.when ?? ""),
      what: String(s.what ?? ""),
      why: String(s.why ?? ""),
      activities: (s.activities ?? []).map(String),
    }))
    .filter((s) => s.what || s.activities.length);

  const covered = new Set([...capabilities, ...existing].flatMap((c) => c.req_ids));
  const uncovered = usable
    .filter((r) => r.priority === "必须" && !covered.has(r.id))
    .map((r) => ({ req_id: r.id, reason: (data.uncovered ?? []).find((u) => String(u.req_id) === r.id)?.reason ?? "模型没有给出对应的业务能力" }));

  return { scenes, capabilities, uncovered, notes };
}
