// Opt-in, bounded real-model check of recovery from saved material coverage.
import "../lib/bai_client.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { persistedEvents } from "../../runtime/verification.mjs";
import { getDb, resetDb, json } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { localAgentAdapter } from "../server/agent-adapter.mjs";
import { createCollaboration, runCollaboration } from "../server/collaboration.mjs";
import * as store from "../server/collaboration-store.mjs";

if (!process.argv.includes("--live")) throw new Error("此脚本会调用真实模型，请显式传入 --live；仅使用独立合成数据，不授权 PBS。");
process.env.APP_AGENT_MAX_TOKENS = "300000";
process.env.APP_COLLABORATION_MAX_TOKENS = "500000";
const directory = await mkdtemp(join(tmpdir(), "pbs-material-resume-"));
resetDb(join(directory, "resume.db"));
const project = repo.createProject({ name: "材料恢复合成验收" });
const text = Array.from({ length: 50 }, (_, i) => `${i + 1}.1 ${i === 11 ? "系统应支持夜间巡逻，发现异常后通知值班人员。" : i === 41 ? "验收后提供36个月维护服务。" : i === 31 ? "系统应保存巡逻日志。" : `附件目录索引第${i + 1}项，无实际要求。`}`).join("\n");
const materialId = svc.addMaterial(project.id, { kind: "tender", title: "合成采购要求", text });
const adapter = localAgentAdapter(project.id);
const batch = (await adapter.execute("read_document_batch", { document_id: `material:${materialId}` })).data;
assert.equal(batch.items.length, 50);
const saved = await adapter.execute("submit_requirements", {
  operation_id: "fixture-saved", document_id: batch.document.document_id, document_version: batch.document.document_version,
  requirements: [{ evidence_id: batch.items[31].evidence_id, text: "保存巡逻日志", quote: "系统应保存巡逻日志", category: "功能", priority: "重要" }],
  ignored: batch.items.filter((_, i) => ![11, 31, 41].includes(i)).map(s => ({ evidence_id: s.evidence_id, reason: "附件目录索引" })),
});
assert.equal(saved.data.coverage.remaining, 2);
const code = saved.data.accepted[0].code;
repo.updateRequirement(project.id, code, { edited: true, status: "已确认" });
const human = repo.getRequirement(project.id, code);
const t = createCollaboration(project.id, { role: "materials", goal: "继续完成材料拆解，保存剩余需求及处理记录。" });
const a = store.nextActivation(t.id);
// Fixture only: the production recovery path persists this same activation flag.
getDb().prepare("UPDATE collaboration_activations SET input=? WHERE id=?").run(json({ ...a.input, recovery: { fresh_session: true } }), a.id);
await runCollaboration(t.id);
const report = adapter.report();
assert.equal(report.documents[0].remaining, 0);
assert.equal(repo.listRequirements(project.id).length, 3);
assert.deepEqual(repo.getRequirement(project.id, code), human);
assert.equal(repo.listItems(project.id).length, 0);
const records = getDb().prepare("SELECT session_id,stats FROM agent_runs WHERE project_id=?").all(project.id);
const reads = [];
for (const record of records) {
  const events = await persistedEvents(fileURLToPath(new URL(`../../runtime/.state/${project.id}/materials/`, import.meta.url)), record.session_id);
  reads.push(...events.filter(e => e.type === "tool/call" && e.data.name === "mcp__pbs__read_document_batch").map(e => JSON.parse(e.data.arguments)));
}
assert.ok(reads.length > 0);
assert.ok(reads.every(r => r.unprocessed_only === true), "Recovery must not scan already processed material again");
const runs = records.map(r => JSON.parse(r.stats));
console.log(JSON.stringify({ project_id: project.id, directory, status: store.task(t.id).status, requirements: report.requirements.total, remaining: report.documents[0].remaining, tokens: runs.reduce((sum, r) => sum + r.tokens, 0), tools: runs.flatMap(r => r.tools.map(t => t.name)) }));
