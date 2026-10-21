import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as scenes from "../server/scenarios.mjs";
import { proposeAgentChange, resolveCard } from "../server/chat.mjs";
import * as rag from "../server/rag.mjs";
import { segmentText } from "../engine/segment.mjs";
import { exportProject } from "../server/xlsx.mjs";

import { collaborationAdapter } from "../server/collaboration-tools.mjs";
import { createCollaboration } from "../server/collaboration.mjs";
import { nextActivation } from "../server/collaboration-store.mjs";
import { projectInputHash } from "../server/project-solutions.mjs";
import { approvalPreview, approveUnderstanding } from "../server/collaboration-approval.mjs";
const submitPbs = items => svc.submitAgentPbs(project, { expected_version: projectInputHash(project), items });
const material = `# 道路巡查\n## 技术要求\n2.1.1 支持夜间巡逻，发现路面交通事故。\n识别准确率不低于90%。\n2.1.2 发现事故后自动通知值班人员。\n2.1.3 数据须在局内机房保存不少于90天。\n2.1.4 本期不包括渣土车监管。`;
let project, materialId;
const clone = (v) => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  resetDb(":memory:");
  svc.rebuildIndex();
  rag.setRetrievalMode({ kind: "keyword", model: null, reason: "test" });
  project = repo.createProject({ name: "巡查", industry: "公安" }).id;
  materialId = svc.addMaterial(project, { kind: "tender", title: "测试标书", text: material });
  for (const [index, segment] of repo.listSegments(project).entries()) repo.insertRequirement(project, { seg_uid: segment.uid, text: segment.text, quote: segment.text, quote_verified: true, category: index === 3 ? "范围外" : index === 2 ? "安全" : "功能", priority: "必须" });
});

function draft(name = "道路事故发现与通知") {
  return {
    scenarios: [{ key: "s1", name, goal: "发现道路事故并通知值班人员", actors: [], context: "夜间", trigger: "发现道路事故", activities: [{ text: "夜间巡逻发现交通事故", req_ids: ["R001"] }, { text: "通知值班人员", req_ids: ["R002"] }], outcomes: [], boundaries: [], assumptions: [], links: [{ req_id: "R001", role: "核心要求" }, { req_id: "R002", role: "核心要求" }], evidence: [{ field_path: "activities.0.text", seg_uid: "M1:2.1.1", quote: "支持夜间巡逻，发现路面交通事故。" }, { field_path: "activities.1.text", seg_uid: "M1:2.1.2", quote: "自动通知值班人员" }], questions: [{ question: "由谁发起通知，是否有送达要求？", req_ids: ["R002"], field_paths: ["actors", "outcomes"], reason: "发起角色和送达条件未明确", impact: "影响方案" }] }],
    dispositions: [{ req_id: "R003", kinds: ["跨场景约束"], scenario_keys: [], note: "数据部署和保存约束适用于整个项目" }, { req_id: "R004", kinds: ["范围外"], scenario_keys: [] }], notes: [],
  };
}
const model = (value) => ({ async json() { return clone(value); } });
async function generate(value = draft()) {
  for (const d of value.dispositions) {
    const current = scenes.scenarioView(project).dispositions.find(r => r.req_id === d.req_id);
    if (!current.edited) scenes.editDisposition(project, d.req_id, { ...current, kinds: d.kinds, note: d.note });
  }
  // Exercise current role tools; independent disposition edits represent the workspace review.
  const t = createCollaboration(project, { role: "understanding", goal: "整理场景" });
  const adapter = collaborationAdapter(t, nextActivation(t.id));
  for (const [i, candidate] of value.scenarios.entries()) {
    const { key, questions, ...scenario } = candidate;
    const saved = await adapter.execute("submit_scenarios", { operation_id: `scene-${i}`, expected_version: projectInputHash(project), scenarios: [scenario] });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(saved.data.errors, []);
    const code = saved.data.accepted[0].code;
    if (questions?.length) {
      const q = await adapter.execute("submit_questions", { operation_id: `questions-${key}`, questions: questions.map(q => ({ ...q, scenario_ids: [code] })) });
      assert.equal(q.ok, true); assert.deepEqual(q.data.errors, []);
    }
  }

}
function approveScope() {
  const preview = approvalPreview(project);
  const a = approveUnderstanding(project, { version: preview.version, requirements: preview.requirements.map(r => r.code), scenarios: preview.scenarios.map(s => s.code) });
  createCollaboration(project, { role: "pbs", approvalId: a.id, goal: "按确认范围复核" });
}
function item(req, scenarioIds = []) {
  const id = svc.saveItem(project, null, { parent: "1", name: `交付 ${req}`, source: "服务", req_ids: [req] });
  const row = repo.getItem(project, id);
  repo.saveItems(project, [{ ...row, confirmed: true, scenario_ids: scenarioIds }]);
  return id;
}

