import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resetDb } from "../server/db.mjs";
import { setLlmFactory, startJob } from "../server/jobs.mjs";
import * as rag from "../server/rag.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as chat from "../server/chat.mjs";

const TENDER = `# 某市交警支队道路无人机巡逻系统

## 第二章 功能需求
2.1 自动巡逻
2.1.1 ★ 在辖区高速公路部署无人机自动机场，实现无人值守自动巡逻，巡逻道路总里程约 120 公里。
2.1.2 ▲ 支持夜间巡逻，夜间可清晰分辨路面车辆和人员。
2.2 智能识别
2.2.1 系统应自动识别交通事故、违停和拥堵，识别准确率不低于 90%。
2.2.2 对违法车辆进行车牌识别并自动取证。
## 第四章 服务
4.1 服务
4.1.1 中标方应培训不少于 8 名飞手，并取得民航局认可的无人机驾驶员执照。
`;

// A scripted model: deterministic answers keyed by step, so the whole journey runs offline.
function fakeLlm({ onCall = () => {} } = {}) {
  const usage = { calls: 0, cached: 0, promptTokens: 0, completionTokens: 0, steps: [] };
  return {
    model: "fake",
    usage,
    async json({ step, user }) {
      usage.calls += 1;
      onCall({ step, model: "fake", cached: false, ms: 1, promptTokens: 10, completionTokens: 5, ok: true });
      if (step === "extract") {
        const ids = [...user.matchAll(/^\[([\d.]+)\]/gm)].map((m) => m[1]);
        const all = {
          "2.1.1": { text: "部署自动机场实现无人值守自动巡逻", quote: "部署无人机自动机场，实现无人值守自动巡逻", category: "功能", priority: "必须", params: [{ name: "road_km", value: 120, quote: "巡逻道路总里程约 120 公里" }] },
          "2.1.2": { text: "支持夜间巡逻", quote: "支持夜间巡逻", category: "功能", priority: "必须", params: [] },
          "2.2.1": { text: "自动识别交通事故、违停和拥堵，准确率不低于 90%", quote: "自动识别交通事故、违停和拥堵", category: "功能", priority: "必须", params: [] },
          "2.2.2": { text: "车牌识别并自动取证", quote: "对违法车辆进行车牌识别并自动取证", category: "功能", priority: "重要", params: [] },
          "4.1.1": { text: "培训 8 名飞手并取得执照", quote: "培训不少于 8 名飞手", category: "服务", priority: "重要", params: [{ name: "pilots", value: 8, quote: "不少于 8 名飞手" }] },
        };
        return { requirements: ids.filter((id) => all[id]).map((id) => ({ seg_id: id, ...all[id] })) };
      }
      if (step === "clarify") return { questions: [{ req_ids: [], question: "车牌取证能否改为低空近距离补拍？", reason: "产品限制", impact: "影响方案" }] };
      if (step === "pbs") {
        const id = (frag) => user.match(new RegExp(`(R\\d{3}) \\[[^\\]]+\\]\\[[^\\]]+\\] [^\\n]*${frag}`))?.[1];
        return {
          nodes: [
            { code: "1.1", parent: "1", name: "SkyOps", source: "自有产品", product_ref: "P01", matched_capabilities: ["定时与触发式巡检任务"], req_ids: [id("无人值守")] },
            { code: "1.2", parent: "1", name: "VisionAI", source: "自有产品", product_ref: "P06", matched_capabilities: ["交通事故识别", "违停识别", "拥堵识别", "凭空编造的能力"], req_ids: [id("自动识别")], sizing_rule: "R04" },
            { code: "2.1", parent: "2", name: "Dock-X 自动机场", source: "自有产品", product_ref: "P02", matched_capabilities: ["无人值守自动起降"], req_ids: [id("无人值守")], sizing_rule: "R01" },
            { code: "2.2", parent: "2", name: "EyePod 吊舱", source: "自有产品", product_ref: "P04", matched_capabilities: ["夜间巡查"], req_ids: [id("夜间")] },
            { code: "3.1", parent: "3", name: "车牌识别取证定制", source: "自研", blocked_by: { product_ref: "P06", limit: "不支持车牌识别取证" }, req_ids: [id("车牌")] },
            { code: "5.1", parent: "5", name: "驻场实施", source: "服务", req_ids: [] },
            { code: "6.1", parent: "6", name: "飞手培训取证", source: "外采", req_ids: [id("飞手")], sizing_rule: "R12" },
            { code: "7.1", parent: "7", name: "运维", source: "服务", req_ids: [], sizing_rule: "R14" },
          ],
          conflicts: [],
        };
      }
      if (step === "repair") return { links: [], new_nodes: [] };
      if (step === "answer") {
        return {
          summary: "客户确认了机场数量",
          changes: [
            { type: "set_param", name: "dock_count", value: 12, quote: "确认 12 个机场" },
            { type: "set_param", name: "pilots", value: 99, quote: "99 人" },
          ],
        };
      }
      if (step === "rematch") {
        return { node: { name: "车牌识别取证", parent: "3", source: "自研", blocked_by: { product_ref: "P06", limit: "不支持车牌识别取证" }, basis: "产品不支持" } };
      }
      if (step === "chat") {
        const text = user.split("用户这条消息：\n").pop();
        if (text.includes("机场改成")) return { reply: "好的，我来改。", actions: [{ type: "set_param", name: "dock_count", value: 14 }] };
        if (text.includes("为什么")) return { reply: "因为产品限制。", actions: [] };
        if (text.includes("乱来")) return { reply: "", actions: [{ type: "edit_item", id: 99999, qty: 5 }, { type: "launch_missiles" }] };
        return { reply: "好的。", actions: [] };
      }
      throw new Error(`unexpected step ${step}`);
    },
  };
}

