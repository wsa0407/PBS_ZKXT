import { createHash } from "node:crypto";

export const SCENARIO_FIELDS = ["name", "goal", "actors", "context", "trigger", "activities", "outcomes", "boundaries", "assumptions", "evidence", "links", "supersedes"];
export const DISPOSITIONS = ["场景关联", "跨场景约束", "交付与服务", "商务与资质", "背景", "范围外", "待归类"];
export const LINK_ROLES = ["核心要求", "支撑要求", "适用约束"];
export const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const text = (v) => typeof v === "string" ? v.trim() : "";
const strings = (v) => Array.isArray(v) ? [...new Set(v.map(text).filter(Boolean))] : [];
export const validFieldPath = (path) => /^(name|goal|context|trigger|actors(?:\.\d+)?|activities(?:\.\d+(?:\.text)?)?|outcomes(?:\.\d+)?|boundaries(?:\.\d+)?|assumptions(?:\.\d+(?:\.text)?)?)$/.test(path);

export function defaultDisposition(req) {
  const kind = ({ 背景: "背景", 范围外: "范围外", 商务: "商务与资质", 资质: "商务与资质", 实施: "交付与服务", 服务: "交付与服务" })[req.category] ?? "待归类";
  return { req_id: req.code, kinds: [kind], scenario_ids: [], note: "", edited: false, revision: 0 };
}

/** Validate structural grounding. A valid quote is not a semantic correctness verdict. */
export function validateScenario(raw, { requirements, sources, manual = false, answerEvidence = [] }) {
  const errors = [];
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const key of ["name", "goal", "context", "trigger"]) if (raw[key] !== undefined && typeof raw[key] !== "string") errors.push(`字段 ${key} 必须是文本，未知时留空`);
  for (const key of ["actors", "activities", "outcomes", "boundaries", "assumptions", "evidence", "links"]) if (raw[key] !== undefined && !Array.isArray(raw[key])) errors.push(`字段 ${key} 必须是数组`);
  const reqById = new Map(requirements.filter((r) => r.status !== "已删除").map((r) => [r.code, r]));
  const sourceById = new Map(sources.map((s) => [s.uid, s]));
  const links = [];
  for (const link of Array.isArray(raw.links) ? raw.links : []) {
    if (!link || typeof link !== "object") { errors.push("需求关联必须是对象"); continue; }
    const req = reqById.get(link.req_id);
    if (!req || req.category === "范围外") { errors.push(`需求 ${link.req_id} 不存在、已删除或在范围外`); continue; }
    if (!LINK_ROLES.includes(link.role)) { errors.push(`需求 ${link.req_id} 的关联用途无效`); continue; }
    if (!links.some((l) => l.req_id === req.code)) links.push({ req_id: req.code, role: link.role, req_revision: req.revision ?? 1 });
  }
  const activities = (Array.isArray(raw.activities) ? raw.activities : []).map((a) => ({ text: text(a?.text), req_ids: strings(a?.req_ids) }));
  for (const a of activities) {
    if (!a.text || !a.req_ids.length || a.req_ids.some((id) => !links.some((l) => l.req_id === id))) errors.push("每项业务活动需描述内容并关联场景中的真实需求");
  }
  const evidence = [];
  for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
    if (!e || typeof e !== "object") { errors.push("字段证据必须是对象"); continue; }
    const source = sourceById.get(e.seg_uid);
    if (!validFieldPath(e.field_path ?? "")) { errors.push("证据关联字段无效"); continue; }
    // Existing clarification evidence is server-created and retained by manual edits only.
    if (manual && e.kind === "answer" && answerEvidence.some((trusted) => JSON.stringify(trusted) === JSON.stringify(e))) { evidence.push(e); continue; }
    if (!source || !e.quote || !source.text.includes(e.quote)) { errors.push(`字段 ${e.field_path} 的原文引用不存在`); continue; }
    evidence.push({ field_path: e.field_path, seg_uid: source.uid, quote: e.quote, start: source.text.indexOf(e.quote), end: source.text.indexOf(e.quote) + e.quote.length,
      source_version: hash(source.text), material_id: source.material_id, material_no: source.material_no, material_title: source.material_title,
      source_text: source.text, active: source.active !== false, kind: "material" });
  }
  const data = { name: text(raw.name), goal: text(raw.goal), actors: strings(raw.actors), context: text(raw.context), trigger: text(raw.trigger),
    activities, outcomes: strings(raw.outcomes), boundaries: strings(raw.boundaries),
    assumptions: (Array.isArray(raw.assumptions) ? raw.assumptions : []).map((a) => ({ text: text(a?.text), reason: text(a?.reason) })).filter((a) => a.text),
    evidence, links, supersedes: strings(raw.supersedes) };
  for (const e of evidence) {
    const value = e.field_path.split('.').reduce((value, key) => value?.[key], data);
    if (value === undefined) errors.push(`字段位置 ${e.field_path} 不存在`);
  }
  if (!data.name) errors.push("场景名称不能为空");
  if (!links.length) errors.push("场景至少关联一条有效需求");
  if (!manual && !evidence.length) errors.push("模型生成场景至少要有一处可定位原文");
  if (!manual) {
    const supported = evidence.map((e) => e.quote).join(" ") + links.map((l) => reqById.get(l.req_id).text).join(" ");
    const assertions = [data.name, data.goal, data.context, data.trigger, ...data.activities.map((a) => a.text), ...data.outcomes, ...data.boundaries].join(" ");
    for (const number of assertions.match(/\d+(?:\.\d+)?/g) ?? []) if (!supported.includes(number)) errors.push(`场景中数字 ${number} 没有需求或引用依据`);
  }
  return { data, errors: [...new Set(errors)] };
}
