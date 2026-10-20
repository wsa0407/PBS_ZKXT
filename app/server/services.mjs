import { readFileSync } from "node:fs";
import { NON_DELIVERABLE, collectParams } from "../engine/requirements.mjs";
import { proposeChanges } from "../engine/answer.mjs";
import { draftProductFromManual } from "../engine/product_doc.mjs";
import {
  assignCodes,
  basisLevel,
  checkConflicts,
  createContext,
  enforceLeaves,
  findUncovered,
  matchOf,
  normalizeLeaf,
  rematchLeaf,
} from "../engine/pbs.mjs";
import { segmentText } from "../engine/segment.mjs";
import { normalize } from "../engine/text.mjs";
import { applySizing, CONFIRMED, resolveParams } from "../engine/sizing.mjs";
import { assignReviewTiers, runAudit } from "../engine/audit.mjs";
import { hash } from "../engine/scenario.mjs";
import { usesSingleLicense, DELIVERY_SOURCES } from "../engine/catalog.mjs";
import * as catalog from "./catalog.mjs";
import * as projectSolutions from "./project-solutions.mjs";
import { tx } from "./db.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import * as repo from "./repo.mjs";
import * as rag from "./rag.mjs";
import * as scenarios from "./scenarios.mjs";
import { assertProjectApproval } from "./understanding-scope.mjs";

export const MATERIAL_KINDS = { tender: "招标文件", minutes: "会议纪要", oral: "用户描述", other: "其他材料" };

// ---------- adapters between DB rows and engine shapes ----------

function engineReq(r) {
  return {
    id: r.code,
    seg_id: r.seg_uid,
    text: r.text,
    quote: r.quote,
    quoteVerified: r.quote_verified,
    category: r.category,
    priority: r.priority,
    inferred: r.inferred,
    star: r.star,
    triangle: r.triangle,
    params: r.params,
    rejectedParams: r.rejected_params,
    origin: r.origin,
    answer_evidence: r.answer_evidence,
  };
}

function engineSegments(segments) {
  return segments.map((s) => ({ id: s.uid, chapter: s.chapter, text: s.text, star: s.star, triangle: s.triangle }));
}

function leafFromItem(item) {
  return { ...item, qtyBasis: item.qty_basis, repairs: item.repairs ?? [] };
}

function projectText(projectId, reqs) {
  const materials = repo.listMaterials(projectId).map((m) => repo.getMaterial(projectId, m.id).text);
  const added = reqs.filter((r) => r.origin !== "系统").map((r) => r.text);
  return [...materials, ...added].join("\n");
}

// ---------- materials ----------

export function addMaterial(projectId, { kind, title, text, fileName, description = "" }) {
  const clean = String(text ?? "").trim();
  if (clean.length < 20) throw badRequest("材料内容太短，请至少输入 20 个字");
  const inferred = !kind;
  if (inferred) {
    const heading = `${title ?? ""}\n${clean.slice(0, 2000)}`;
    kind = /招标文件|投标人须知|采购需求|招标需求/.test(heading) ? "tender" : /会议纪要|访谈纪要|会议记录/.test(heading) ? "minutes" : "other";
  }
  if (!MATERIAL_KINDS[kind]) throw badRequest("材料类型无效");
  const doc = segmentText(clean);
  doc.meta = { ...doc.meta, description: String(description).trim(), kind_inferred: inferred };
  if (!doc.segments.length) throw badRequest("没有识别到任何文字内容");
  const name = String(title ?? "").trim() || fileName?.replace(/\.[^.]+$/, "") || doc.title || MATERIAL_KINDS[kind];
  const id = repo.addMaterial(projectId, { kind, title: name, fileName, text: clean, doc });
  repo.logEvent(projectId, "材料", `添加材料「${name}」（${MATERIAL_KINDS[kind]}，${doc.segments.length} 个片段）`);
  return id;
}

// ---------- recompute: pure rules, runs after every change ----------

const PARAM_SOURCE_LABEL = { 客户答复: "客户答复", 人工: "人工设定" };

/**
 * Builds the full project view: parameters, quantities, coverage, conflicts, audit, review tiers.
 * With `reason`, quantities that changed are written back and the lines are flagged for review.
 */