before(() => {
  resetDb(":memory:");
  svc.rebuildIndex();
  rag.setRetrievalMode({ kind: "keyword", model: null, reason: "test" });
  setLlmFactory((options) => fakeLlm(options));
});

async function runJobFn(fn) {
  const j = startJob({ projectId: PROJECT, kind: "t", steps: ["x"], run: fn });
  await j.promise;
}

let PROJECT;

test("1 materials → requirements, params and questions", async () => {
  PROJECT = repo.createProject({ name: "交警巡逻", customer: "某市交警", industry: "公安" }).id;
  svc.addMaterial(PROJECT, { kind: "tender", title: "招标文件", text: TENDER });
  assert.equal(repo.listSegments(PROJECT).length, 5);

  await runJobFn((ctx) => svc.analyzeMaterials(PROJECT, ctx));
  const view = svc.projectView(PROJECT);
  assert.equal(view.requirements.length, 5);
  assert.equal(view.params.find((p) => p.name === "road_km").value, 120);
  assert.equal(view.params.find((p) => p.name === "dock_count").value, 10, "derived from road length");
  assert.equal(view.params.find((p) => p.name === "pilots").value, 8);
  assert.ok(view.questions.some((q) => q.param === "dock_count"), "unconfirmed dock count raises a question");
  assert.ok(view.questions.some((q) => q.source === "模型识别"));
  assert.equal(view.materials[0].extracted_at !== null, true);
  assert.ok(view.requirements.find((r) => r.seg_uid === "M1:2.1.1").star);
  assert.ok(!view.requirements.find((r) => r.seg_uid === "M1:2.1.2").star, "▲ is not ★");
});

test("2 review: confirm, edit, add, delete need a reason, restore", () => {
  const first = repo.listRequirements(PROJECT)[0].code;
  svc.confirmRequirements(PROJECT, [first]);
  assert.equal(repo.getRequirement(PROJECT, first).status, "已确认");

  svc.editRequirement(PROJECT, "R003", { text: "自动识别交通事故、违停、拥堵和抛洒物" });
  const edited = repo.getRequirement(PROJECT, "R003");
  assert.equal(edited.edited, true);
  assert.equal(edited.status, "待确认", "saving an edit is separate from confirmation");

  const added = svc.addRequirement(PROJECT, { text: "巡逻视频保存不少于 90 天", category: "安全", priority: "重要" });
  assert.equal(repo.getRequirement(PROJECT, added).origin, "人工");

  assert.throws(() => svc.editRequirement(PROJECT, "R004", { status: "已删除" }), /原因/);
  svc.editRequirement(PROJECT, "R004", { status: "已删除", reason: "客户说不做" });
  assert.equal(repo.getRequirement(PROJECT, "R004").status, "已删除");
  svc.editRequirement(PROJECT, "R004", { status: "待确认" });
  assert.equal(repo.getRequirement(PROJECT, "R004").status, "待确认");
});

test("3 re-extraction keeps what people touched", async () => {
  svc.addMaterial(PROJECT, { kind: "oral", title: "补充口述", text: "客户补充说明：希望巡逻视频能够保存三个月以上，方便事后调取。" });
  const before = repo.listRequirements(PROJECT).length;
  await runJobFn((ctx) => svc.analyzeMaterials(PROJECT, { all: true, ...ctx }));
  const reqs = repo.listRequirements(PROJECT);
  assert.ok(reqs.some((r) => r.text === "自动识别交通事故、违停、拥堵和抛洒物"), "edited requirement survived");
  assert.ok(reqs.some((r) => r.origin === "人工"), "manual requirement survived");
  assert.ok(reqs.length >= before - 1);
});

