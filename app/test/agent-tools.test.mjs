import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getDb, resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as chat from "../server/chat.mjs";
import { localAgentAdapter } from "../server/agent-adapter.mjs";
import { hash } from "../engine/scenario.mjs";
import * as rag from "../server/rag.mjs";

let id, mid, adapter, source;
beforeEach(() => {
  resetDb();
  id = repo.createProject({ name: "Agent测试" }).id;
  mid = svc.addMaterial(id, { kind: "tender", title: "需求", text: "第五章 采购需求\n1.1 系统应支持夜间巡逻，发现事故后通知值班人员。\n1.2 验收后提供36个月维护服务。" });
  source = repo.listSegments(id).find((s) => s.text.includes("支持夜间巡逻"));
  adapter = localAgentAdapter(id);
});
const submit = (requirements, operation_id = "op-1") => adapter.execute("submit_requirements", { operation_id, document_id: `material:${mid}`, document_version: hash(repo.getMaterial(id, mid).text), requirements });
const req = (extra = {}) => ({ evidence_id: source.uid, text: "支持夜间巡逻", quote: "支持夜间巡逻", category: "功能", priority: "重要", ...extra });

test("Agent rejects an invalid quote, then accepts a corrected submission without fabricated evidence", async () => {
  const bad = await submit([req({ quote: "支持999公里巡逻" })]);
  assert.equal(bad.data.errors.length, 1);
  assert.equal(repo.listRequirements(id).length, 0);
  const good = await submit([req()], "op-fixed");
  assert.equal(good.data.accepted.length, 1);
  assert.equal(repo.listRequirements(id)[0].quote_verified, true);
  assert.equal(repo.listRequirements(id)[0].status, "待确认");
});

test("tender inference is rejected instead of silently relabelled as a source fact, without losing valid batch items", async () => {
  const out = await submit([req(), req({ text: "夜间巡逻必须全自动无人值守", inferred: true })]);
  assert.equal(out.data.accepted.length, 1);
  assert.equal(out.data.errors.length, 1);
  assert.match(JSON.stringify(out.data.errors), /TENDER_INFERENCE/);
  assert.equal(repo.listRequirements(id).length, 1);
  assert.equal(repo.listRequirements(id)[0].status, "待确认");
});

test("a supported interview inference keeps its nature independently of quote verification and human approval", async () => {
  const materialId = svc.addMaterial(id, { kind: "minutes", title: "访谈记录", text: "夜间值班人员难以覆盖全部巡查区域，希望改善夜间巡查效率。" });
  const segment = repo.listSegments(id).find(s => s.material_id === materialId);
  const out = await adapter.execute("submit_requirements", { operation_id: "interview-inference", document_id: `material:${materialId}`, document_version: hash(repo.getMaterial(id, materialId).text), requirements: [{ evidence_id: segment.uid, text: "可能需要辅助夜间巡查能力", quote: segment.text, inferred: true, category: "功能", priority: "一般" }] });
  assert.equal(out.data.accepted.length, 1);
  const saved = repo.listRequirements(id)[0];
  assert.equal(saved.inferred, true);
  assert.equal(saved.quote_verified, true);
  assert.equal(saved.status, "待确认");
});

test("the run report distinguishes saved scenarios from requirement classification counts", async () => {
  await submit([req()]);
  const report = adapter.report();
  assert.equal(report.scenarios.total, 0);
  assert.equal(report.scenarios.requirement_coverage.total, 1);
  assert.deepEqual(report.scenarios.requirement_coverage.unmapped, ["R001"]);
});

test("partial batches retain good items; exact retry is idempotent and changed content needs a new operation ID", async () => {
  const original = [req(), req({ text: "错误需求", quote: "不存在的文字" })];
  const first = await submit(original);
  assert.equal(first.data.accepted.length, 1);
  assert.deepEqual(await submit(original), first);
  assert.equal(repo.listRequirements(id).length, 1);
  const conflict = await submit([req({ text: "另外的文字" })]);
  assert.equal(conflict.error.code, "OPERATION_CONFLICT");
});

test("tools cannot select another project or read its document and evidence", async () => {
  const other = repo.createProject({ name: "其他项目" }).id;
  const otherMid = svc.addMaterial(other, { kind: "oral", text: "这是另一个客户的材料，不能从当前项目读取。" });
  const foreign = repo.listSegments(other)[0];
  assert.equal((await adapter.execute("project_state", { project_id: other })).ok, false);
  assert.equal((await adapter.execute("read_evidence", { evidence_id: `M99:${foreign.seg_id}` })).ok, false);
  assert.equal((await adapter.execute("list_document_sections", { document_id: `material:${otherMid}` })).ok, false);
});