test("incremental scenario updates retain IDs, refresh requirement versions and protect human work", async () => {
  await generate();
  const previous = scenes.listScenarios(project)[0];
  const oldPbs = item("R002");
  svc.editRequirement(project, "R001", { text: "客户要求调整巡查业务范围" });
  const current = scenes.getScenario(project, previous.code);
  const raw = Object.fromEntries(Object.entries(draft().scenarios[0]).filter(([key]) => !["key", "questions"].includes(key)));
  raw.activities = raw.activities.slice(0, 1);
  raw.evidence = raw.evidence.slice(0, 1);
  raw.links = raw.links.slice(0, 1);
  const task = createCollaboration(project, { role: "understanding", goal: "增量适配" });
  const adapter = collaborationAdapter(task, nextActivation(task.id));
  const response = await adapter.execute("submit_scenarios", { operation_id: "update-association", expected_version: projectInputHash(project), scenarios: [{ ...raw, code: current.code, revision: current.revision }] });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.errors, []);
  const result = response.data.accepted[0];
  assert.equal(result.code, previous.code);
  assert.equal(scenes.listScenarios(project).length, 1);
  assert.deepEqual(result.changes.removed, ["R002"]);
  assert.deepEqual(result.changes.refreshed, ["R001"]);
  assert.equal(scenes.getScenario(project, result.code).links[0].req_revision, repo.getRequirement(project, "R001").revision);
  assert.ok(repo.getItem(project, oldPbs).stale, "removed links also invalidate PBS built on the old requirement");
  assert.notEqual(repo.getRequirement(project, "R002").status, "已删除");
  assert.throws(() => scenes.submitAgentScenario(project, { ...raw, code: result.code, revision: current.revision }), /已被修改/);
  assert.throws(() => scenes.submitAgentScenario(project, { name: raw.name, code: result.code, revision: result.revision, links: raw.links, evidence: raw.evidence }), /完整内容/);
  const manual = scenes.editScenario(project, result.code, { revision: result.revision, goal: "人工维护的业务目标" });
  assert.throws(() => scenes.submitAgentScenario(project, { ...raw, code: manual.code, revision: manual.revision }), /不能自动覆盖/);
  assert.equal(scenes.getScenario(project, manual.code).goal, "人工维护的业务目标");
  const card = proposeAgentChange(project, { type: "edit_scenario", code: manual.code, links: draft().scenarios[0].links });
  assert.equal(scenes.getScenario(project, manual.code).links.length, 1, "proposing must not overwrite manual relationships");
  const message = repo.addChat(project, "assistant", "补充关联建议", { cards: [card] });
  resolveCard(project, message, 0, "accept");
  assert.equal(scenes.getScenario(project, manual.code).links.length, 2, "acceptance applies the actual relationship change");
  assert.equal(scenes.getScenario(project, manual.code).goal, "人工维护的业务目标", "unrelated human fields remain intact");
});

test("saving reviewed associations refreshes their requirement snapshot without separate scene approval", async () => {
  await generate();
  svc.editRequirement(project, "R001", { text: "更新客户巡查要求" });
  const scene = scenes.listScenarios(project)[0];
  assert.equal(scene.status, "待复核");
  const saved = scenes.editScenario(project, scene.code, { revision: scene.revision });
  assert.equal(saved.links[0].req_revision, repo.getRequirement(project, "R001").revision);
  assert.equal(saved.status, "待确认", "persistence status remains a draft, without requiring a separate UI approval");
  const preview = approvalPreview(project);
  const approval = approveUnderstanding(project, { version: preview.version, requirements: preview.requirements.map(r => r.code), scenarios: [scene.code] });
  assert.equal(approval.snapshot.scenarios[0].status, "已确认");
});

