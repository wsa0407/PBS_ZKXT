import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as scenes from "../server/scenarios.mjs";
import * as rag from "../server/rag.mjs";
import { segmentText } from "../engine/segment.mjs";
import { exportProject } from "../server/xlsx.mjs";

const progress = { step() {}, detail() {} };
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
const generate = (value = draft(), extra = {}) => scenes.generateScenarios(project, { llm: model(value), progress, ...extra });
function item(req, scenarioIds = []) {
  const id = svc.saveItem(project, null, { parent: "1", name: `交付 ${req}`, source: "服务", req_ids: [req] });
  const row = repo.getItem(project, id);
  repo.saveItems(project, [{ ...row, confirmed: true, scenario_ids: scenarioIds }]);
  return id;
}

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

test("bad quotes and fabricated numbers are rejected with one repair attempt, preserving old results", async () => {
  await generate();
  let calls = 0;
  const bad = draft(); bad.scenarios[0].evidence[0].quote = "根本不存在的引用"; bad.scenarios[0].goal = "30秒送达";
  await assert.rejects(scenes.generateScenarios(project, { progress, llm: { async json() { calls++; return clone(bad); } } }), /校验失败/);
  assert.equal(calls, 2);
  assert.equal(scenes.getScenario(project, "SC001").status, "待确认");
  assert.equal(scenes.listScenarios(project).length, 1);
});

test("completed generation requests are idempotent and protected human work is never overwritten", async () => {
  const result = await generate(draft(), { requestId: "same-request" });
  const repeat = await scenes.generateScenarios(project, { requestId: "same-request", progress, llm: { json() { throw Error("must not run"); } } });
  assert.deepEqual(repeat, result);
  scenes.editScenario(project, "SC001", { revision: 1, goal: "人工完善的目标" });
  await generate();
  assert.equal(scenes.getScenario(project, "SC001").goal, "人工完善的目标");
  assert.equal(scenes.listScenarios(project).length, 1);
});

