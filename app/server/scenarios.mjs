import { defaultDisposition, DISPOSITIONS, hash, SCENARIO_FIELDS, validFieldPath, validateScenario } from "../engine/scenario.mjs";
import { getDb, json, now, parse, tx } from "./db.mjs";
import { badRequest, HttpError, notFound } from "./errors.mjs";
import * as repo from "./repo.mjs";

const STATUSES = ["待确认", "已确认", "待复核", "已归档"];
const live = (s) => s.status !== "已归档";

export const answerHash = (answer) => hash(answer).slice(0, 16);
export function saveAnswerSource(projectId, uid, question) {
  getDb().prepare("INSERT OR IGNORE INTO source_snapshots(project_id, uid, data) VALUES (?, ?, ?)")
    .run(projectId, uid, json({ uid, seg_id: `Q${question.id}`, material_id: null, material_no: null, material_title: `澄清 Q${question.id}（${question.answer_source}）`, material_kind: "answer", text: question.answer, active: true }));
}

function rowToScenario(row) {
  return { ...parse(row.data, {}), code: row.code, status: row.status, revision: row.revision, origin: row.origin, edited: Boolean(row.edited), created_at: row.created_at, updated_at: row.updated_at };
}

export function listScenarios(projectId) {
  return getDb().prepare("SELECT * FROM scenarios WHERE project_id = ? ORDER BY code").all(projectId).map(rowToScenario);
}

export function getScenario(projectId, code) {
  const row = getDb().prepare("SELECT * FROM scenarios WHERE project_id = ? AND code = ?").get(projectId, code);
  if (!row) throw notFound("场景需求");
  return rowToScenario(row);
}

export function revisions(projectId, code) {
  getScenario(projectId, code);
  return getDb().prepare("SELECT * FROM scenario_revisions WHERE project_id = ? AND scenario_code = ? ORDER BY revision DESC").all(projectId, code)
    .map((r) => ({ revision: r.revision, reason: r.reason, at: r.created_at, snapshot: parse(r.snapshot, {}) }));
}

function assertVersion(scene, revision) {
  if (!Number.isInteger(revision)) throw badRequest("请携带读取时的场景版本号");
  if (scene.revision !== revision) throw new HttpError(409, `${scene.code} 已被修改，请重新加载后操作`);
}