test("numbered clause continuation and unnumbered introductions are not lost or appended across headings", () => {
  const doc = segmentText(material.replace("## 技术要求", "## 技术要求\n设备由中标方提供。"));
  assert.ok(doc.segments.find((s) => s.id === "2.1.1").text.includes("不低于90%"));
  assert.equal(doc.segments[0].id, "S001");
  const boundary = segmentText(material + "\n## 其他要求\n需单独出具部署说明。");
  assert.equal(boundary.segments.at(-1).text, "需单独出具部署说明。");
  assert.ok(!boundary.segments.find((s) => s.id === "2.1.4").text.includes("部署说明"));
});

test("generation saves source-grounded scenarios, questions and independent requirement dispositions", async () => {
  await generate();
  const view = svc.projectView(project);
  assert.equal(view.scenarios.length, 1);
  assert.equal(view.scenarios[0].code, "SC001");
  assert.equal(view.scenarios[0].status, "待确认");
  assert.deepEqual(view.scenarios[0].actors, [], "unknown actors are not supplied by a default");
  assert.ok(view.scenarios[0].evidence.every((e) => e.source_text.includes(e.quote) && e.end > e.start));
  assert.equal(view.questions[0].scenario_ids[0], "SC001");
  assert.deepEqual(view.dispositions.find((d) => d.req_id === "R003").kinds, ["跨场景约束"]);
  assert.deepEqual(view.dispositions.find((d) => d.req_id === "R004").kinds, ["范围外"]);
  assert.equal(view.scenarioCoverage.classified, 4);
  assert.ok(view.requirements.find((r) => r.code === "R001").scenario_ids.includes("SC001"));
});

test("bad quotes and fabricated numbers cannot overwrite an existing scenario", async () => {
  await generate();
  const bad = draft().scenarios[0]; bad.evidence[0].quote = "根本不存在的引用"; bad.goal = "30秒送达";
  assert.throws(() => scenes.submitAgentScenario(project, bad), /引用|数字/);
  assert.equal(scenes.listScenarios(project).length, 1);
});


test("repeated Agent submissions preserve protected human scenarios", async () => {
  await generate();
  scenes.editScenario(project, "SC001", { revision: 1, goal: "人工完善的目标" });
  await generate();
  assert.equal(scenes.getScenario(project, "SC001").goal, "人工完善的目标");
  assert.equal(scenes.listScenarios(project).length, 1);
});


test("replacement drafts retain old IDs and immutable revision history", async () => {
  await generate();
  scenes.editScenario(project, "SC001", { revision: 1, status: "已归档", reason: "改用新的巡查场景" });
  await generate(draft("改进后的巡查场景"));
  assert.equal(scenes.getScenario(project, "SC001").status, "已归档");
  assert.equal(scenes.getScenario(project, "SC002").status, "待确认");
  assert.equal(scenes.revisions(project, "SC001").length, 2);
  assert.equal(scenes.revisions(project, "SC001")[1].snapshot.status, "待确认");
});

test("editing, confirmation and stale propagation use explicit versions and affect only related PBS", async () => {
  await generate();
  const related = item("R001", ["SC001"]), unrelated = item("R003");
  scenes.confirmScenarios(project, { scenarios: [{ code: "SC001", revision: 1 }] });
  assert.equal(scenes.getScenario(project, "SC001").status, "已确认", "open questions remain separate from description confirmation");
  scenes.editScenario(project, "SC001", { revision: 2, goal: "人工调整目标" });
  assert.equal(scenes.getScenario(project, "SC001").status, "待确认");
  assert.equal(repo.getItem(project, related).confirmed, false);
  assert.equal(repo.getItem(project, unrelated).confirmed, true);
  assert.throws(() => scenes.editScenario(project, "SC001", { revision: 2, goal: "覆盖新版本" }), /重新加载/);
  assert.throws(() => svc.confirmItems(project, [related]), /场景/);
});

test("split and merge retain lineage and cannot silently omit requirements", async () => {
  await generate();
  const source = scenes.getScenario(project, "SC001");
  const first = { ...clone(source), name: "巡查", links: source.links.slice(0, 1), activities: source.activities.slice(0, 1), evidence: source.evidence.slice(0, 1) };
  assert.throws(() => scenes.restructure(project, { originals: [{ code: source.code, revision: source.revision }], replacements: [first] }), /不能遗漏需求/);
  assert.equal(scenes.getScenario(project, source.code).status, "待确认");
  const second = { ...clone(source), name: "通知", links: source.links.slice(1), activities: source.activities.slice(1), evidence: source.evidence.slice(1).map((e) => ({ ...e, field_path: "activities.0.text" })) };
  const split = scenes.restructure(project, { originals: [{ code: source.code, revision: source.revision }], replacements: [first, second] });
  assert.deepEqual(split.codes, ["SC002", "SC003"]);
  assert.deepEqual(scenes.getScenario(project, "SC002").supersedes, ["SC001"]);
  assert.equal(scenes.getScenario(project, "SC001").status, "已归档");
  const merged = scenes.restructure(project, { originals: split.codes.map((code) => ({ code, revision: 1 })), replacements: [source] });
  assert.equal(scenes.getScenario(project, merged.codes[0]).status, "待确认");
  assert.deepEqual(scenes.getScenario(project, merged.codes[0]).supersedes, split.codes);
});