export function computeState(projectId, { reason = "", persist = true } = {}) {
  const config = catalog.runtimeConfig(projectId);
  const { sizing, template } = config;
  const project = repo.getProject(projectId);
  const parameterLabel = (p) => ({ ...p, label: sizing.params[p.name]?.label ?? p.label ?? p.name, unit: sizing.params[p.name]?.unit ?? p.unit ?? "" });
  const allReqs = repo.listRequirements(projectId).map((r) => ({ ...r, params: r.params.map(parameterLabel), rejected_params: r.rejected_params.map(parameterLabel) }));
  const active = allReqs.filter((r) => r.status !== "已删除");
  const engineReqs = active.map(engineReq);
  const segments = repo.listSegments(projectId);
  const fullText = projectText(projectId, active);
  const resolved = resolveParams(collectParams(engineReqs), sizing, repo.listOverrides(projectId));

  const items = repo.listItems(projectId);
  const activeCodes = new Set(active.map((r) => r.code));
  const allCaps = repo.listCapabilities(projectId);
  const liveCaps = allCaps.filter((c) => c.status !== "已删除");
  const liveCapCodes = new Set(liveCaps.map((c) => c.code));
  const leaves = items.map((item) => ({
    ...leafFromItem(item),
    req_ids: item.req_ids.filter((id) => activeCodes.has(id)),
    capability_ids: item.capability_ids.filter((id) => liveCapCodes.has(id)),
  }));
  const before = new Map(leaves.map((l) => [l.id, l.qty]));
  applySizing(
    leaves.filter((l) => !l.manual_qty && !l.input_scope?.length),
    resolved,
    sizing,
  );
  const scopeParams = new Map();
  for (const leaf of leaves.filter((l) => !l.manual_qty && l.input_scope?.length)) {
    const key = leaf.input_scope.join(",");
    if (!scopeParams.has(key)) scopeParams.set(key, resolveParams(collectParams(engineReqs.filter((r) => leaf.input_scope.includes(r.id))), sizing, repo.listOverrides(projectId)));
    applySizing([leaf], scopeParams.get(key), sizing);
  }

  // Persist rule-computed quantities; when a change was caused by an edit or an answer, flag the line.
  const changed = leaves.filter((l) => !l.manual_qty && l.sizing_rule && before.get(l.id) !== l.qty);
  if (changed.length && persist) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = changed.map((l) => {
      const from = before.get(l.id);
      if (reason) {
        l.stale = `数量由 ${from ?? "待估"} 变为 ${l.qty ?? "待估"}（${reason}）`;
        l.last_qty = from;
        l.confirmed = false;
      }
      l.qty_basis = "测算规则";
      return { ...byId.get(l.id), qty: l.qty, unit: l.unit, qty_basis: l.qty_basis, stale: l.stale, last_qty: l.last_qty, confirmed: l.confirmed };
    });
    repo.saveItems(projectId, rows);
  }

  const products = repo.listProducts();
  const productById = new Map(products.map((p) => [p.id, p]));
  const reqById = new Map(engineReqs.map((r) => [r.id, r]));
  for (const l of leaves) {
    l.basis_level = basisLevel(l, reqById);
    l.match = matchOf(l, productById);
  }

  const meta = project.pbs_meta ?? {};
  const usedProducts = new Set(leaves.map((l) => l.product_ref).filter(Boolean));
  const conflicts = (meta.conflicts ?? []).filter((c) => usedProducts.has(c.product_ref) && activeCodes.has(c.req_id));

  const covered = new Set(allReqs.filter((r) => !r.retired).map((r) => r.seg_uid));
  const extracted = new Set(repo.listMaterials(projectId).filter((m) => m.extracted_at).map((m) => m.id));
  const processed = segments.filter((s) => extracted.has(s.material_id));
  const missedSegments = processed.filter((s) => !covered.has(s.uid) && s.text.length > 6).map((s) => s.uid);

  const audit = items.length
    ? runAudit({
        doc: { fullText, segments: engineSegments(processed) },
        requirements: engineReqs,
        missedSegments,
        leaves,
        template,
        resolved,
        sizing,
        issues: meta.issues ?? [],
        repairs: meta.repairs ?? [],
        conflicts,
      })
    : [];
  assignReviewTiers({ requirements: engineReqs, leaves, findings: audit });

  const uncovered = items.length ? findUncovered(engineReqs, leaves).map((r) => r.id) : [];
  const leavesByReq = new Map();
  leaves.forEach((l) => l.req_ids.forEach((id) => leavesByReq.set(id, [...(leavesByReq.get(id) ?? []), l.code])));

  const scenarioState = scenarios.scenarioView(projectId);
  const requirements = allReqs.map((r) => {
    const e = reqById.get(r.code);
    return { ...r, scenario_ids: scenarioState.dispositions.find((d) => d.req_id === r.code)?.linked_scenarios ?? [], disposition: scenarioState.dispositions.find((d) => d.req_id === r.code) ?? null, review: e?.review ?? null, leaves: leavesByReq.get(r.code) ?? [], deliverable: !NON_DELIVERABLE.has(r.category) };
  });

  const leavesByCap = new Map();
  leaves.forEach((l) => l.capability_ids.forEach((id) => leavesByCap.set(id, [...(leavesByCap.get(id) ?? []), l.code])));
  const capabilities = allCaps.map((c) => {
    const reqs = c.req_ids.filter((id) => activeCodes.has(id));
    return {
      ...c,
      req_ids: c.req_ids,
      live_req_ids: reqs,
      orphan: c.status !== "已删除" && c.origin === "系统" && !reqs.length,
      leaves: leavesByCap.get(c.code) ?? [],
      realized: (leavesByCap.get(c.code) ?? []).length > 0,
    };
  });
  const projectMeta = project.pbs_meta ?? {};
  const capMeta = projectMeta.capabilities ?? { scenes: [], uncovered: [], notes: [], generatedAt: null };

  const questions = repo.listQuestions(projectId);
  const evidenceIds = [...new Set(leaves.flatMap((l) => l.evidence_chunks))];
  const chunks = Object.fromEntries(rag.getChunks(evidenceIds).map((c) => [c.id, c]));

  const groups = template.level1.map((g) => ({ code: g.code, name: g.name, required: g.required }));
  const count = (list, pred) => list.filter(pred).length;
  const steps = {
    materials: { count: repo.listMaterials(projectId).length, pending: repo.listMaterials(projectId).filter((m) => !m.extracted_at).length },
    requirements: {
      total: active.length,
      confirmed: count(active, (r) => r.status === "已确认"),
      pending: count(active, (r) => r.status === "待确认"),
      mustReview: count(requirements, (r) => r.status === "待确认" && r.review === "必审"),
    },
    scenarios: scenarioState.scenarioCoverage,
    questions: {
      total: count(questions, (q) => q.status !== "已忽略"),
      open: count(questions, (q) => q.status === "待处理" || q.status === "待答复"),
      answered: count(questions, (q) => q.status === "已答复"),
      applied: count(questions, (q) => q.status === "已应用"),
    },
    capabilities: {
      total: liveCaps.length,
      confirmed: liveCaps.filter((c) => c.status === "已确认").length,
      pending: liveCaps.filter((c) => c.status === "待确认").length,
      unrealized: liveCaps.length ? capabilities.filter((c) => c.status !== "已删除" && !c.realized).length : 0,
      orphan: capabilities.filter((c) => c.orphan).length,
    },
    pbs: {
      items: leaves.length,
      confirmed: count(leaves, (l) => l.confirmed),
      uncovered: uncovered.length,
      pendingQty: count(leaves, (l) => l.qty === null || l.qty === undefined),
      stale: count(leaves, (l) => l.stale),
      conflicts: conflicts.length,
      blockers: count(audit, (f) => f.level === "阻断"),
    },
  };

  return {
    project,
    fullText,
    engineReqs,
    resolved,
    leaves,
    conflicts,
    view: {
      project,
      steps,
      ...scenarioState,
      catalog: projectSolutions.projectCatalogView(projectId),
      sourceSnapshots: repo.listSourceSnapshots(projectId),
      materials: repo.listMaterials(projectId).map((m) => ({ ...m, kindLabel: MATERIAL_KINDS[m.kind] })),
      segments: segments.map((s) => ({ uid: s.uid, seg_id: s.seg_id, material_no: s.material_no, material_title: s.material_title, chapter: s.chapter, text: s.text, star: s.star, triangle: s.triangle })),
      requirements,
      capabilities,
      scenes: capMeta.scenes,
      capabilityNotes: { uncovered: capMeta.uncovered, notes: capMeta.notes, generatedAt: capMeta.generatedAt },
      params: Object.values(resolved).map((p) => ({ ...p, confirmed: CONFIRMED.has(p.status), sourceLabel: PARAM_SOURCE_LABEL[p.status] ?? p.status })),
      questions,
      groups,
      items: leaves.map(({ qtyBasis, ...l }) => ({ ...l, qty_basis: l.manual_qty ? "人工确认" : l.sizing_rule ? "测算规则" : l.qty_basis })),
      uncovered,
      conflicts,
      audit,
      chunks,
      similar: meta.similar ?? [],
      retrieval: meta.retrieval ?? null,
      generatedAt: meta.generatedAt ?? null,
    },
  };
}

