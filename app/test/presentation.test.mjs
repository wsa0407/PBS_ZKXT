import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRequirements, collectParams } from "../engine/extract.mjs";
import { runAudit } from "../engine/audit.mjs";
import { exportReview, findingTarget } from "../web/presentation.js";
import { resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { exportProject } from "../server/xlsx.mjs";

test("review links navigate to existing requirements, scenes, questions and evidence rather than defaulting to PBS", () => {
  const view = { items: [{ id: 1, code: "1.1" }], requirements: [{ code: "R001" }], scenarios: [{ code: "SC001" }], questions: [{ id: 7 }], sourceSnapshots: [{ uid: "M1:2.1" }] };
  for (const [ref, tab, focus] of [["1.1", "pbs", 1], ["R001", "requirements", "R001"], ["SC001", "scenarios", "SC001"], ["Q7", "questions", 7], ["M1:2.1", "materials", "M1:2.1"]]) {
    const target = findingTarget(view, { refs: ["missing", ref] });
    assert.equal(target.tab, tab);
    assert.equal(target.focus, focus);
  }
  assert.equal(findingTarget(view, { type: "★ 条款未抽取", refs: [] }).tab, "materials");
  assert.equal(findingTarget(view, { type: "检查提示", refs: ["missing"] }), null);
});

test("a rejected quantity parameter leaves the requirement intact and explains why the value was not used", async () => {
  const text = "★ 投标人应具有不少于2个无人机项目经验。";
  const doc = { fullText: text, segments: [{ id: "1.1", text, star: true }] };
  const result = await extractRequirements({ doc, params: { pilots: { label: "飞手人数", unit: "人" } }, inputType: "tender", llm: {
    json: async () => ({ requirements: [{ seg_id: "1.1", quote: text, text, category: "资质", params: [{ name: "pilots", value: 2, quote: "2个无人机项目" }] }] }),
  } });
  assert.equal(result.requirements.length, 1);
  assert.equal(result.requirements[0].quoteVerified, true);
  assert.equal(result.requirements[0].params.length, 0);
  assert.equal(result.requirements[0].rejectedParams.length, 1);
  assert.deepEqual(collectParams(result.requirements), {});
  const findings = runAudit({ doc, ...result, leaves: [], template: { level1: [] }, resolved: {}, sizing: { rules: [] }, issues: [], repairs: [], conflicts: [] });
  const parameter = findings.find((f) => f.refs.includes("R001") && f.message.includes("候选参数"));
  assert.match(parameter.message, /需求仍保留/);
  assert.match(parameter.message, /未采用/);
  assert.ok(findings.some((f) => f.message.includes("以本招标文件说明为准")));
  assert.ok(!findings.some((f) => f.message.includes("任一未响应即无效投标")));
});

test("description approval, clarification, computed quantity and completion remain independent in export review", () => {
  const view = { project: { done: true }, requirements: [],
    steps: { materials: { pending: 0 }, requirements: { pending: 0, confirmed: 1, total: 1 }, scenarios: { pending: 0, unmapped: [] }, questions: { open: 0, answered: 1 }, pbs: { items: 2, confirmed: 2, uncovered: 0, pendingQty: 1, stale: 0 } },
    items: [{ confirmed: true, qty: null }, { confirmed: true, qty: 8, sizing: { uncertain: true } }], audit: [],
  };
  let review = exportReview(view);
  assert.equal(review.draft, true, "a manual completion mark must not clear pending review");
  assert.equal(review.checks.find((c) => c.key === "requirements").count, 0);
  assert.equal(review.checks.find((c) => c.key === "questions").count, 1);
  assert.equal(review.checks.find((c) => c.key === "quantity").count, 2);
  view.steps.questions.answered = 0;
  view.steps.pbs.pendingQty = 0;
  view.items[0].qty = 3;
  view.items[1].manual_qty = true;
  assert.equal(exportReview(view).draft, false);
  view.catalog = { snapshot_stale: true };
  review = exportReview(view);
  assert.equal(review.draft, true);
  assert.match(review.checks.find((c) => c.key === "snapshot").text, /Excel 将使用已保存版本/);
});

test("Excel remains available for a draft and carries the same unresolved review state as the workspace", async () => {
  resetDb(":memory:");
  const id = repo.createProject({ name: "导出语义核对" }).id;
  const code = svc.addRequirement(id, { text: "需要飞手培训，人数待确认", category: "服务", priority: "必须", source_note: "合成测试客户原话" });
  svc.saveItem(id, null, { parent: "6", name: "飞手培训", source: "服务", unit: "人", req_ids: [code], qty: null });
  repo.insertQuestion(id, { question: "培训多少人？", req_ids: [code], source: "人工", impact: "影响报价" });
  const qid = repo.listQuestions(id)[0].id;
  repo.updateQuestion(id, qid, { answer: "还需要内部确认", status: "已答复", proposal: { summary: "人数尚未确定", changes: [], dropped: [] } });
  repo.updateProject(id, { done: true });
  const view = svc.projectView(id);
  assert.equal(exportReview(view).draft, true);
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await exportProject(view));
  const values = (name) => JSON.stringify(book.getWorksheet(name).getSheetValues());
  assert.match(values("导出前检查"), /当前草稿/);
  assert.match(values("导出前检查"), /客户答复待采纳/);
  assert.match(values("澄清问题"), /答复待采纳/);
  assert.match(values("需求对应表"), /描述已确认/);
  assert.match(values("PBS 清单"), /待确认/);
  assert.ok(!values("PBS 清单").includes("待估"));
});