test("source version changes reject writes before any requirement is saved", async () => {
  const version = hash(repo.getMaterial(id, mid).text);
  getDb().prepare("UPDATE materials SET text=text||'补充内容' WHERE id=?").run(mid);
  const out = await adapter.execute("submit_requirements", { operation_id: "stale", document_id: `material:${mid}`, document_version: version, requirements: [req()] });
  assert.equal(out.error.code, "VERSION_CONFLICT");
  assert.equal(repo.listRequirements(id).length, 0);
});

test("cancellation prevents later business writes", async () => {
  const controller = new AbortController();
  adapter = localAgentAdapter(id, { signal: controller.signal });
  controller.abort();
  assert.equal((await submit([req()])).error.code, "RUN_CANCELLED");
  assert.equal(repo.listRequirements(id).length, 0);
});

test("model-supplied parameters with fabricated units are rejected independently of the requirement", async () => {
  const out = await submit([req({ params: [{ name: "road_km", value: 12, quote: "12公里" }] })]);
  assert.equal(out.data.accepted[0].rejected_params.length, 1);
  assert.equal(out.data.accepted[0].rejected_params[0].label, svc.projectView(id).params.find((p) => p.name === "road_km").label);
  assert.equal(out.data.accepted[0].rejected_params[0].reason, "参数引用不在原文中");
  assert.deepEqual(repo.listRequirements(id)[0].params, []);
});

test("a manual requirement is not overwritten when an Agent resubmits its content", async () => {
  await submit([req()]);
  const previous = repo.listRequirements(id)[0];
  repo.updateRequirement(id, previous.code, { status: "已确认", edited: true, source_note: "人工核对" });
  const before = repo.getRequirement(id, previous.code);
  await submit([req({ priority: "必须" })], "again");
  assert.deepEqual(repo.getRequirement(id, previous.code), before);
});

test("long source batching is lossless across bounded pages and keeps evidence identity", async () => {
  getDb().prepare("UPDATE segments SET text=? WHERE project_id=? AND uid=?").run("长条款内容。".repeat(2200), id, source.uid);
  const original = repo.listSegments(id).map((s) => s.text).join("");
  let cursor, document_version; const parts = [];
  do {
    const out = await adapter.execute("read_document_batch", { document_id: `material:${mid}`, ...(cursor ? { cursor, document_version } : {}) });
    assert.ok(out.data.items.reduce((n, s) => n + s.text.length, 0) <= 6000);
    parts.push(...out.data.items.map((s) => s.text)); cursor = out.data.next_cursor; document_version = out.data.document.document_version;
  } while (cursor);
  assert.equal(parts.join(""), original);
});

test("one full reading batch fits ignored submissions and overflow can be split without lost coverage", async () => {
  const materialId = svc.addMaterial(id, { kind: "tender", title: "合成附件目录", text: Array.from({ length: 61 }, (_, i) => `${i + 1}.1 附件目录条目${i + 1}，此处仅为索引。`).join("\n") });
  const document_id = `material:${materialId}`;
  const first = (await adapter.execute("read_document_batch", { document_id })).data;
  assert.equal(first.items.length, 60);
  const document_version = first.document.document_version;
  const last = (await adapter.execute("read_document_batch", { document_id, document_version, cursor: first.next_cursor })).data;
  assert.equal(last.items.length, 1);
  assert.equal(last.next_cursor, null);
  const ignored = [...first.items, ...last.items].map(s => ({ evidence_id: s.evidence_id, reason: "目录索引，无实际要求" }));
  const write = (items, operation_id) => adapter.execute("submit_requirements", { document_id, document_version, operation_id, requirements: [], ignored: items });
  const tooLarge = await write(ignored, "oversized");
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.error.message, /ignored.*60.*拆分/);
  assert.equal(adapter.report().documents.find(d => d.document_id === document_id).processed, 0);
  const saved = await write(ignored.slice(0, 60), "first-batch");
  assert.equal(saved.data.ignored.accepted.length, 60);
  assert.deepEqual(saved.data.ignored.errors, []);
  assert.equal(saved.data.coverage.remaining, 1);
  assert.deepEqual(await write(ignored.slice(0, 60), "first-batch"), JSON.parse(JSON.stringify(saved)));
  const tail = await write(ignored.slice(60), "last-batch");
  assert.equal(tail.data.coverage.processed, 61);
  assert.equal(tail.data.coverage.remaining, 0);
  assert.equal(tail.data.coverage.ignored_count, 61);
  assert.deepEqual(repo.listSegments(id).filter(s => s.material_id === materialId).map(s => s.uid), ignored.map(s => s.evidence_id));
});