test("customer answers propose field changes; formal conflicts need recorded resolution and updates stay reviewable", async () => {
  await generate();
  const q = repo.listQuestions(project)[0];
  const llm = model({ summary: "明确通知角色", changes: [{ type: "update_scenario", code: "SC001", field_path: "actors", value: ["值班调度员"], quote: "由值班调度员发起通知" }] });
  const proposal = await svc.proposeAnswer(project, q.id, { answer: "由值班调度员发起通知", answer_source: "答疑文件" }, llm);
  assert.equal(scenes.getScenario(project, "SC001").actors.length, 0, "proposal does not mutate the scenario");
  assert.ok(proposal.changes[0].conflict);
  assert.throws(() => svc.applyAnswer(project, q.id, [0]), /处理依据/);
  svc.applyAnswer(project, q.id, [0], "正式答疑明确了原条款未规定的发起角色");
  const scene = scenes.getScenario(project, "SC001");
  assert.deepEqual(scene.actors, ["值班调度员"]);
  assert.equal(scene.status, "待复核");
  assert.ok(scene.evidence.some((e) => e.kind === "answer" && e.quote === "由值班调度员发起通知"));
  assert.equal(repo.getQuestion(project, q.id).applied.resolution_note, "正式答疑明确了原条款未规定的发起角色");
  svc.applyAnswer(project, q.id, [0], "重复请求");
  assert.equal(scenes.getScenario(project, "SC001").revision, scene.revision, "reapplying an answer is idempotent");
});

test("answer suggestions cannot apply after the scene changes or with ungrounded quotes", async () => {
  await generate();
  const q = repo.listQuestions(project)[0];
  const good = { type: "update_scenario", code: "SC001", field_path: "trigger", value: "值班人员确认事故", quote: "确认事故后通知" };
  const p = await svc.proposeAnswer(project, q.id, { answer: "确认事故后通知" }, model({ changes: [good, { ...good, quote: "伪造引用" }] }));
  assert.equal(p.changes.length, 1);
  scenes.editScenario(project, "SC001", { revision: 1, goal: "新目标" });
  assert.throws(() => svc.applyAnswer(project, q.id, [0], "答疑依据"), /重新分析/);
});

test("deleting materials preserves source snapshots and IDs while flagging affected results", async () => {
  await generate();
  const id = item("R001", ["SC001"]);
  svc.deleteMaterial(project, materialId);
  assert.equal(scenes.getScenario(project, "SC001").status, "待复核");
  assert.equal(repo.getItem(project, id).confirmed, false);
  assert.equal(repo.getRequirement(project, "R001").quote_verified, false);
  assert.ok(repo.listSourceSnapshots(project).some((s) => s.uid === "M1:2.1.1" && !s.active && s.text.includes("90%")));
  svc.addMaterial(project, { kind: "oral", title: "新材料", text: "客户补充说明，需要继续支持夜间巡查与值班人员通知。" });
  assert.equal(repo.listMaterials(project)[0].no, 2, "source material IDs are not reused");
});

test("shared source spans support multiple requirements and cross-project references are refused", () => {
  const first = draft().scenarios[0];
  const other = { ...clone(first), name: "另一个场景", activities: first.activities.slice(0, 1), links: first.links.slice(0, 1), evidence: first.evidence.slice(0, 1) };
  scenes.addScenario(project, first); scenes.addScenario(project, other);
  assert.equal(scenes.scenarioView(project).dispositions.find((d) => d.req_id === "R001").linked_scenarios.length, 2);
  const foreign = repo.createProject({ name: "其他项目" }).id;
  assert.throws(() => scenes.addScenario(foreign, first), /不存在/);
  assert.throws(() => scenes.validateQuestionLinks(project, { scenario_ids: ["SC999"] }), /不存在/);
});