export const projectView = (projectId) => computeState(projectId).view;

// ---------- requirement edits ----------

/** Capabilities lose their footing when every requirement behind them is gone: flag the lines built on them. */
function flagOrphanCapabilities(projectId, message) {
  const live = new Set(repo.listRequirements(projectId, { includeDeleted: false }).map((r) => r.code));
  const orphans = repo
    .listCapabilities(projectId, { includeDeleted: false })
    .filter((c) => c.origin === "系统" && c.req_ids.length && !c.req_ids.some((id) => live.has(id)))
    .map((c) => c.code);
  markItemsStaleByCapability(projectId, orphans, message);
}

function markItemsStale(projectId, codes, message) {
  if (!codes.length) return;
  const items = repo.listItems(projectId).filter((i) => i.req_ids.some((id) => codes.includes(id)));
  for (const item of items) Object.assign(item, { stale: message, confirmed: false });
  scenarios.markAffected(projectId, codes, message);
  repo.saveItems(projectId, items);
}

export function editRequirement(projectId, code, body) {
  return tx(() => editRequirementContent(projectId, code, body));
}

function editRequirementContent(projectId, code, body) {
  const req = repo.getRequirement(projectId, code);
  const fields = {};
  let contentChanged = false;
  for (const k of ["text", "category", "priority"]) {
    if (body[k] !== undefined && body[k] !== req[k]) {
      fields[k] = String(body[k]).trim();
      contentChanged = true;
    }
  }
  if (req.retired && body.status === "待确认") throw badRequest("已被替代的历史需求不能恢复，请新增需求");
  if (fields.text === "") throw badRequest("需求内容不能为空");
  if (contentChanged) { fields.edited = true; fields.revision = req.revision + 1; }
  if (body.status && ["待确认", "已确认", "已删除"].includes(body.status)) {
    if (body.status === "已删除" && !String(body.reason ?? "").trim()) throw badRequest("删除需求请填写原因");
    fields.status = body.status;
    fields.delete_reason = body.status === "已删除" ? String(body.reason).trim() : "";
  } else if (contentChanged) {
    fields.status = "待确认";
  }
  if (fields.status === "已删除") fields.revision = req.revision + 1;
  repo.updateRequirement(projectId, code, fields);
  if (contentChanged) {
    markItemsStale(projectId, [code], `关联需求 ${code} 已人工修改`);
    repo.logEvent(projectId, "需求", `修改 ${code}：${fields.text ?? req.text}`);
  }
  if (fields.status === "已删除") {
    markItemsStale(projectId, [code], `关联需求 ${code} 已删除`);
    flagOrphanCapabilities(projectId, `业务能力所依据的需求 ${code} 已删除，请复核`);
    repo.logEvent(projectId, "需求", `删除 ${code}（${fields.delete_reason}）`);
  }
  if (fields.status === "待确认" && req.status === "已删除") {
    markItemsStale(projectId, [code], `关联需求 ${code} 已恢复，请复核`);
    repo.logEvent(projectId, "需求", `恢复 ${code}`);
  }
  repo.touchProject(projectId);
}

export function confirmRequirements(projectId, codes) {
  tx(() => {
    const requirements = codes.map(code => repo.getRequirement(projectId, code));
    if (requirements.some(r => r.status === "已删除")) throw badRequest("所选需求已删除，请刷新列表；需要保留时先恢复再确认");
    requirements.forEach(r => repo.updateRequirement(projectId, r.code, { status: "已确认" }));
  });
  repo.logEvent(projectId, "需求", `批量确认 ${codes.length} 条需求`);
  repo.touchProject(projectId);
}

export function addRequirement(projectId, body) {
  const text = String(body.text ?? "").trim();
  if (!text) throw badRequest("需求内容不能为空");
  const code = repo.insertRequirement(projectId, {
    text,
    category: body.category || "功能",
    priority: body.priority || "重要",
    status: "已确认",
    origin: "人工",
    source_note: String(body.source_note ?? "").trim() || "人工新增",
    quote_verified: false,
  });
  repo.logEvent(projectId, "需求", `新增 ${code}：${text}`);
  repo.touchProject(projectId);
  return code;
}

export function setParam(projectId, name, body) {
  const { sizing } = catalog.runtimeConfig(projectId);
  if (!sizing.params[name]) throw badRequest("参数不存在");
  if (body.value === null || body.value === "") {
    repo.clearOverride(projectId, name);
    repo.logEvent(projectId, "参数", `「${sizing.params[name].label}」恢复为按材料取值`);
  } else {
    const value = Number(body.value);
    if (!Number.isFinite(value)) throw badRequest("参数值必须是数字");
    repo.setOverride(projectId, name, { value, source: "人工", note: String(body.note ?? "") });
    repo.logEvent(projectId, "参数", `「${sizing.params[name].label}」人工设定为 ${value}`);
  }
  computeState(projectId, { reason: `「${sizing.params[name].label}」已人工调整` });
}

// ---------- step 3: clarification loop ----------

export function editQuestion(projectId, id, body) {
  const q = repo.getQuestion(projectId, id);
  const fields = {};
  if (body.question !== undefined && body.question !== q.question) Object.assign(fields, { question: String(body.question), edited: true });
  if (body.assignee !== undefined) {
    fields.assignee = String(body.assignee);
    if (q.status === "待处理" && fields.assignee) fields.status = "待答复";
  }
  if (body.status && ["待处理", "待答复", "已忽略"].includes(body.status)) fields.status = body.status;
  if (q.status === "已应用" && fields.status) throw badRequest("该问题已处理；如有新的疑问，请新增待澄清事项");
  if (q.status === "已忽略" && fields.status === "待处理") fields.status = q.answer && q.proposal ? "已答复" : q.assignee ? "待答复" : "待处理";
  if (body.impact) fields.impact = body.impact;
  if (["scenario_ids", "req_ids", "field_paths"].some((k) => body[k] !== undefined)) Object.assign(fields, scenarios.validateQuestionLinks(projectId, { ...q, ...body }));
  repo.updateQuestion(projectId, id, fields);
  if (fields.status === "已忽略") repo.logEvent(projectId, "澄清", `忽略问题：${q.question}`);
}