test("an Agent change remains a proposal until the human applies it, and stale proposals cannot apply", async () => {
  await submit([req()]);
  const out = await adapter.execute("propose_change", { operation_id: "change-1", action: { type: "edit_requirement", code: "R001", text: "支持夜间事故巡查" } });
  assert.equal(out.ok, true);
  assert.equal(repo.getRequirement(id, "R001").text, "支持夜间巡逻");
  const message = repo.addChat(id, "assistant", "请核对", { cards: [out.data.card] });
  repo.updateRequirement(id, "R001", { text: "人工后改的版本", revision: 2 });
  assert.throws(() => chat.resolveCard(id, message, 0, "accept"), /已变化/);
  assert.equal(repo.getRequirement(id, "R001").text, "人工后改的版本");
});

test("finishing cannot hide missing document coverage or mark the project complete", async () => {
  const out = await adapter.execute("finish_task", { summary: "完成", remaining: [] });
  assert.equal(out.data.state, "needs_review");
  assert.equal(repo.getProject(id).done, false);
});

test("PBS rejects an obsolete product-library version without altering existing items", async () => {
  const state = (await adapter.execute("project_state", {})).data;
  const p = repo.listProducts()[0];
  repo.saveProduct(p.id, { ...p, summary: p.summary + "产品能力更新" });
  const result = await adapter.execute("submit_pbs", { operation_id: "pbs-stale", expected_version: state.pbs_version, items: [] });
  assert.equal(result.error.code, "VERSION_CONFLICT");
  assert.equal(repo.listItems(id).length, 0);
});

test("scenario writes reject concurrent requirement changes instead of binding the new revision silently", async () => {
  await submit([req()]);
  const version = (await adapter.execute("project_state", {})).data.workspace_version;
  repo.updateRequirement(id, "R001", { text: "已人工改变的范围", revision: 2 });
  const result = await adapter.execute("submit_scenarios", { operation_id: "scene-stale", expected_version: version, scenarios: [] });
  assert.equal(result.error.code, "VERSION_CONFLICT");
});

test("product retrieval evidence can be read back with its exact immutable version", async () => {
  svc.rebuildIndex();
  rag.setRetrievalMode({ kind: "keyword", model: null, reason: "test" });
  const product = repo.listProducts()[0];
  const out = await adapter.execute("search_evidence", { query: product.name, domain: "products", limit: 2 });
  assert.ok(out.data.hits.length);
  const hit = out.data.hits[0];
  const read = await adapter.execute("read_evidence", { evidence_id: hit.evidence_id, document_version: hit.document_version });
  assert.equal(read.data.source.text, hit.text);
  assert.equal(read.data.source.document_version, hit.document_version);
});

test("PBS product associations survive validation, while using the delivered product as its own blocker is rejected", async () => {
  await submit([req()]);
  const product = repo.listProducts()[0];
  const item = { name: product.name, parent: "1", source: "自有产品", product_ref: product.id, req_ids: ["R001"], matched_capabilities: [product.capabilities[0]], qty: null, unit: product.unit };
  const state = (await adapter.execute("project_state", {})).data;
  const good = await adapter.execute("submit_pbs", { operation_id: "matched", expected_version: state.pbs_version, items: [item] });
  assert.equal(good.ok, true);
  assert.ok(repo.listItems(id).some((i) => i.product_ref === product.id));
  const current = (await adapter.execute("project_state", {})).data;
  const bad = await adapter.execute("submit_pbs", { operation_id: "self-blocker", expected_version: current.pbs_version, items: [{ ...item, blocked_by: { product_ref: product.id, limit: product.limits[0] || "限制" } }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.message.includes("blocked_by"));
  assert.ok(repo.listItems(id).some((i) => i.product_ref === product.id));
});

test("incremental PBS submissions preserve earlier batches and update drafts without changing their IDs", async () => {
  await submit([req()]);
  const item = { name: "夜间巡逻实施", parent: "5", source: "服务", req_ids: ["R001"], qty: null, unit: "项" };
  const save = async (items, operation_id) => adapter.execute("submit_pbs", { operation_id, expected_version: (await adapter.execute("project_state", {})).data.pbs_version, items });
  assert.equal((await save([item], "first-batch")).ok, true);
  const firstId = repo.listItems(id)[0].id;
  assert.equal((await save([{ ...item, name: "夜间巡逻培训" }], "second-batch")).ok, true);
  assert.equal(repo.listItems(id).length, 2);
  assert.equal((await save([{ ...item, spec: "补充部署约束" }], "refine-first")).ok, true);
  assert.equal(repo.listItems(id).length, 2);
  const updated = repo.listItems(id).find((i) => i.name === item.name);
  assert.equal(updated.id, firstId);
  assert.equal(updated.spec, "补充部署约束");
});
