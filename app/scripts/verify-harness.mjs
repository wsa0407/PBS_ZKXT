// Opt-in real-model verification through the production collaboration boundary.
import "../lib/bai_client.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { installDefaultCatalog } from "../server/catalog.mjs";
import { createCollaboration, receiveMessage, runCollaboration } from "../server/collaboration.mjs";
import { approvalPreview, approveUnderstanding } from "../server/collaboration-approval.mjs";
import { task, events } from "../server/collaboration-store.mjs";

if (!process.argv.includes("--live")) throw new Error("此脚本会调用真实模型。请显式传入 --live；仅对合成材料授权 PBS 阶段时，再传入 --approve-test-scope。");
const directory = await mkdtemp(join(tmpdir(), "pbs-harness-business-"));
resetDb(join(directory, "business.db"));
installDefaultCatalog(); svc.rebuildIndex();
const project = repo.createProject({ name: "Harness合成验收", customer: "合成测试" });
const fixture = JSON.parse(await readFile(new URL("../../agents/pbs/evals/garden.json", import.meta.url), "utf8"));
svc.addMaterial(project.id, { title: "园区巡查合成材料", text: fixture.material });
const t = createCollaboration(project.id, { mode: "conversation", goal: "理解合成材料" });
receiveMessage(t, { id: "synthetic-material", content: "请完整拆解材料、组织需求与业务场景，保存有原文依据的草稿，供我确认。" });
await runCollaboration(t.id);
assert.ok(repo.listRequirements(project.id).length > 0);
assert.equal(repo.listItems(project.id).length, 0, "PBS cannot execute before explicit human scope approval");
const preview = approvalPreview(project.id);
await writeFile(join(directory, "understanding.json"), JSON.stringify(preview, null, 2));
if (process.argv.includes("--approve-test-scope")) {
  // This flag is the operator's explicit authorization for this synthetic scope only.
  const approved = approveUnderstanding(project.id, { version: preview.version, requirements: preview.requirements.map(r => r.code), scenarios: preview.scenarios.map(s => s.code) });
  const pbs = createCollaboration(project.id, { role: "pbs", approvalId: approved.id, goal: "按合成验收已批准范围编制 PBS，保留证据与未知数量" });
  await runCollaboration(pbs.id);
  assert.ok(repo.listItems(project.id).length > 0);
}
await writeFile(join(directory, "events.json"), JSON.stringify(events(project.id), null, 2));
console.log(JSON.stringify({ project_id: project.id, directory, understanding_status: task(t.id).status, requirements: preview.requirements.length, scenarios: preview.scenarios.length, pbs: repo.listItems(project.id).length }));