export function deleteMaterial(projectId, id) {
  const reqIds = repo.listRequirements(projectId).filter((r) => repo.listSegments(projectId).some((s) => s.material_id === id && s.uid === r.seg_uid)).map((r) => r.code);
  return tx(() => {
    repo.deleteMaterial(projectId, id);
    scenarios.markAffected(projectId, reqIds, "来源材料已删除，请复核");
    repo.touchProject(projectId);
  });
}

export function addQuestion(projectId, body) {
  const question = String(body.question ?? "").trim();
  if (!question) throw badRequest("问题不能为空");
  repo.insertQuestion(projectId, { source: "人工", question, impact: body.impact || "影响方案", reason: String(body.reason ?? ""), ...scenarios.validateQuestionLinks(projectId, body) });
  scenarios.flagPbs(projectId, body.scenario_ids ?? [], "新增场景澄清，相关结论待复核");
}

/** Save the customer's answer and ask the model what it changes. Nothing is applied yet. */
export async function proposeAnswer(projectId, id, body, llm) {
  const answer = String(body.answer ?? "").trim();
  if (!answer) throw badRequest("请填写客户答复");
  const q = repo.getQuestion(projectId, id);
  const { sizing } = catalog.runtimeConfig(projectId);
  const state = computeState(projectId);
  const proposal = await proposeChanges({
    question: q,
    answer,
    requirements: repo.listRequirements(projectId, { includeDeleted: false }).map((r) => ({ ...r, material_kind: repo.listSourceSnapshots(projectId).find((s) => s.uid === r.seg_uid)?.material_kind })),
    scenarios: scenarios.listScenarios(projectId).filter((s) => s.status !== "已归档"),
    params: state.resolved,
    sizing,
    llm,
  });
  if (hash(repo.getQuestion(projectId, id)) !== hash(q)) throw new HttpError(409, "问题在分析期间已变化，请重新分析答复");
  repo.updateQuestion(projectId, id, { answer, answer_source: String(body.answer_source ?? "口头"), status: "已答复", proposal });
  repo.logEvent(projectId, "澄清", `录入答复：${q.question} → ${answer}`);
  return proposal;
}

/** Apply the accepted subset of the proposal; recompute quantities and flag affected PBS lines. */
export function applyAnswer(projectId, id, accepted, resolutionNote = "") {
  const q = repo.getQuestion(projectId, id);
  if (!q.proposal) throw badRequest("请先录入客户答复");
  if (q.status === "已应用") return { applied: q.applied.changes.length };
  if (!Array.isArray(accepted) || accepted.some((i) => !Number.isInteger(i) || !q.proposal.changes[i])) throw badRequest("所选变更无效");
  const chosen = (q.proposal.changes ?? []).filter((_, i) => accepted.includes(i));
  if (chosen.some((c) => !c.quoteVerified)) throw badRequest("不能应用引用未通过校验的建议");
  if (chosen.some((c) => c.conflict) && !String(resolutionNote).trim()) throw badRequest("答复可能与正式条款冲突，请记录处理依据后再应用");
  for (const c of chosen.filter((c) => c.type === "update_scenario")) {
    if (scenarios.getScenario(projectId, c.code).revision !== c.before_revision) throw new HttpError(409, "场景已变化，请重新分析答复");
  }
  for (const c of chosen.filter((c) => ["update_requirement", "remove_requirement"].includes(c.type))) {
    if (repo.getRequirement(projectId, c.code).revision !== c.before_revision) throw new HttpError(409, "需求已变化，请重新分析答复");
  }
  const touched = [];
  const tag = `澄清答复 Q${id}`;
  const log = [];
  tx(() => {
    const answerUid = `Q${id}:${scenarios.answerHash(q.answer)}`;
    scenarios.saveAnswerSource(projectId, answerUid, q);
    for (const c of chosen) {
      if (c.type === "update_scenario") {
        scenarios.applyScenarioChange(projectId, { ...c, before_revision: scenarios.getScenario(projectId, c.code).revision }, q);
        log.push(`${c.code} 更新 ${c.field_path}`);
      } else if (c.type === "set_param") {
        repo.setOverride(projectId, c.name, { value: c.value, source: "客户答复", note: c.quote, questionId: id });
        log.push(`「${c.label}」设为 ${c.value}${c.unit}`);
      } else if (c.type === "update_requirement") {
        const previous = repo.getRequirement(projectId, c.code);
        repo.updateRequirement(projectId, c.code, { text: c.text, priority: c.priority, category: c.category, edited: true, status: "已确认", source_note: `${tag}：${c.quote}`, revision: repo.getRequirement(projectId, c.code).revision + 1 });
        repo.updateRequirement(projectId, c.code, { answer_evidence: [...previous.answer_evidence, { seg_uid: answerUid, quote: c.quote, before: { text: previous.text, priority: previous.priority, category: previous.category, revision: previous.revision, seg_uid: previous.seg_uid, quote: previous.quote }, resolution_note: String(resolutionNote) }] });
        touched.push(c.code);
        log.push(`${c.code} 改为「${c.text}」`);
      } else if (c.type === "add_requirement") {
        const code = repo.insertRequirement(projectId, { text: c.text, category: c.category, priority: c.priority, status: "已确认", origin: "澄清答复", source_note: `${tag}：${c.quote}`, seg_uid: answerUid, quote: c.quote, quote_verified: true });
        log.push(`新增 ${code}「${c.text}」`);
      } else if (c.type === "remove_requirement") {
        repo.updateRequirement(projectId, c.code, { status: "已删除", delete_reason: `${tag}：${c.reason}`, revision: repo.getRequirement(projectId, c.code).revision + 1 });
        touched.push(c.code);
        log.push(`删除 ${c.code}`);
      }
    }
    markItemsStale(projectId, touched, `关联需求已按${tag}修改`);
    computeState(projectId, { reason: tag });
    repo.updateQuestion(projectId, id, { status: "已应用", applied: { at: new Date().toISOString(), changes: chosen, resolution_note: String(resolutionNote) } });
  });
  repo.logEvent(projectId, "澄清", `应用答复（${q.question}）：${log.join("；") || "无变更"}`);
  repo.touchProject(projectId);
  return { applied: chosen.length };
}