test("index rebuilds preserve evidence IDs; changed product passages remain readable but stop being current", async () => {
  const chunk = getDb().prepare("SELECT * FROM chunks WHERE product_id = 'P06' AND kind = 'capability' LIMIT 1").get();
  const id = item("R001");
  repo.saveItems(project, [{ ...repo.getItem(project, id), evidence_chunks: [chunk.id] }]);
  svc.rebuildIndex();
  assert.equal(rag.getChunks([chunk.id])[0].active, 1);
  assert.equal(repo.getItem(project, id).confirmed, true);
  const product = repo.getProduct("P06");
  svc.saveProduct("P06", { ...product, capabilities: ["新的测试能力"] });
  assert.equal(rag.getChunks([chunk.id])[0].text, chunk.text);
  assert.equal(rag.getChunks([chunk.id])[0].active, 0);
  assert.equal(repo.getItem(project, id).confirmed, false);
  const [hits] = await rag.search([chunk.text], { kinds: ["capability"], topK: 100 });
  assert.ok(!hits.some((h) => h.chunk.id === chunk.id));
});





test("v2 databases migrate without losing reviewed requirements, materials or PBS", () => {
  const dir = mkdtempSync(join(tmpdir(), "pbs-migration-"));
  try {
    const file = join(dir, "old.db"); resetDb(file);
    const oldProject = repo.createProject({ name: "历史项目" }).id;
    svc.addMaterial(oldProject, { kind: "oral", title: "旧材料", text: "客户希望保留夜间巡查能力，事故发现后通知值班人员。" });
    repo.insertRequirement(oldProject, { text: "保留人工成果", category: "功能", priority: "重要", status: "已确认", edited: true });
    const oldItem = svc.saveItem(oldProject, null, { parent: "1", name: "历史确认交付", source: "服务", req_ids: ["R001"], qty: 5 });
    svc.confirmItems(oldProject, [oldItem]);
    getDb().prepare("INSERT INTO agent_coverage(project_id,evidence_id,document_version,status,reason) VALUES (?,?,?,?,?)").run(oldProject, "M1:legacy", "legacy-version", "ignored", "历史目录处理记录");
    for (const [table, column] of [["pbs_items", "reviewed"], ["pbs_items", "scenario_ids"], ["requirements", "revision"], ["requirements", "retired"], ["requirements", "answer_evidence"], ["questions", "scenario_ids"], ["questions", "field_paths"], ["chunks", "active"], ["agent_coverage", "processed_until"]]) getDb().exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    getDb().exec("DROP TABLE source_snapshots; UPDATE meta SET value = '2' WHERE key = 'schema'");
    resetDb(file);
    assert.equal(repo.getRequirement(oldProject, "R001").text, "保留人工成果");
    assert.equal(repo.getRequirement(oldProject, "R001").status, "已确认");
    assert.ok(repo.listSourceSnapshots(oldProject).length);
    assert.equal(repo.getItem(oldProject, oldItem).qty, 5);
    assert.equal(repo.getItem(oldProject, oldItem).confirmed, true);
    assert.equal(repo.getItem(oldProject, oldItem).reviewed, true);
    assert.equal(getDb().prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, "8");
    const coverage = getDb().prepare("SELECT * FROM agent_coverage WHERE project_id=?").get(oldProject);
    assert.equal(coverage.status, "ignored");
    assert.equal(coverage.reason, "历史目录处理记录");
    assert.equal(coverage.processed_until, null);
    assert.equal(scenes.listScenarios(oldProject).length, 0);
  } finally { resetDb(":memory:"); rmSync(dir, { recursive: true, force: true }); }
});

test("PBS receives scenario context, retains scenarios across regeneration, and export contains trace sheets", async () => {
  await generate();
  submitPbs([{ parent: "1", name: "事故识别", source: "自有产品", product_ref: "P06", matched_capabilities: ["交通事故识别"], req_ids: ["R001"], scenario_ids: ["SC001"] }]);
  const view = svc.projectView(project);
  assert.equal(view.scenarios.length, 1);
  const matched = view.items.find((i) => i.req_ids.includes("R001"));
  assert.ok(matched.scenario_ids.includes("SC001"));
  assert.equal(matched.confirmed, false);
  assert.ok(matched.stale);
  const buffer = await exportProject(view);
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
  assert.deepEqual(book.worksheets.map(s => s.name), ["导出前检查", "PBS 清单", "需求对应表", "场景需求", "需求处理去向", "澄清问题", "测算参数", "审核结果"]);
  assert.equal(book.getWorksheet("场景需求").getRow(2).getCell(1).value, "SC001");
  assert.equal(book.getWorksheet("需求处理去向").rowCount, 5);
});