function write(projectId, scene, reason) {
  const db = getDb();
  const data = Object.fromEntries(SCENARIO_FIELDS.map((k) => [k, scene[k]]));
  if (scene.review_reason) data.review_reason = scene.review_reason;
  db.prepare(`INSERT INTO scenarios(project_id, code, data, status, revision, origin, edited, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, code) DO UPDATE SET
    data = excluded.data, status = excluded.status, revision = excluded.revision, edited = excluded.edited, updated_at = excluded.updated_at`)
    .run(projectId, scene.code, json(data), scene.status, scene.revision, scene.origin, scene.edited ? 1 : 0, scene.created_at ?? now(), now());
  db.prepare("DELETE FROM scenario_requirements WHERE project_id = ? AND scenario_code = ?").run(projectId, scene.code);
  const put = db.prepare("INSERT INTO scenario_requirements(project_id, scenario_code, req_code, role) VALUES (?, ?, ?, ?)");
  for (const link of scene.links) put.run(projectId, scene.code, link.req_id, link.role);
  db.prepare("INSERT INTO scenario_revisions(project_id, scenario_code, revision, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(projectId, scene.code, scene.revision, json(scene), reason, now());
}

function nextCode(projectId) {
  const max = Math.max(0, ...listScenarios(projectId).map((s) => Number(s.code.slice(2)) || 0));
  return `SC${String(max + 1).padStart(3, "0")}`;
}

function validated(projectId, raw, existing) {
  const result = validateScenario(raw, { requirements: repo.listRequirements(projectId), sources: repo.listSourceSnapshots(projectId), manual: true, answerEvidence: existing?.evidence.filter((e) => e.kind === "answer") ?? [] });
  if (result.errors.length) throw badRequest(result.errors.join("；"));
  // Clients cannot fabricate replacement lineage.
  result.data.supersedes = existing?.supersedes ?? [];
  return result.data;
}

export function addScenario(projectId, body) {
  repo.getProject(projectId);
  const data = validated(projectId, body);
  return tx(() => {
    const code = nextCode(projectId);
    write(projectId, { ...data, code, status: "待确认", revision: 1, origin: "人工", edited: true }, "人工新增");
    repo.logEvent(projectId, "场景", `新增 ${code} ${data.name}`);
    repo.touchProject(projectId);
    return { code };
  });
}

export function editScenario(projectId, code, body) {
  return tx(() => {
    const scene = getScenario(projectId, code);
    assertVersion(scene, body.revision);
    const status = body.status ?? "待确认";
    if (!STATUSES.includes(status)) throw badRequest("场景审阅状态无效");
    if (scene.status === "已归档" && !["待确认", "已归档"].includes(status)) throw badRequest("请先恢复归档场景，再审阅和确认");
    if (status === "已归档" && !String(body.reason ?? "").trim()) throw badRequest("归档场景请填写原因");
    const content = Object.fromEntries(SCENARIO_FIELDS.map((key) => [key, body[key] ?? scene[key]]));
    const changed = SCENARIO_FIELDS.some((key) => JSON.stringify(content[key]) !== JSON.stringify(scene[key]));
    if (status === "已确认" && changed) throw badRequest("请先保存修改，再确认当前版本");
    const data = changed ? validated(projectId, content, scene) : content;
    if (status === "已确认") {
      const reqs = repo.listRequirements(projectId, { includeDeleted: false });
      const sources = new Map(repo.listSourceSnapshots(projectId).map((s) => [s.uid, s]));
      if (scene.links.some((l) => !reqs.some((r) => r.code === l.req_id)) || scene.evidence.some((e) => e.kind === "material" && !sources.get(e.seg_uid)?.active)) throw badRequest("有关联需求或来源已失效，请先修正");
    }
    const next = { ...scene, ...data, status, revision: scene.revision + 1, edited: true, review_reason: status === "待复核" ? body.reason : "" };
    write(projectId, next, body.reason || (changed ? "人工修改" : `状态改为${status}`));
    if (changed || status === "已归档" || scene.status === "已归档") flagPbs(projectId, [code], `场景 ${code} 已变更，请复核`);
    repo.logEvent(projectId, "场景", `${code} ${changed ? "已修改，待确认" : status}`);
    repo.touchProject(projectId);
    return next;
  });
}

export function confirmScenarios(projectId, body) {
  if (!Array.isArray(body.scenarios) || !body.scenarios.length) throw badRequest("请选择场景及版本");
  return tx(() => body.scenarios.map((s) => editScenario(projectId, s.code, { revision: s.revision, status: "已确认" })));
}

export function flagPbs(projectId, codes, reason) {
  const scenes = listScenarios(projectId).filter((s) => codes.includes(s.code));
  const reqIds = new Set(scenes.flatMap((s) => s.links.map((l) => l.req_id)));
  const rows = repo.listItems(projectId).filter((i) => i.scenario_ids.some((id) => codes.includes(id)) || i.req_ids.some((id) => reqIds.has(id)));
  for (const row of rows) { row.stale = reason; row.confirmed = false; }
  if (rows.length) repo.saveItems(projectId, rows);
}

function affectedForRequirements(projectId, reqIds, extraCodes = []) {
  const dispositions = dispositionRows(projectId).filter((d) => reqIds.includes(d.req_id) && d.kinds.includes("跨场景约束"));
  const global = dispositions.some((d) => !d.scenario_ids.length);
  const scoped = dispositions.flatMap((d) => d.scenario_ids);
  return listScenarios(projectId).filter((s) => live(s) && (global || scoped.includes(s.code) || extraCodes.includes(s.code) || s.links.some((l) => reqIds.includes(l.req_id))));
}

export function markAffected(projectId, reqIds, reason, extraCodes = []) {
  const affected = affectedForRequirements(projectId, reqIds, extraCodes);
  for (const s of affected) write(projectId, { ...s, status: "待复核", revision: s.revision + 1, review_reason: reason }, reason);
  flagPbs(projectId, affected.map((s) => s.code), reason);
  const items = repo.listItems(projectId).filter((i) => i.req_ids.some((id) => reqIds.includes(id)));
  for (const item of items) { item.stale = reason; item.confirmed = false; }
  if (items.length) repo.saveItems(projectId, items);
}

function dispositionRows(projectId) {
  return getDb().prepare("SELECT * FROM requirement_dispositions WHERE project_id = ?").all(projectId)
    .map((r) => ({ ...parse(r.data, {}), req_id: r.req_code, edited: Boolean(r.edited), revision: r.revision }));
}

function putDisposition(projectId, d, edited = false) {
  getDb().prepare("INSERT INTO requirement_dispositions(project_id, req_code, data, edited) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, req_code) DO UPDATE SET data = excluded.data, edited = excluded.edited, revision = requirement_dispositions.revision + 1")
    .run(projectId, d.req_id, json(d), edited ? 1 : 0);
}

export function editDisposition(projectId, code, body) {
  const req = repo.getRequirement(projectId, code);
  if (body.req_revision !== req.revision) throw new HttpError(409, "需求已变化，请重新加载");
  const current = dispositionRows(projectId).find((d) => d.req_id === code);
  if (body.revision !== (current?.revision ?? 0)) throw new HttpError(409, "处理去向已变化，请重新加载");
  if (!Array.isArray(body.kinds) || !body.kinds.length || body.kinds.some((k) => !DISPOSITIONS.includes(k))) throw badRequest("处理去向无效");
  if (req.category === "范围外" && (body.kinds.length !== 1 || body.kinds[0] !== "范围外")) throw badRequest("范围外需求不能纳入本期");
  const ids = body.scenario_ids ?? [];
  if (!Array.isArray(ids) || ids.some((id) => !listScenarios(projectId).some((s) => s.code === id && live(s)))) throw badRequest("适用场景不存在");
  if (body.kinds.includes("场景关联") && !listScenarios(projectId).some((s) => live(s) && s.links.some((l) => l.req_id === code))) throw badRequest("请先在场景中关联这条需求");
  return tx(() => {
    const previousScopes = affectedForRequirements(projectId, [code]).map((s) => s.code);
    putDisposition(projectId, { req_id: code, kinds: body.kinds, scenario_ids: ids, note: String(body.note ?? "") }, true);
    markAffected(projectId, [code], `需求 ${code} 处理去向已调整`, previousScopes);
    repo.touchProject(projectId);
    return { ok: true };
  });
}

export function scenarioView(projectId) {
  const scenarios = listScenarios(projectId);
  const questions = repo.listQuestions(projectId);
  const requirements = repo.listRequirements(projectId, { includeDeleted: false });
  const reqById = new Map(requirements.map((r) => [r.code, r]));
  const sourceById = new Map(repo.listSourceSnapshots(projectId).map((s) => [s.uid, s]));
  const saved = dispositionRows(projectId);
  const enriched = scenarios.map((s) => {
    const issues = [];
    for (const link of s.links) if (!reqById.has(link.req_id)) issues.push(`${link.req_id} 已删除或替代`);
    for (const e of s.evidence) if (e.kind === "material" && !sourceById.get(e.seg_uid)?.active) issues.push(`原文 ${e.seg_uid} 已移除，保留历史依据`);
    for (const field of ["goal", "actors", "trigger", "outcomes"]) if (!s[field]?.length) issues.push(`${({ goal: "目标", actors: "角色", trigger: "触发条件", outcomes: "预期结果" })[field]}未明确`);
    return { ...s, issues, open_questions: questions.filter((q) => q.scenario_ids.includes(s.code) && ["待处理", "待答复", "已答复"].includes(q.status)).map((q) => q.id) };
  });
  const dispositions = requirements.map((r) => {
    const d = saved.find((d) => d.req_id === r.code) ?? defaultDisposition(r);
    const linked = scenarios.filter((s) => live(s) && s.links.some((l) => l.req_id === r.code)).map((s) => s.code);
    let kinds = d.kinds.filter((k) => k !== "场景关联");
    if (linked.length) kinds = [...kinds.filter((k) => k !== "待归类"), "场景关联"];
    if (!kinds.length) kinds = ["待归类"];
    const invalidScopes = d.scenario_ids.filter((id) => !scenarios.some((s) => s.code === id && live(s)));
    if (invalidScopes.length) kinds.push("待归类");
    return { ...d, kinds: [...new Set(kinds)], linked_scenarios: linked, req_revision: r.revision, invalid_scopes: invalidScopes };
  });
  const active = enriched.filter(live);
  const latest = getDb().prepare("SELECT result FROM scenario_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId);
  return { scenarios: enriched, dispositions, scenarioCoverage: { total: requirements.length, classified: dispositions.filter((d) => !d.kinds.includes("待归类")).length, unmapped: dispositions.filter((d) => d.kinds.includes("待归类")).map((d) => d.req_id), pending: active.filter((s) => s.status !== "已确认").length, confirmed: active.filter((s) => s.status === "已确认").length, active: active.length }, scenarioNotes: parse(latest?.result, {}).notes ?? [] };
}

/** Agent tool boundary: deterministic validation and persistence, with no model call. */
export function submitAgentScenario(projectId, raw) {
  const result = validateScenario(raw, { requirements: repo.listRequirements(projectId), sources: repo.listSourceSnapshots(projectId) });
  if (result.errors.length) throw badRequest(result.errors.join("；"));
  const same = listScenarios(projectId).find((s) => live(s) && s.name === result.data.name);
  if (same) return { code: same.code, kept: true, reason: "已存在同名场景，保留当前版本；修改需显式审阅" };
  const code = nextCode(projectId);
  write(projectId, { ...result.data, code, revision: 1, status: "待确认", origin: "系统", edited: false }, "Agent提交场景草稿");
  repo.touchProject(projectId);
  return { code, revision: 1 };
}

/** Restructuring keeps an explicit replacement graph and never silently drops a requirement. */
export function restructure(projectId, body) {
  if (!Array.isArray(body.originals) || !body.originals.length || !Array.isArray(body.replacements) || !body.replacements.length) throw badRequest("请提供原场景与替代场景");
  return tx(() => {
    const originals = body.originals.map((item) => {
      const s = getScenario(projectId, item.code); assertVersion(s, item.revision);
      if (!live(s)) throw badRequest("不能重复替代已归档场景");
      return s;
    });
    if (new Set(originals.map((s) => s.code)).size !== originals.length) throw badRequest("原场景重复");
    const replacementData = body.replacements.map((raw) => validated(projectId, raw, { evidence: originals.flatMap((s) => s.evidence), supersedes: [] }));
    const missing = originals.flatMap((s) => s.links.map((l) => l.req_id)).filter((id) => !replacementData.some((d) => d.links.some((l) => l.req_id === id)));
    if (missing.length) throw badRequest(`合并或拆分不能遗漏需求：${[...new Set(missing)].join("、")}`);
    const codes = [];
    for (const data of replacementData) {
      const code = nextCode(projectId); codes.push(code);
      write(projectId, { ...data, supersedes: originals.map((s) => s.code), code, revision: 1, status: "待确认", origin: "人工", edited: true }, "合并或拆分场景");
    }
    for (const old of originals) {
      write(projectId, { ...old, status: "已归档", revision: old.revision + 1, edited: true }, `已由 ${codes.join("、")} 替代`);
      flagPbs(projectId, [old.code], `场景 ${old.code} 已由 ${codes.join("、")} 替代，请复核`);
      for (const q of repo.listQuestions(projectId).filter((q) => q.scenario_ids.includes(old.code))) repo.updateQuestion(projectId, q.id, { scenario_ids: [...new Set([...q.scenario_ids, ...codes])] });
    }
    const oldCodes = originals.map((s) => s.code);
    for (const d of dispositionRows(projectId).filter((d) => d.scenario_ids.some((id) => oldCodes.includes(id)))) {
      putDisposition(projectId, { ...d, scenario_ids: [...new Set([...d.scenario_ids.filter((id) => !oldCodes.includes(id)), ...codes])], note: `${d.note}；场景合并或拆分后，请复核约束适用范围` }, true);
    }
    repo.touchProject(projectId);
    repo.logEvent(projectId, "场景", `${originals.map((s) => s.code).join("、")} 由 ${codes.join("、")} 替代`);
    return { codes };
  });
}

export function validateQuestionLinks(projectId, body) {
  const ids = body.scenario_ids ?? [];
  const reqIds = body.req_ids ?? [];
  const paths = body.field_paths ?? [];
  if (!Array.isArray(ids) || ids.some((code) => !listScenarios(projectId).some((s) => s.code === code && live(s)))) throw badRequest("关联场景不存在");
  if (!Array.isArray(reqIds) || reqIds.some((code) => !repo.listRequirements(projectId, { includeDeleted: false }).some((r) => r.code === code))) throw badRequest("关联需求不存在");
  if (!Array.isArray(paths) || paths.some((p) => !validFieldPath(p))) throw badRequest("关联字段无效");
  return { scenario_ids: ids, req_ids: reqIds, field_paths: paths };
}

export function applyScenarioChange(projectId, change, question) {
  const scene = getScenario(projectId, change.code);
  assertVersion(scene, change.before_revision);
  if (!validFieldPath(change.field_path) || change.field_path.includes(".")) throw badRequest("答复只能更新一个完整场景字段");
  const raw = { ...scene, [change.field_path]: change.value };
  const data = validated(projectId, raw, scene);
  const evidence = { kind: "answer", field_path: change.field_path, question_id: question.id, quote: change.quote, answer_snapshot: question.answer, answer_source: question.answer_source, at: now() };
  write(projectId, { ...scene, ...data, evidence: [...data.evidence.filter((e) => e.field_path !== change.field_path), evidence], revision: scene.revision + 1, status: "待复核", edited: true }, `应用澄清 Q${question.id}`);
  flagPbs(projectId, [scene.code], `场景 ${scene.code} 已按澄清答复修改，请复核`);
}