// ---------- PBS validation and manual operations ----------

function rematchVersion(projectId, item) {
  return hash({ item, requirements: repo.listRequirements(projectId).filter((r) => item.req_ids.includes(r.code)), scenarios: scenarios.listScenarios(projectId).filter((s) => item.scenario_ids.includes(s.code)), products: repo.listProducts() });
}

/** Retrieve candidate products and evidence for the requested requirements. */
async function retrieve(reqs, { keepProducts = [], topProducts = 12, topChunks = 40 } = {}) {
  const products = repo.listProducts().filter((p) => p.metadata.active !== false);
  const productById = new Map(products.map((p) => [p.id, p]));
  const queries = reqs.map((r) => r.text);
  const hits = queries.length ? await rag.search(queries, { topK: 6 }) : [];
  const productScore = new Map();
  const chunkScore = new Map();
  hits.flat().forEach((h) => {
    if (h.chunk.product_id) productScore.set(h.chunk.product_id, (productScore.get(h.chunk.product_id) ?? 0) + h.score);
    const prev = chunkScore.get(h.chunk.id);
    chunkScore.set(h.chunk.id, { chunk: h.chunk, score: (prev?.score ?? 0) + h.score });
  });
  const ranked = [...productScore.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const ids = [...new Set([...keepProducts, ...ranked.slice(0, topProducts)])].filter((id) => productById.has(id));
  const candidates = ids.map((id) => productById.get(id));
  // If retrieval found little, fall back to the whole (small) library so the model can still match.
  if (candidates.length < 3) candidates.push(...products.filter((p) => !ids.includes(p.id)).slice(0, topProducts - candidates.length));
  const chunks = [...chunkScore.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topChunks)
    .map((c) => c.chunk);
  return { candidates, chunks, productScore: Object.fromEntries(ranked.map((id) => [id, Math.round(productScore.get(id) * 1000) / 1000])) };
}

// ---------- business capabilities (between requirements and products) ----------

const capText = (c) => `${c.name} ${c.description} ${c.activity}`;

function markItemsStaleByCapability(projectId, codes, message) {
  if (!codes.length) return;
  const items = repo.listItems(projectId).filter((i) => i.capability_ids.some((id) => codes.includes(id)));
  for (const item of items) Object.assign(item, { stale: message, confirmed: false });
  repo.saveItems(projectId, items);
}

export function editCapability(projectId, code, body) {
  const cap = repo.getCapability(projectId, code);
  const fields = {};
  let changed = false;
  for (const k of ["name", "description", "activity", "priority"]) {
    if (body[k] !== undefined && String(body[k]).trim() !== cap[k]) {
      fields[k] = String(body[k]).trim();
      changed = true;
    }
  }
  if (body.req_ids) {
    const known = new Set(repo.listRequirements(projectId).map((r) => r.code));
    const ids = [...new Set(body.req_ids.map(String))].filter((id) => known.has(id));
    if (!ids.length) throw badRequest("一条业务能力至少要关联一条需求");
    fields.req_ids = ids;
    changed = true;
  }
  if (fields.name === "" || fields.activity === "") throw badRequest("能力名称和业务活动不能为空");
  if (changed) {
    const names = repo.listProducts().map((p) => p.name);
    if (names.some((n) => n.length >= 2 && `${fields.name ?? cap.name}${fields.description ?? cap.description}`.includes(n))) {
      throw badRequest("业务能力不应出现产品名称，请只描述业务上需要什么");
    }
    fields.edited = true;
  }
  if (body.status && ["待确认", "已确认", "已删除"].includes(body.status)) {
    if (body.status === "已删除" && !String(body.reason ?? "").trim()) throw badRequest("删除业务能力请填写原因");
    fields.status = body.status;
    fields.delete_reason = body.status === "已删除" ? String(body.reason).trim() : "";
  } else if (changed) {
    fields.status = "已确认";
  }
  repo.updateCapability(projectId, code, fields);
  if (changed) {
    markItemsStaleByCapability(projectId, [code], `业务能力 ${code} 已人工修改，请复核匹配`);
    repo.logEvent(projectId, "能力", `修改 ${code}：${fields.name ?? cap.name}`);
  }
  if (fields.status === "已删除") {
    markItemsStaleByCapability(projectId, [code], `业务能力 ${code} 已删除`);
    repo.logEvent(projectId, "能力", `删除 ${code}（${fields.delete_reason}）`);
  }
  repo.touchProject(projectId);
}

export function addCapability(projectId, body) {
  const name = String(body.name ?? "").trim();
  const activity = String(body.activity ?? "").trim();
  if (!name || !activity) throw badRequest("请填写能力名称和它挂接的业务活动");
  const known = new Set(repo.listRequirements(projectId).map((r) => r.code));
  const reqIds = [...new Set((body.req_ids ?? []).map(String))].filter((id) => known.has(id));
  if (!reqIds.length) throw badRequest("请选择这条能力服务的需求");
  const code = repo.insertCapability(projectId, {
    name,
    description: String(body.description ?? "").trim(),
    activity,
    req_ids: reqIds,
    priority: ["必须", "重要", "一般"].includes(body.priority) ? body.priority : "重要",
    status: "已确认",
    origin: "人工",
    edited: true,
  });
  repo.logEvent(projectId, "能力", `新增 ${code}：${name}`);
  repo.touchProject(projectId);
  return code;
}

export function confirmCapabilities(projectId, codes) {
  tx(() => codes.forEach((code) => repo.updateCapability(projectId, code, { status: "已确认" })));
  repo.logEvent(projectId, "能力", `确认 ${codes.length} 条业务能力`);
  repo.touchProject(projectId);
}

const ITEM_EDITABLE = ["name", "spec", "source", "product_ref", "matched_capabilities", "blocked_by", "req_ids", "capability_ids", "parent", "basis", "unit", "sizing_rule"];

/** Agent planning uses the same deterministic product/quantity rules as manual PBS operations. */
export function submitAgentPbs(projectId, { expected_version, items: rawItems, approved_scope }) {
  if (expected_version !== projectSolutions.projectInputHash(projectId)) throw new HttpError(409, "项目已变化，请重新读取project_state的pbs_version");
  const { template, sizing, history } = catalog.runtimeConfig(projectId);
  const state = computeState(projectId);
  if (!state.engineReqs.length) throw badRequest("请先保存原始需求");
  const current = repo.listItems(projectId);
  const kept = current.filter((i) => i.edited || i.confirmed || i.reviewed).map(leafFromItem);
  const sceneList = scenarios.listScenarios(projectId).filter((s) => s.status !== "已归档");
  const chunks = rag.getChunks([...new Set(rawItems.flatMap((i) => i.evidence_chunks ?? []))].filter(Number.isInteger));
  const ctx = createContext({ requirements: state.engineReqs.filter((r) => !NON_DELIVERABLE.has(r.category)), segments: engineSegments(repo.listSegments(projectId)), template, products: repo.listProducts(), sizing, history, chunks, scenarios: sceneList });
  const submittedNames = new Set();
  for (const raw of rawItems) {
    if (!raw || typeof raw.name !== "string" || !raw.name.trim() || !ctx.level1.has(String(raw.parent))) throw badRequest("PBS名称和分组无效");
    if (submittedNames.has(normalize(raw.name))) throw badRequest("同一批PBS不能提交重复名称");
    submittedNames.add(normalize(raw.name));
    if (!Array.isArray(raw.req_ids) || !raw.req_ids.length || raw.req_ids.some((id) => !ctx.reqById.has(id))) throw badRequest("PBS必须关联真实的可交付需求");
    if (raw.product_ref && (!ctx.productById.has(raw.product_ref) || ctx.productById.get(raw.product_ref).metadata.active === false)) throw badRequest("产品不存在或已归档");
    if (raw.source === "自有产品" && !raw.product_ref) throw badRequest("自有产品必须引用真实product_ref");
    if (raw.product_ref && raw.blocked_by?.product_ref === raw.product_ref) throw badRequest("blocked_by不能与交付产品相同；自身使用条件请写入spec或basis，保留product_ref并移除blocked_by");
    if (raw.product_ref && !raw.matched_capabilities?.length) throw badRequest("目录产品至少提供一条从真实能力清单引用的matched_capabilities");
    if (!DELIVERY_SOURCES.includes(raw.source)) throw badRequest("PBS产品来源无效");
    if (raw.qty !== undefined && raw.qty !== null && (!Number.isFinite(raw.qty) || raw.qty < 0)) throw badRequest("PBS数量应为非负数或null");
  }
  const fresh = rawItems.map((raw) => {
    const existing = current.find((i) => !kept.some((k) => k.id === i.id) && normalize(i.name) === normalize(raw.name));
    return normalizeLeaf({ ...raw, id: existing?.id ?? null, code: existing?.code ?? "", edited: false, confirmed: false, manual_qty: false, origin: "model" }, ctx);
  })
    .filter((leaf) => !kept.some((k) => normalize(k.name) === normalize(leaf.name) || (k.product_ref && k.product_ref === leaf.product_ref)));
  const untouched = current.filter((i) => !kept.some((k) => k.id === i.id) && !fresh.some((f) => f.id === i.id)).map(leafFromItem);
  const leaves = [...kept, ...untouched, ...fresh];
  assignCodes(leaves);
  const quantityText = approved_scope ? state.engineReqs.filter((r) => approved_scope.includes(r.id)).map((r) => r.quoteVerified ? r.quote : r.origin !== "系统" ? r.text : "").join("\n") : state.fullText;
  enforceLeaves(leaves, ctx, quantityText);
  if (approved_scope) {
    const scoped = leaves.filter((l) => fresh.includes(l) || !l.id);
    for (const leaf of scoped) leaf.input_scope = [...approved_scope];
    const resolved = resolveParams(collectParams(state.engineReqs.filter((r) => approved_scope.includes(r.id))), sizing, repo.listOverrides(projectId));
    applySizing(scoped.filter((l) => !l.manual_qty), resolved, sizing);
  }
  const conflicts = checkConflicts([], leaves, ctx);
  for (const leaf of fresh) {
    if (leaf.scenario_ids.some((id) => sceneList.find((s) => s.code === id)?.status !== "已确认")) leaf.stale = "关联场景尚待人工审阅";
  }
  tx(() => {
    repo.saveItems(projectId, leaves.map((l) => ({ ...l, qty_basis: l.qtyBasis ?? "待估", stale: l.stale || "" })));
    const project = repo.getProject(projectId);
    repo.updateProject(projectId, { pbs_meta: { ...project.pbs_meta, generatedAt: new Date().toISOString(), conflicts, issues: ctx.issues, execution: "deepseek-harness" } });
    repo.logEvent(projectId, "PBS", `Agent保存 ${leaves.length} 项PBS草稿，保留 ${kept.length} 项人工成果`);
  });
  return { items: leaves.length, kept: kept.length, saved_items: repo.listItems(projectId).map(({ id, code, name, product_ref, req_ids, qty, unit }) => ({ id, code, name, product_ref, req_ids, qty, unit })), issues: ctx.issues, conflicts, uncovered: findUncovered(state.engineReqs, leaves).map((r) => r.id), pbs_version: projectSolutions.projectInputHash(projectId) };
}

function nextItemCode(items, parent, exceptId) {
  const used = items.filter((i) => i.parent === parent && i.id !== exceptId).map((i) => Number(String(i.code).split(".")[1]) || 0);
  return `${parent}.${Math.max(0, ...used) + 1}`;
}

function validateItem(item, others = [], projectId) {
  const { template, sizing } = catalog.runtimeConfig(projectId);
  if (!template.level1.some((g) => g.code === item.parent)) throw badRequest("一级分类不存在");
  if (!["自有产品", "外采", "自研", "服务"].includes(item.source)) throw badRequest("来源不正确");
  if (!String(item.name ?? "").trim()) throw badRequest("名称不能为空");
  if (item.sizing_rule && !sizing.rules.some((r) => r.id === item.sizing_rule)) throw badRequest("测算规则不存在");
  const selectedRule = sizing.rules.find((r) => r.id === item.sizing_rule);
  if (selectedRule?.strict_product && selectedRule.product_ref !== item.product_ref) throw badRequest("测算规则与所选产品不一致");
  const clash = item.sizing_rule && others.find((o) => o.id !== item.id && o.sizing_rule === item.sizing_rule);
  if (clash) throw badRequest(`测算规则 ${item.sizing_rule} 已用于「${clash.code} ${clash.name}」，同一规则只能用一次，否则会重复计量`);
  if (item.product_ref) {
    const product = repo.getProduct(item.product_ref);
    if (!product) throw badRequest("产品不存在");
    if (product.metadata.delivery_source) item.source = product.metadata.delivery_source;
    if (!item.unit) item.unit = product.unit;
    item.matched_capabilities = (item.matched_capabilities ?? []).filter((c) => product.capabilities.includes(c));
  } else {
    item.matched_capabilities = [];
  }
  if (item.blocked_by?.product_ref) {
    const blocker = repo.getProduct(item.blocked_by.product_ref);
    if (!blocker || !blocker.limits.includes(item.blocked_by.limit)) throw badRequest("所选限制不在该产品的限制清单中");
    item.blocked_by = { product_ref: blocker.id, product_name: blocker.name, limit: item.blocked_by.limit };
  } else {
    item.blocked_by = null;
  }
}

export function saveItem(projectId, id, body) {
  const items = repo.listItems(projectId);
  const item = id ? repo.getItem(projectId, id) : { id: null, code: "", origin: "人工", qty: null, qty_basis: "待估", evidence_chunks: [], history_ref: [], repairs: [], spec: "", basis: "人工新增", unit: "", req_ids: [] };
  for (const k of ITEM_EDITABLE) if (body[k] !== undefined) item[k] = body[k];
  item.parent = String(item.parent ?? "");
  item.sizing_rule = item.sizing_rule || null;
  validateItem(item, items, projectId);
  const activeReqIds = new Set(repo.listRequirements(projectId, { includeDeleted: false }).filter((r) => !NON_DELIVERABLE.has(r.category)).map((r) => r.code));
  if (!Array.isArray(item.req_ids) || item.req_ids.some((code) => !activeReqIds.has(code))) throw badRequest("关联需求不存在或已删除");
  item.scenario_ids = scenarios.listScenarios(projectId).filter((s) => s.status !== "已归档" && s.links.some((l) => item.req_ids.includes(l.req_id))).map((s) => s.code);
  if (!item.code || (id && item.code.split(".")[0] !== item.parent)) item.code = nextItemCode(items, item.parent, item.id);
  if (body.qty !== undefined) {
    if (body.qty === null || body.qty === "") {
      item.manual_qty = false;
    } else {
      const qty = Number(body.qty);
      if (!Number.isFinite(qty) || qty < 0) throw badRequest("数量必须是非负数");
      item.qty = qty;
      item.manual_qty = true;
      item.qty_basis = "人工确认";
    }
  }
  if (!item.manual_qty && !item.sizing_rule) {
    const product = item.product_ref ? repo.getProduct(item.product_ref) : null;
    if (usesSingleLicense(product)) Object.assign(item, { qty: 1, unit: product.unit, qty_basis: "产品许可" });
    else if (item.qty_basis !== "原文数量") Object.assign(item, { qty: null, qty_basis: "待估" });
  }
  item.edited = true;
  item.confirmed = false;
  item.stale = "";
  repo.saveItems(projectId, [item]);
  repo.logEvent(projectId, "PBS", `${id ? "修改" : "新增"} ${item.code} ${item.name}`);
  computeState(projectId);
  repo.touchProject(projectId);
  return item.id;
}

export function confirmItems(projectId, ids) {
  const items = repo.listItems(projectId).filter((i) => ids.includes(i.id));
  const sceneState = scenarios.scenarioView(projectId);
  for (const item of items) {
    if (sceneState.scenarios.some((s) => item.scenario_ids.includes(s.code) && (s.status !== "已确认" || s.open_questions.length))) throw badRequest("请先复核关联场景并处理其澄清问题");
    if (rag.getChunks(item.evidence_chunks).some((c) => !c.active)) throw badRequest("产品依据已变化，请先重新匹配");
  }
  items.forEach((i) => Object.assign(i, { confirmed: true, reviewed: true, stale: "" }));
  repo.saveItems(projectId, items);
  repo.logEvent(projectId, "PBS", `确认 ${items.length} 项`);
}

export function deleteItem(projectId, id) {
  const item = repo.getItem(projectId, id);
  repo.deleteItems(projectId, [id]);
  repo.logEvent(projectId, "PBS", `删除 ${item.code} ${item.name}`);
  repo.touchProject(projectId);
}

/** Ask the model to re-decide one line; the result is returned as a suggestion and saved only when accepted. */
export async function rematchItem(projectId, id, { instruction = "", llm }) {
  const item = repo.getItem(projectId, id);
  const approved = assertProjectApproval(projectId, item);
  const { template, sizing, history } = catalog.runtimeConfig(projectId);
  const state = computeState(projectId);
  const requirements = state.engineReqs.filter(r => approved.snapshot.requirements.some(a => a.code === r.id));
  const leaf = leafFromItem(item);
  const inputVersion = rematchVersion(projectId, item);
  const reqs = state.engineReqs.filter((r) => leaf.req_ids.includes(r.id));
  const capabilities = repo.listCapabilities(projectId, { includeDeleted: false }).filter(c => c.req_ids.every(id => requirements.some(r => r.id === id)));
  const own = capabilities.filter((c) => leaf.capability_ids.includes(c.code));
  const query = own.length ? own.map((c) => ({ text: capText(c) })) : reqs.length ? reqs : [{ text: `${item.name} ${item.spec}` }];
  const retrieval = await retrieve(query, { topProducts: 8, topChunks: 16 });
  const ctx = createContext({ requirements, segments: [], template, products: repo.listProducts(), sizing, history, chunks: retrieval.chunks, capabilities, scenarios: approved.snapshot.scenarios });
  const next = await rematchLeaf({ leaf, requirements, template, candidates: retrieval.candidates, chunks: retrieval.chunks, capabilities, sizing, instruction, llm, ctx });
  if (assertProjectApproval(projectId, item).id !== approved.id) throw new HttpError(409, "确认范围已变化，请重新匹配");
  if (!next) throw new HttpError(502, "模型没有给出有效结果，请重试");
  enforceLeaves([next], ctx, requirements.map(r => r.quote).join("\n"));
  const taken = repo.listItems(projectId).find((o) => o.id !== id && next.sizing_rule && o.sizing_rule === next.sizing_rule);
  if (taken) {
    next.sizing_rule = item.sizing_rule === next.sizing_rule ? next.sizing_rule : null;
    if (!next.sizing_rule) Object.assign(next, { qty: null, qtyBasis: "待估" });
  }
  next.basis_level = basisLevel(next, new Map(state.engineReqs.map((r) => [r.id, r])));
  next.match = matchOf(next, new Map(repo.listProducts().map((p) => [p.id, p])));
  return {
    suggestion: { ...next, input_version: inputVersion, approval_id: approved.id },
    chunks: Object.fromEntries(rag.getChunks(next.evidence_chunks).map((c) => [c.id, c])),
    notes: ctx.issues.map((i) => i.message),
  };
}

export function acceptRematch(projectId, id, suggestion) {
  const item = repo.getItem(projectId, id);
  const approved = assertProjectApproval(projectId, item);
  if (approved.id !== suggestion.approval_id) throw new HttpError(409, "选型建议的确认范围已过期，请重新匹配");
  if (suggestion.input_version !== rematchVersion(projectId, item)) throw new HttpError(409, "PBS 或其依据已变化，请重新匹配后再采纳");
  const next = { ...item };
  for (const k of ["name", "spec", "source", "product_ref", "matched_capabilities", "blocked_by", "evidence_chunks", "capability_ids", "scenario_ids", "basis", "parent", "unit", "sizing_rule"]) {
    if (suggestion[k] !== undefined) next[k] = suggestion[k];
  }
  next.parent = String(next.parent);
  next.scenario_ids = approved.snapshot.scenarios.filter(s => s.links.some(l => item.req_ids.includes(l.req_id))).map(s => s.code);
  next.sizing_rule = next.sizing_rule || null;
  validateItem(next, repo.listItems(projectId), projectId);
  if (next.parent !== item.parent) next.code = nextItemCode(repo.listItems(projectId), next.parent, id);
  if (!next.manual_qty && !next.sizing_rule) {
    const product = next.product_ref ? repo.getProduct(next.product_ref) : null;
    Object.assign(next, usesSingleLicense(product) ? { qty: 1, unit: product.unit, qty_basis: "产品许可" } : { qty: null, qty_basis: "待估" });
  }
  next.edited = true;
  next.confirmed = false;
  next.stale = "";
  next.origin = "rematch";
  repo.saveItems(projectId, [next]);
  repo.logEvent(projectId, "PBS", `重新匹配 ${next.code}：${item.name} → ${next.name}（${next.source}${next.product_ref ? " " + next.product_ref : ""}）`);
  computeState(projectId);
}

// ---------- product library ----------

export function cleanProduct(input) {
  const list = (value) =>
    (Array.isArray(value) ? value : String(value ?? "").split(/\r?\n|；|;/))
      .map((x) => String(typeof x === "object" ? x?.text ?? "" : x).trim())
      .filter(Boolean);
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("产品名称不能为空");
  return {
    name,
    summary: String(input.summary ?? "").trim(),
    capabilities: [...new Set(list(input.capabilities))],
    limits: [...new Set(list(input.limits))],
    xinchuang: String(input.xinchuang ?? "").trim(),
    unit: String(input.unit ?? "").trim() || "套",
  };
}

export function saveProduct(id, input) {
  const clean = cleanProduct(input);
  const old = id ? repo.getProduct(id) : null;
  clean.metadata = { kind: "未分类", delivery_source: "自有产品", availability: "待核实", data_kind: "人工维护", quantity_policy: "unknown", active: true, requires_validation: true, compatibility: [], deliverables: [], reference_ids: [], ...old?.metadata, ...input.metadata };
  if (!DELIVERY_SOURCES.includes(clean.metadata.delivery_source)) throw badRequest("产品来源错误");
  const same = repo.findProductByName(clean.name);
  if (same && same.id !== id) throw badRequest(`已有同名产品 ${same.id}`);
  const product = tx(() => {
    const saved = repo.saveProduct(id, clean);
    catalog.recordProductChange();
    return saved;
  });
  if (product.metadata.active === false) rag.removeProductChunks(product.id); else rag.indexProduct(product);
  return product;
}

export function deleteProduct(id) {
  if (catalog.readCatalog()) {
    const p = repo.getProduct(id);
    if (!p) return false;
    saveProduct(id, { ...p, metadata: { ...p.metadata, active: false } });
    return true;
  }
  if (!repo.deleteProduct(id)) return false;
  rag.removeProductChunks(id);
  return true;
}

export function importProducts(rows) {
  let created = 0;
  let updated = 0;
  const errors = [];
  rows.forEach((row, index) => {
    try {
      const clean = cleanProduct(row);
      const existing = repo.findProductByName(clean.name);
      saveProduct(existing?.id ?? null, clean);
      if (existing) updated += 1;
      else created += 1;
    } catch (error) {
      errors.push(`第 ${index + 2} 行：${error.message}`);
    }
  });
  return { created, updated, errors };
}

/** Manual upload: LLM drafts capability/limit lists for review; the manual text is indexed for retrieval. */
export async function parseManual(docId, { llm, progress }) {
  const doc = repo.getDoc(docId);
  progress.step(0);
  const draft = await draftProductFromManual({ name: doc.name, text: doc.text, llm });
  progress.step(1);
  repo.updateDoc(docId, { draft, status: "待确认" });
  if (doc.product_id) rag.indexManual({ docId, productId: doc.product_id, text: doc.text });
  return { capabilities: draft.capabilities.length, limits: draft.limits.length };
}

/** Confirm a manual draft into a product (new or existing) and index the manual under it. */
export function confirmManual(docId, { productId, product }) {
  const doc = repo.getDoc(docId);
  const saved = saveProduct(productId || null, product);
  repo.updateDoc(docId, { product_id: saved.id, status: "已入库" });
  rag.indexManual({ docId, productId: saved.id, text: doc.text });
  return saved;
}

export function deleteManual(docId) {
  rag.removeManualChunks(docId);
  repo.deleteDoc(docId);
}

/** (Re)build product and history chunks; manuals keep their chunks. */
export function rebuildIndex() {
  for (const p of repo.listProducts()) {
    if (p.metadata.active === false) rag.removeProductChunks(p.id); else rag.indexProduct(p);
  }
  rag.indexHistory(catalog.runtimeConfig().history);
}

const SEED_MANUALS = [
  { file: "skyops.md", product: "低空飞行管控平台 SkyOps" },
  { file: "visionai.md", product: "AI 视觉识别引擎 VisionAI" },
];

/** First start only: attach the sample manuals so retrieval has real passages to show. */
export function seedManuals() {
  if (catalog.readCatalog() || repo.listDocs(null).length) return;
  for (const { file, product } of SEED_MANUALS) {
    const owner = repo.findProductByName(product);
    if (!owner) continue;
    const text = readFileSync(new URL(`../seed/manuals/${file}`, import.meta.url), "utf8");
    const docId = repo.createDoc({ productId: owner.id, name: file, text });
    repo.updateDoc(docId, { status: "已入库" });
    rag.indexManual({ docId, productId: owner.id, text });
  }
}
