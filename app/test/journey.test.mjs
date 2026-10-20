import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { installDefaultCatalog } from "../server/catalog.mjs";
import { createServer } from "../server/index.mjs";
import { getJob } from "../server/jobs.mjs";
import { latestReview } from "../server/conversation-review.mjs";
import { setAgentRuntimeFactory } from "../server/agent-runner.mjs";
import { exportProject } from "../server/xlsx.mjs";

const ok = async (execute, name, args = {}) => {
  const result = await execute(name, args);
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.data?.errors ?? [], []);
  return result.data;
};
afterEach(() => setAgentRuntimeFactory(null));

test("HTTP conversation carries materials through understanding, explicit human scope and PBS to traceable export", async () => {
  resetDb(); installDefaultCatalog(); svc.rebuildIndex();
  const id = repo.createProject({ name: "巡查交付测试" }).id;
  const turns = [];
  setAgentRuntimeFactory(async o => {
    const s = await ok(o.execute, "collaboration_state");
    turns.push([o.role, s.activation_mode]);
    if (s.activation_mode === "claim") {
      const args = { operation_id: "claim", message_id: s.message.id };
      if (s.message.content === "同意本轮范围") {
        await ok(o.execute, "respond_to_message", { ...args, ...(o.role === "understanding" ? { decision: "review", review_id: s.review_request.id, review_decision: "approve", quote: s.message.content } : { decision: "pass" }) });
      } else {
        await ok(o.execute, "respond_to_message", { ...args, ...(o.role === "pbs" ? { decision: "pass" } : { decision: "claim", work_mode: "main", scope: o.role === "materials" ? "拆解原文" : "整理巡查场景" }) });
      }
      return {};
    }
    const input = s.activation_mode === "intervention" ? (await ok(o.execute, "read_interventions")).messages[0] : null;
    const state = await ok(o.execute, "project_state");
    if (o.role === "materials") {
      const batch = await ok(o.execute, "read_document_batch", { document_id: state.documents[0].document_id });
      const source = batch.items[0];
      await ok(o.execute, "submit_requirements", { operation_id: "requirement", document_id: source.document_id, document_version: source.document_version, requirements: [{ evidence_id: source.evidence_id, quote: source.text, text: "支持无人机夜间巡查，异常通知值班人员", category: "功能", priority: "重要" }] });
    } else if (o.role === "understanding") {
      const requirements = repo.listRequirements(id);
      await ok(o.execute, "submit_scenarios", { operation_id: "scene", expected_version: state.workspace_version, scenarios: [{ name: "夜间异常巡查", links: [{ req_id: requirements[0].code, role: "核心要求" }], activities: [{ text: "夜间巡查并通知值班人员", req_ids: [requirements[0].code] }], evidence: [{ field_path: "activities.0.text", seg_uid: requirements[0].seg_uid, quote: requirements[0].quote }] }] });
    } else {
      assert.equal(s.pbs_participation.can_execute, true);
      const req = s.confirmation.snapshot.requirements[0], scene = s.confirmation.snapshot.scenarios[0];
      const product = repo.getProduct("LA-P07");
      await ok(o.execute, "submit_pbs", { operation_id: "pbs", expected_version: state.pbs_version, items: [{ name: product.name, parent: "2", source: product.metadata.delivery_source, product_ref: product.id, matched_capabilities: [product.capabilities[0]], req_ids: [req.code], scenario_ids: [scene.code], qty: null, unit: product.unit }] });
    }
    if (input) await ok(o.execute, "acknowledge_intervention", { operation_id: "ack", intervention_id: input.id, outcome: "adjusted", operation_ids: [o.role === "materials" ? "requirement" : "scene"], explanation: "已保存本次成果。" });
    return { finalResponse: "本次成果已保存。" };
  });
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/projects/${id}`;
  const send = async body => {
    const response = await fetch(`${base}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const result = await response.json();
    for (let i = 0; i < 100 && getJob(result.jobId).status === "处理中"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getJob(result.jobId).status, "已完成", getJob(result.jobId).error);
  };
  try {
    await send({ requestId: "material", text: "请理解材料并整理场景", file: { name: "巡查要求.txt", base64: Buffer.from("2.1.1 系统应支持无人机夜间巡查，发现异常后通知值班人员。").toString("base64") } });
    assert.equal(repo.listRequirements(id).length, 1);
    assert.equal(repo.listMaterials(id)[0].extracted_at !== null, true);
    assert.equal(repo.listItems(id).length, 0);
    assert.ok(!turns.some(([role, mode]) => role === "pbs" && mode !== "claim"));
    await send({ requestId: "confirm", text: "同意本轮范围", reviewId: latestReview(id).id });
    const view = svc.projectView(id);
    assert.equal(view.scenarios.length, 1);
    assert.ok(view.items.some(i => i.product_ref === "LA-P07" && i.req_ids.includes(view.requirements[0].code)));
    assert.equal(view.project.done, false);
    assert.ok(view.items.every(i => !i.confirmed));
    const ExcelJS = (await import("exceljs")).default;
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await exportProject(view));
    for (const name of ["导出前检查", "需求对应表", "场景需求", "PBS 清单", "产品BOM组成"]) assert.ok(book.getWorksheet(name), name);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