test("constraint scopes follow split lineage and use their own optimistic version", async () => {
  await generate();
  const d = scenes.scenarioView(project).dispositions.find((d) => d.req_id === "R003");
  scenes.editDisposition(project, "R003", { ...d, scenario_ids: ["SC001"] });
  assert.throws(() => scenes.editDisposition(project, "R003", d), /处理去向已变化/);
  const source = scenes.getScenario(project, "SC001");
  const replacements = [clone(source), { ...clone(source), name: "另一个业务目标" }];
  const result = scenes.restructure(project, { originals: [{ code: source.code, revision: source.revision }], replacements });
  const moved = scenes.scenarioView(project).dispositions.find((d) => d.req_id === "R003");
  assert.deepEqual(moved.scenario_ids, result.codes);
  scenes.markAffected(project, ["R003"], "约束条件变化");
  assert.ok(result.codes.every((code) => scenes.getScenario(project, code).status === "待复核"));
});

test("clients cannot fabricate clarification evidence, and scope exclusions cannot become PBS deliverables", async () => {
  await generate();
  const scene = scenes.getScenario(project, "SC001");
  assert.throws(() => scenes.editScenario(project, scene.code, { ...scene, evidence: [...scene.evidence, { kind: "answer", question_id: 999, field_path: "goal", quote: "伪造答复", answer_snapshot: "伪造答复" }] }), /原文引用不存在/);
  assert.throws(() => svc.saveItem(project, null, { parent: "1", name: "范围外项目", source: "服务", req_ids: ["R004"] }), /关联需求/);
});

test("confirmed PBS items keep their ID and content when unedited items are regenerated", async () => {
  await generate();
  for (const q of repo.listQuestions(project)) repo.updateQuestion(project, q.id, { status: "已忽略" });
  scenes.confirmScenarios(project, { scenarios: [{ code: "SC001", revision: 1 }] });
  const id = item("R001", ["SC001"]);
  const protectedItem = repo.getItem(project, id);
  repo.saveItems(project, [{ ...protectedItem, edited: false }]);
  submitPbs([]);
  assert.equal(repo.getItem(project, id).name, protectedItem.name);
  assert.equal(repo.getItem(project, id).confirmed, true);
});

test("PBS submitted against an outdated project preserves existing rows", async () => {
  await generate();
  const id = item("R001", ["SC001"]), version = projectInputHash(project);
  const previous = repo.getItem(project, id).name;
  svc.editRequirement(project, "R001", { text: "客户要求增加巡查范围" });
  assert.throws(() => svc.submitAgentPbs(project, { expected_version: version, items: [] }), /项目已变化/);
  assert.equal(repo.getItem(project, id).name, previous);
});


test("a rematch suggestion cannot overwrite a later manual edit", async () => {
  const id = item("R001");
  approveScope();
  const result = await svc.rematchItem(project, id, { llm: model({ node: { name: "巡查服务", parent: "1", source: "服务" } }) });
  svc.saveItem(project, id, { name: "人工修改后的巡查服务" });
  assert.throws(() => svc.acceptRematch(project, id, result.suggestion), /重新匹配/);
  assert.equal(repo.getItem(project, id).name, "人工修改后的巡查服务");
});


test("previously reviewed PBS is retained after an upstream edit invalidates its confirmation", async () => {
  await generate();
  for (const q of repo.listQuestions(project)) repo.updateQuestion(project, q.id, { status: "已忽略" });
  scenes.confirmScenarios(project, { scenarios: [{ code: "SC001", revision: 1 }] });
  const id = item("R001", ["SC001"]);
  repo.saveItems(project, [{ ...repo.getItem(project, id), edited: false }]);
  svc.confirmItems(project, [id]);
  svc.editRequirement(project, "R001", { text: "修改后的巡查要求" });
  assert.equal(repo.getItem(project, id).confirmed, false);
  assert.equal(repo.getItem(project, id).reviewed, true);
  submitPbs([]);
  assert.equal(repo.getItem(project, id).name, "交付 R001");
  assert.equal(repo.getItem(project, id).confirmed, false);
});