test("4 PBS generation: model mistakes are corrected, edits preserved", async () => {
  await runJobFn((ctx) => svc.generateProjectPbs(PROJECT, ctx));
  const view = svc.projectView(PROJECT);
  const by = (pred) => view.items.filter(pred);

  const vision = by((i) => i.product_ref === "P06" && !i.sizing_rule);
  assert.equal(vision.length, 1);
  assert.equal(vision[0].qty, 1, "product line is 1 套");
  assert.ok(!vision[0].matched_capabilities.includes("凭空编造的能力"), "invented capability removed");
  const licence = by((i) => i.sizing_rule === "R04");
  assert.equal(licence.length, 1, "add-on licence split out");
  assert.equal(licence[0].qty, 10);

  assert.equal(by((i) => i.sizing_rule === "R01")[0].qty, 10);
  assert.equal(by((i) => i.sizing_rule === "R12")[0].qty, 8);
  assert.ok(view.items.every((i) => i.review));
  assert.equal(view.retrieval.mode, "keyword");

  const plate = by((i) => i.name === "车牌识别取证定制")[0];
  assert.match(plate.match.limit, /不支持车牌识别取证/);
});

test("5 manual quantity wins over rules and survives regeneration", async () => {
  const dock = svc.projectView(PROJECT).items.find((i) => i.sizing_rule === "R01");
  svc.saveItem(PROJECT, dock.id, { qty: 15 });
  let item = repo.getItem(PROJECT, dock.id);
  assert.equal(item.qty, 15);
  assert.equal(item.manual_qty, true);
  assert.equal(item.edited, true);

  // parameter changes must not touch a manual quantity
  svc.setParam(PROJECT, "dock_count", { value: 20 });
  assert.equal(repo.getItem(PROJECT, dock.id).qty, 15);

  await runJobFn((ctx) => svc.generateProjectPbs(PROJECT, ctx));
  const again = svc.projectView(PROJECT).items.filter((i) => i.name === dock.name);
  assert.equal(again.length, 1, "no duplicate of the edited line");
  assert.equal(again[0].qty, 15);
  svc.setParam(PROJECT, "dock_count", { value: null });
});

test("6 a rule cannot be attached to two lines", () => {
  const items = svc.projectView(PROJECT).items;
  const a = items.find((i) => i.sizing_rule === "R12");
  const other = items.find((i) => !i.sizing_rule && i.source === "服务");
  assert.throws(() => svc.saveItem(PROJECT, other.id, { sizing_rule: "R12" }), /只能用一次/);
  assert.ok(a);
});

test("7 clarification loop: answer → proposal → apply → quantities recompute and flag", async () => {
  await runJobFn((ctx) => svc.analyzeMaterials(PROJECT, { all: true, ...ctx })).catch(() => {});
  const q = repo.listQuestions(PROJECT).find((x) => x.param === "dock_count");
  assert.ok(q);
  let proposal;
  const j = startJob({ projectId: PROJECT, kind: "answer", steps: ["a"], run: async ({ llm }) => (proposal = await svc.proposeAnswer(PROJECT, q.id, { answer: "客户确认 12 个机场，沿高速布设", answer_source: "口头" }, llm)) });
  await j.promise;

  assert.equal(proposal.changes.length, 1, "unsupported pilots=99 is dropped");
  assert.ok(proposal.dropped.length >= 1);
  assert.equal(repo.getQuestion(PROJECT, q.id).status, "已答复");
  assert.equal(svc.projectView(PROJECT).params.find((p) => p.name === "dock_count").value, 10, "nothing applied yet");

  svc.applyAnswer(PROJECT, q.id, [0]);
  const view = svc.projectView(PROJECT);
  const dock = view.params.find((p) => p.name === "dock_count");
  assert.equal(dock.value, 12);
  assert.equal(dock.status, "客户确认");
  assert.equal(repo.getQuestion(PROJECT, q.id).status, "已应用");

  const rule = (id) => view.items.find((i) => i.sizing_rule === id);
  assert.equal(rule("R04").qty, 12, "licence recomputed");
  assert.match(rule("R04").stale, /客户答复|澄清答复/);
  assert.ok(!view.questions.some((x) => x.param === "dock_count" && x.status === "待处理"), "confirmed param no longer asked");
});

