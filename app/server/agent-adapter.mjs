import { TOOLS, validateArguments } from "../../agents/pbs/contracts/tools.mjs";
import { hash } from "../engine/scenario.mjs";
import { normalize } from "../engine/text.mjs";
import { checkParam } from "../engine/requirements.mjs";
import { getDb, json, now, parse, tx } from "./db.mjs";
import * as repo from "./repo.mjs";
import * as svc from "./services.mjs";
import * as scenes from "./scenarios.mjs";
import * as rag from "./rag.mjs";
import * as catalog from "./catalog.mjs";
import * as solutions from "./project-solutions.mjs";
import { proposeAgentChange } from "./chat.mjs";

const page = (items, args, max = 40) => {
  const cursor = args.cursor ?? 0; const limit = Math.min(args.limit ?? 12, max);
  const result = []; let chars = 0;
  for (const item of items.slice(cursor, cursor + limit)) {
    const size = JSON.stringify(item).length;
    if (result.length && chars + size > 18000) break;
    result.push(item); chars += size;
  }
  const next = cursor + result.length;
  return { items: result, total: items.length, next_cursor: next < items.length ? next : null };
};
const err = (code, message, details) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
const docId = (id) => `material:${id}`;

export function localAgentAdapter(projectId, { signal, onProgress = () => {}, maxCalls = 500, operationScope = "", checkWrite = () => {}, pbsScope } = {}) {
  repo.getProject(projectId);
  let calls = 0; let finished = null;
  const readThrough = new Map();
  const documents = () => repo.listMaterials(projectId).map((m) => ({ document_id: docId(m.id), document_version: hash(repo.getMaterial(projectId, m.id).text), title: m.title, kind: m.kind, kind_inferred: Boolean(m.meta.kind_inferred), description: m.meta.description ?? "", size: m.size, extracted: Boolean(m.extracted_at) }));
  const document = (id) => {
    const d = documents().find((d) => d.document_id === id);
    if (!d) throw new Error("文档不存在或不属于当前项目");
    return d;
  };
  const sources = () => repo.listSegments(projectId);
  const evidence = (s, d) => ({ evidence_id: s.uid, document_id: d.document_id, document_version: d.document_version, text: s.text, chapter: s.chapter, star: s.star, triangle: s.triangle });
  const covered = (d) => new Map(getDb().prepare("SELECT evidence_id,status,reason,processed_until FROM agent_coverage WHERE project_id=? AND document_version=?").all(projectId, d.document_version).map((s) => [s.evidence_id, s]));
  const progress = (d) => {
    const known = covered(d);
    const until = s => Math.min(s.text.length, known.has(s.uid) ? known.get(s.uid).processed_until ?? s.text.length : 0);
    return { known, until, pending: s => s.text.length > 6 && until(s) < s.text.length };
  };
  const coverage = () => documents().map((d) => {
    const p = progress(d), mine = sources().filter(s => docId(s.material_id) === d.document_id);
    const all = mine.filter(s => s.text.length > 6), missing = all.filter(p.pending);
    const ignored = [...p.known.values()].filter(s => s.status === "ignored");
    const first = missing[0];
    return { ...d, total_sections: all.length, processed: all.length - missing.length, remaining: missing.length, ignored: ignored.slice(0, 12), ignored_count: ignored.length, next_unprocessed: missing.slice(0, 12).map(s => s.uid), next_unprocessed_cursor: first ? `${mine.findIndex(s => s.uid === first.uid)}:${p.until(first)}` : null };
  });
  const report = () => {
    const requirements = repo.listRequirements(projectId, { includeDeleted: false });
    const state = svc.computeState(projectId, { persist: false });
    const scenarioCoverage = scenes.scenarioView(projectId).scenarioCoverage;
    return { documents: coverage(), requirements: { total: requirements.length, unverified: requirements.filter((r) => !r.quote_verified).map((r) => r.code) },
      scenarios: { total: scenarioCoverage.active, pending: scenarioCoverage.pending, confirmed: scenarioCoverage.confirmed,
        requirement_coverage: { total: scenarioCoverage.total, classified: scenarioCoverage.classified, unmapped: scenarioCoverage.unmapped } },
      pbs: { items: repo.listItems(projectId).length, uncovered: repo.listItems(projectId).length ? state.view.uncovered : requirements.filter((r) => !["商务", "资质", "背景", "范围外"].includes(r.category)).map((r) => r.code), conflicts: state.conflicts ?? [], pending_quantity: state.view.steps.pbs.pendingQty, blockers: state.view.steps.pbs.blockers, findings: state.view.audit.slice(0, 30), findings_total: state.view.audit.length },
      questions: repo.listQuestions(projectId).filter((q) => q.status !== "已忽略").map(({ id, question, status }) => ({ id, question, status })), calls, finished };
  };
  const batch = (items, save) => {
    const accepted = [], errors = [];
    items.forEach((item, index) => { try { accepted.push({ index, ...tx(() => save(item)) }); } catch (error) { errors.push({ index, message: error.message }); } });
    return { accepted, errors };
  };
  const recordCoverage = (source, version, status, reason = "") => {
    const previous = getDb().prepare("SELECT processed_until FROM agent_coverage WHERE project_id=? AND evidence_id=? AND document_version=?").get(projectId, source.uid, version);
    const before = previous ? previous.processed_until ?? source.text.length : 0;
    // Long sources commit only the contiguous portion read in this activation.
    // Reading alone never advances durable processing coverage.
    const processed = Math.max(before, readThrough.get(`${version}:${source.uid}`) ?? (previous ? before : source.text.length <= 6000 ? source.text.length : 0));
    getDb().prepare("INSERT OR REPLACE INTO agent_coverage(project_id,evidence_id,document_version,status,reason,processed_until) VALUES (?,?,?,?,?,?)").run(projectId, source.uid, version, status, reason, processed);
    return source.text.length > 6 && processed > before;
  };

  const handlers = {
    project_state() {
      const { template, sizing } = catalog.runtimeConfig(projectId);
      return { project: repo.getProject(projectId), documents: coverage(), workspace_version: solutions.projectInputHash(projectId), pbs_version: solutions.projectInputHash(projectId), groups: template.level1, params: sizing.params, resolved_params: svc.computeState(projectId, { persist: false }).view.params,
        counts: { requirements: repo.listRequirements(projectId, { includeDeleted: false }).length, scenarios: scenes.listScenarios(projectId).length, pbs: repo.listItems(projectId).length },
        products: repo.listProducts().filter((p) => p.metadata.active !== false).map(({ id, name, summary }) => ({ id, name, summary })), questions: report().questions,
        pbs_items: repo.listItems(projectId).slice(0, 80).map(({ id, code, name, qty, unit, product_ref }) => ({ id, code, name, qty, unit, product_ref })) };
    },
    list_document_sections(args) {
      const d = document(args.document_id), p = progress(d);
      return { document: d, ...page(sources().filter((s) => docId(s.material_id) === d.document_id).map((s) => ({ evidence_id: s.uid, chapter: s.chapter, excerpt: s.text.slice(0, 120), length: s.text.length, processed: !p.pending(s) })), args, 30) };
    },
    read_document_batch(args) {
      const d = document(args.document_id);
      if ((args.cursor && !args.document_version) || (args.document_version && args.document_version !== d.document_version)) return err("VERSION_CONFLICT", "分页必须携带原文版本，材料变化后请重新读取");
      const mine = sources().filter((s) => docId(s.material_id) === d.document_id);
      const p = progress(d);
      const [start, offset] = (args.cursor ?? "0:0").split(":").map(Number);
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(offset) || offset < 0 || start > mine.length) throw new Error("文档游标无效，请原样使用next_cursor或run_report中的next_unprocessed_cursor，并携带document_version");
      const items = []; let chars = 0, index = start, at = offset;
      for (; index < mine.length && items.length < (args.limit ?? 60) && chars < 6000; index++) {
        const s = mine[index];
        if (at > s.text.length) throw new Error("文档游标位置无效");
        if (args.unprocessed_only) {
          if (!p.pending(s)) { at = 0; continue; }
          at = Math.max(at, p.until(s));
        }
        const text = s.text.slice(at, at + 6000 - chars);
        const key = `${d.document_version}:${s.uid}`, through = readThrough.get(key) ?? p.until(s);
        if (at <= through) readThrough.set(key, Math.max(through, at + text.length));
        items.push({ ...evidence(s, d), text, source_start: at, source_length: s.text.length });
        chars += text.length;
        at += text.length;
        if (at < s.text.length) break;
        at = 0;
      }
      return { document: d, items, next_cursor: index < mine.length ? `${index}:${at}` : null, ...(args.unprocessed_only ? { handling_hint: "本批仅含未处理原文；先保存本批需求和ignored处理记录，再沿next_cursor继续。暂时无法处理的片段保留待办，用run_report回查。" } : {}) };
    },
    read_evidence(args) {
      if (/^product-chunk:\d+$/.test(args.evidence_id)) {
        const [chunk] = rag.getChunks([Number(args.evidence_id.split(":")[1])]);
        if (!chunk) return err("EVIDENCE_NOT_FOUND", "产品依据不存在");
        if (args.document_version && args.document_version !== chunk.hash) return err("VERSION_CONFLICT", "产品依据版本不匹配");
        return { source: { evidence_id: args.evidence_id, document_id: `product:${chunk.product_id ?? chunk.doc_id}`, document_version: chunk.hash, text: chunk.text, product_id: chunk.product_id, active: Boolean(chunk.active) }, neighbors: [] };
      }
      const all = sources(); const s = all.find((s) => s.uid === args.evidence_id);
      if (!s) return err("EVIDENCE_NOT_FOUND", "来源不存在或不属于当前项目");
      const d = document(docId(s.material_id));
      if (args.document_version && args.document_version !== d.document_version) return err("VERSION_CONFLICT", "材料版本已变化，请重新读取目录", d);
      const mine = all.filter((v) => v.material_id === s.material_id); const i = mine.findIndex((v) => v.uid === s.uid); const n = args.neighbors ?? 1;
      return { source: { ...evidence(s, d), text: s.text.slice(0, 6000), truncated: s.text.length > 6000, ...(s.text.length > 6000 ? { next_cursor: `${i}:6000` } : {}) }, neighbors: mine.slice(Math.max(0, i - n), i + n + 1).filter((v) => v.uid !== s.uid).map((v) => ({ ...evidence(v, d), text: v.text.slice(0, 1000), truncated: v.text.length > 1000 })) };
    },
    async search_evidence(args) {
      if (args.domain === "products") {
        const [hits] = await rag.search([args.query], { topK: args.limit ?? 8 });
        return { hits: hits.map(({ chunk, score }) => ({ evidence_id: `product-chunk:${chunk.id}`, document_version: chunk.hash, text: chunk.text, product_id: chunk.product_id, score })), mode: rag.retrievalMode() };
      }
      const terms = [...new Set(normalize(args.query).match(/.{1,2}/gu) ?? [])];
      const docs = documents();
      const hits = sources().map((s) => ({ s, score: terms.reduce((n, t) => n + Number(normalize(s.text).includes(t)), 0) })).filter((v) => v.score).sort((a, b) => b.score - a.score).slice(0, args.limit ?? 8);
      return { hits: hits.map(({ s, score }) => ({ ...evidence(s, docs.find((d) => d.document_id === docId(s.material_id))), score })) };
    },
    list_requirements: (args) => page(repo.listRequirements(projectId, { includeDeleted: false }).filter((r) => !args.unverified_only || !r.quote_verified), args, 50),
    list_scenarios: (args) => page(scenes.listScenarios(projectId).filter((s) => s.status !== "已归档").map((s) => ({ ...s, evidence: s.evidence.map(({ source_text, ...e }) => e) })), args, 20),
    list_pbs: (args) => page(repo.listItems(projectId), args, 30),
    submit_requirements(args) {
      const d = document(args.document_id);
      if (d.document_version !== args.document_version) return err("VERSION_CONFLICT", "材料版本已变化，请重新读取");
      const all = sources().filter((s) => docId(s.material_id) === d.document_id);
      const { sizing } = catalog.runtimeConfig(projectId);
      const out = batch(args.requirements, (r) => {
        const source = all.find((s) => s.uid === r.evidence_id);
        if (!source || !r.quote.trim() || !normalize(source.text).includes(normalize(r.quote))) throw new Error("QUOTE_MISMATCH：quote必须为对应原文片段的连续引用，请read_evidence回查");
        if (!r.text.trim()) throw new Error("需求内容不能为空");
        if (d.kind === "tender" && r.inferred) throw new Error("TENDER_INFERENCE：招标需求仅接受有原文依据的要求，不能将推断作为原文事实保存；请回查并修正需求，或记录待澄清问题");
        const params = [], rejected = [];
        for (const p of r.params ?? []) {
          const spec = sizing.params[p.name];
          const reason = checkParam(p, spec, normalize(source.text));
          const value = { ...p, label: spec?.label ?? p.name, unit: spec?.unit ?? "" };
          if (reason) rejected.push({ ...value, reason });
          else params.push(value);
        }
        const existing = repo.listRequirements(projectId, { includeDeleted: false }).find((v) => v.seg_uid === source.uid && normalize(v.text) === normalize(r.text));
        if (existing) {
          if (!existing.edited && existing.status === "待确认" && existing.origin === "系统") repo.updateRequirement(projectId, existing.code, { quote: r.quote, quote_verified: true, revision: existing.revision + 1 });
          const advanced = recordCoverage(source, d.document_version, "requirement"); return { code: existing.code, kept: true, advanced };
        }
        const code = repo.insertRequirement(projectId, { text: r.text, seg_uid: source.uid, quote: r.quote, quote_verified: true, category: r.category, priority: r.priority, inferred: Boolean(r.inferred), star: source.star, triangle: source.triangle, params, rejected_params: rejected, ord: source.ord * 10 });
        const advanced = recordCoverage(source, d.document_version, "requirement"); return { code, rejected_params: rejected, advanced };
      });
      const ignored = batch(args.ignored ?? [], (v) => {
        const source = all.find(s => s.uid === v.evidence_id);
        if (!source || !v.reason.trim()) throw new Error("忽略必须引用真实片段并填写原因");
        const advanced = recordCoverage(source, d.document_version, "ignored", v.reason); return { evidence_id: v.evidence_id, advanced };
      });
      const c = coverage().find((v) => v.document_id === d.document_id);
      if (!c.remaining) repo.markExtracted(all[0]?.material_id ?? -1);
      repo.touchProject(projectId);
      return { ...out, ignored, coverage: c };
    },
    submit_scenarios(args) {
      if (args.expected_version !== solutions.projectInputHash(projectId)) return err("VERSION_CONFLICT", "项目内容已变化，请重新读取project_state并核对需求后提交");
      return { ...batch(args.scenarios, (s) => scenes.submitAgentScenario(projectId, s)), workspace_version: solutions.projectInputHash(projectId) };
    },
    submit_questions: (args) => batch(args.questions, (q) => {
      const same = repo.listQuestions(projectId).find((v) => v.question === q.question);
      if (same) return { id: same.id, kept: true };
      const links = scenes.validateQuestionLinks(projectId, q);
      repo.insertQuestion(projectId, { ...q, ...links, source: "Agent分析" });
      return { id: repo.listQuestions(projectId).find((v) => v.question === q.question).id };
    }),
    read_product(args) {
      const product = repo.getProduct(args.product_id);
      if (!product) return err("PRODUCT_NOT_FOUND", "产品不存在");
      return { product, bom: catalog.readCatalog()?.pack.boms.filter((b) => b.product_ref === product.id) ?? [], documents: repo.listDocs(product.id) };
    },
    submit_pbs: (args) => svc.submitAgentPbs(projectId, { ...args, approved_scope: pbsScope?.() }),
    submit_solutions: (args) => ({ solutions: solutions.saveProjectSolutions(projectId, args.solutions, args.expected_version) }),
    propose_change: (args) => ({ card: proposeAgentChange(projectId, args.action) }),
    run_report: report,
    finish_task(args) {
      const r = report();
      finished = { summary: args.summary, remaining: args.remaining ?? [], state: r.requirements.unverified.length || r.documents.some((d) => d.remaining || d.ignored_count) || (r.pbs.items && (r.pbs.uncovered.length || r.pbs.conflicts.length || r.pbs.pending_quantity || r.pbs.blockers)) || (args.remaining?.length ?? 0) ? "needs_review" : "draft_ready" };
      return { ...finished, report: r };
    },
  };

  return { report, get finished() { return finished; }, async execute(name, args) {
    if (signal?.aborted) return err("RUN_CANCELLED", "任务已停止");
    if (++calls > maxCalls) return err("BUDGET_EXHAUSTED", "工具调用预算已用完，保留成果并结束本次工作");
    const definition = TOOLS.find((t) => t.name === name);
    if (!definition) return err("UNKNOWN_TOOL", "工具不存在");
    try {
      validateArguments(definition.inputSchema, args);
      onProgress(name);
      if (definition.annotations.readOnlyHint || !args.operation_id) {
        const data = await handlers[name](args);
        return data?.ok === false ? data : { ok: true, data };
      }
      // All write handlers are synchronous, so transaction completion precedes the response.
      return tx((db) => {
        signal?.throwIfAborted();
        checkWrite(name, args);
        const operationId = operationScope ? `${operationScope}:${args.operation_id}` : args.operation_id;
        const input = hash({ name, args });
        const old = db.prepare("SELECT * FROM agent_operations WHERE project_id=? AND operation_id=?").get(projectId, operationId);
        if (old) return old.input_hash === input ? parse(old.result, {}) : err("OPERATION_CONFLICT", "operation_id已用于不同内容，请使用新编号");
        const data = handlers[name](args);
        const result = data?.ok === false ? data : { ok: true, data };
        if (result.ok) db.prepare("INSERT INTO agent_operations(project_id,operation_id,tool,input_hash,result,created_at) VALUES (?,?,?,?,?,?)").run(projectId, operationId, name, input, json(result), now());
        return result;
      });
    } catch (error) { return err(error.status === 409 ? "VERSION_CONFLICT" : "VALIDATION_ERROR", error.message); }
  } };
}