test("replacement drafts retain old IDs and immutable revision history", async () => {
  await generate();
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

test("generation detects changes while a model is running and does not save partial results", async () => {
  await generate();
  const llm = { async json() { repo.updateRequirement(project, "R001", { text: "客户更正了巡查要求", revision: 2 }); return draft("过时的输出"); } };
  await assert.rejects(scenes.generateScenarios(project, { llm, progress }), /生成期间项目内容已变化/);
  assert.equal(scenes.listScenarios(project).length, 1);
  assert.equal(scenes.getScenario(project, "SC001").status, "待确认");
});

test("re-extraction reuses unchanged IDs and retains replaced requirements as history", async () => {
  const llm = { async json({ step }) {
    if (step === "clarify") return { questions: [] };
    return { requirements: [{ seg_id: "2.1.1", text: repo.getRequirement(project, "R001").text, quote: repo.getRequirement(project, "R001").quote, category: "功能", priority: "必须" }] };
  } };
  await generate();
  await svc.analyzeMaterials(project, { all: true, llm, progress });
  assert.equal(repo.getRequirement(project, "R001").retired, false);
  assert.equal(repo.getRequirement(project, "R002").retired, true);
  assert.equal(scenes.getScenario(project, "SC001").status, "待复核");
  assert.equal(repo.nextReqCode(project), "R005");
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
    for (const [table, column] of [["pbs_items", "reviewed"], ["pbs_items", "scenario_ids"], ["requirements", "revision"], ["requirements", "retired"], ["requirements", "answer_evidence"], ["questions", "scenario_ids"], ["questions", "field_paths"], ["chunks", "active"]]) getDb().exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    getDb().exec("DROP TABLE source_snapshots; UPDATE meta SET value = '2' WHERE key = 'schema'");
    resetDb(file);
    assert.equal(repo.getRequirement(oldProject, "R001").text, "保留人工成果");
    assert.equal(repo.getRequirement(oldProject, "R001").status, "已确认");
    assert.ok(repo.listSourceSnapshots(oldProject).length);
    assert.equal(repo.getItem(oldProject, oldItem).qty, 5);
    assert.equal(repo.getItem(oldProject, oldItem).confirmed, true);
    assert.equal(repo.getItem(oldProject, oldItem).reviewed, true);
    assert.equal(getDb().prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, "3");
    assert.equal(scenes.listScenarios(oldProject).length, 0);
  } finally { resetDb(":memory:"); rmSync(dir, { recursive: true, force: true }); }
});

test("PBS receives scenario context, retains scenarios across regeneration, and export contains trace sheets", async () => {
  await generate();
  let sawContext = false;
  const llm = { async json({ step, user }) {
    if (step === "pbs") { sawContext = user.includes("SC001") && user.includes("由谁发起通知") && user.includes("跨场景约束"); return { nodes: [{ code: "1.1", parent: "1", name: "事故识别", source: "自有产品", product_ref: "P06", matched_capabilities: ["交通事故识别"], req_ids: ["R001"] }], conflicts: [] }; }
    return { links: [], new_nodes: [] };
  } };
  await svc.generateProjectPbs(project, { llm, progress });
  const view = svc.projectView(project);
  assert.ok(sawContext);
  assert.equal(view.scenarios.length, 1);
  const matched = view.items.find((i) => i.req_ids.includes("R001"));
  assert.ok(matched.scenario_ids.includes("SC001"));
  assert.equal(matched.confirmed, false);
  assert.ok(matched.stale);
  const buffer = await exportProject(view);
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
  assert.equal(book.worksheets.length, 7);
  assert.equal(book.getWorksheet("场景需求").getRow(2).getCell(1).value, "SC001");
  assert.equal(book.getWorksheet("需求处理去向").rowCount, 5);
});

test("repeated system regeneration never resurrects or selects an archived draft as the active result", async () => {
  await generate(); await generate(); await generate();
  const rows = scenes.listScenarios(project);
  assert.equal(rows.filter((s) => s.status !== "已归档").length, 1);
  assert.equal(rows.find((s) => s.status !== "已归档").code, "SC003");
  assert.equal(scenes.revisions(project, "SC001").length, 2, "archived system history is not repeatedly rewritten");
});

test("invalid model shapes receive a bounded repair and cannot overwrite a valid draft", async () => {
  await generate();
  let calls = 0;
  await assert.rejects(scenes.generateScenarios(project, { progress, llm: { async json() { calls++; return { scenarios: [null], dispositions: [null] }; } } }), /校验失败/);
  assert.equal(calls, 2);
  assert.equal(scenes.listScenarios(project).length, 1);
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
  await svc.generateProjectPbs(project, { progress, llm: model({ nodes: [], conflicts: [], links: [], new_nodes: [] }) });
  assert.equal(repo.getItem(project, id).name, protectedItem.name);
  assert.equal(repo.getItem(project, id).confirmed, true);
});

test("PBS generated against an outdated project is rejected without replacing previous rows", async () => {
  await generate();
  const id = item("R001", ["SC001"]);
  const previousName = repo.getItem(project, id).name;
  const llm = { async json({ step }) {
    if (step === "pbs") {
      svc.editRequirement(project, "R001", { text: "客户要求增加巡查范围" });
      return { nodes: [{ code: "1.1", parent: "1", name: "过时的方案", source: "服务", req_ids: ["R001"] }], conflicts: [] };
    }
    return { links: [], new_nodes: [] };
  } };
  await assert.rejects(svc.generateProjectPbs(project, { llm, progress }), /原 PBS 已保留/);
  assert.equal(repo.getItem(project, id).name, previousName);
});

test("a rematch suggestion cannot overwrite a later manual edit", async () => {
  const id = item("R001");
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
  await svc.generateProjectPbs(project, { progress, llm: model({ nodes: [], conflicts: [], links: [], new_nodes: [] }) });
  assert.equal(repo.getItem(project, id).name, "交付 R001");
  assert.equal(repo.getItem(project, id).confirmed, false);
});