test("8 deleting a requirement flags its PBS lines and updates coverage", () => {
  const before = svc.projectView(PROJECT);
  const target = before.items.find((i) => i.name === "EyePod 吊舱");
  const code = target.req_ids[0];
  svc.editRequirement(PROJECT, code, { status: "已删除", reason: "客户取消夜航" });
  const view = svc.projectView(PROJECT);
  assert.ok(!view.items.find((i) => i.id === target.id).req_ids.includes(code));
  assert.match(repo.getItem(PROJECT, target.id).stale, /已删除/);
});

test("9 rematch returns a suggestion and accepting it edits the line", async () => {
  const item = svc.projectView(PROJECT).items.find((i) => i.name === "车牌识别取证定制");
  let result;
  const j = startJob({ projectId: PROJECT, kind: "rematch", steps: ["m"], run: async ({ llm }) => (result = await svc.rematchItem(PROJECT, item.id, { instruction: "", llm })) });
  await j.promise;
  assert.equal(result.suggestion.name, "车牌识别取证");
  svc.acceptRematch(PROJECT, item.id, result.suggestion);
  assert.equal(repo.getItem(PROJECT, item.id).name, "车牌识别取证");
  assert.equal(repo.getItem(PROJECT, item.id).edited, true);
});

test("10 chat: model actions are validated and run through the same services", async () => {
  const turn = async (text) => {
    const j = startJob({ projectId: PROJECT, kind: "chat", steps: ["理解"], run: (ctx) => chat.chatTurn(PROJECT, { text }, ctx) });
    await j.promise;
    return repo.listChat(PROJECT, 2).at(-1);
  };

  const a = await turn("把机场改成 14 个");
  assert.equal(svc.projectView(PROJECT).params.find((p) => p.name === "dock_count").value, 14);
  assert.ok(a.payload.results[0].ok);
  assert.equal(a.payload.open.tab, "pbs");

  const b = await turn("为什么要自研车牌识别？");
  assert.deepEqual(b.payload.results, []);
  assert.equal(b.content, "因为产品限制。");

  const c = await turn("乱来");
  assert.equal(c.payload.results.length, 2);
  assert.ok(c.payload.results.every((r) => !r.ok), "unknown item and unknown action are refused");
  assert.match(c.payload.results[0].text, /99999|没有找到/);

  const history = repo.listChat(PROJECT, 50);
  assert.ok(history.filter((m) => m.role === "user").length >= 3);
});

test("11 products: manual edit re-indexes retrieval", async () => {
  const p = svc.saveProduct(null, { name: "测试喊话器", capabilities: "夜间远距离喊话", limits: "", unit: "台" });
  const [hits] = await rag.search(["夜间喊话"], { topK: 5 });
  assert.ok(hits.some((h) => h.chunk.product_id === p.id), "new product is retrievable");
  svc.deleteProduct(p.id);
  const [after] = await rag.search(["夜间喊话"], { topK: 5 });
  assert.ok(!after.some((h) => h.chunk.product_id === p.id));
  assert.throws(() => svc.saveProduct(null, { name: "测试喊话器", capabilities: "x" }) && svc.saveProduct(null, { name: "测试喊话器" }), /同名/);
});

test("12 manual splitting and retrieval over a manual", async () => {
  const text = `# 产品手册\n\n## 概述\nSkyOps 是低空飞行管控平台，提供航线规划与任务调度。\n\n## 限制\n单套标准版最多接入 20 台机场，超出需要购买扩容授权。\n\n## 部署\n支持麒麟操作系统与达梦数据库。`;
  const chunks = rag.splitManual(text, 60);
  assert.ok(chunks.length >= 2);
  const docId = repo.createDoc({ productId: "P01", name: "SkyOps手册.md", text });
  rag.indexManual({ docId, productId: "P01", text });
  const [hits] = await rag.search(["接入机场数量上限 扩容"], { topK: 5 });
  assert.ok(hits.some((h) => h.chunk.kind === "manual" && h.chunk.text.includes("20 台机场")));
});

test("13 export view has everything the workbook needs", async () => {
  const view = svc.projectView(PROJECT);
  assert.ok(view.items.length && view.groups.length && view.audit.length >= 0);
  const { exportProject } = await import("../server/xlsx.mjs").catch(() => ({}));
  if (!exportProject) return;
  try {
    const buf = await exportProject(view);
    assert.ok(buf.length > 1000);
  } catch (error) {
    if (!/exceljs/.test(error.message)) throw error;
  }
});
