import { CATEGORIES } from "../engine/extract.mjs";
import { runtimeConfig } from "./catalog.mjs";
import * as repo from "./repo.mjs";
import * as svc from "./services.mjs";
import * as scenarios from "./scenarios.mjs";

/**
 * Conversational control layer. The user talks; the model turns the message into a list of
 * whitelisted actions; code validates every target and runs them through the same services the
 * workspace tables use. Nothing here bypasses the rules in services/engine.
 */

const SOURCES = ["自有产品", "外采", "自研", "服务"];

const SYSTEM = `你是 PBS 拆解助手，和售前、方案人员对话，帮他们把客户需求拆成 PBS（产品清单）并匹配公司产品。你说话简洁、直接、像同事。

你可以做的事（actions）。只能用下面这些，不要发明新的：
- add_material {kind: tender|minutes|oral|other, title}：用户这条消息本身（或随消息上传的文件）是一份客户材料。材料内容由系统取用户原文，你不要复述。
- analyze {all?}：从未处理的材料中抽取需求（all=true 表示全部重新抽取）。
- confirm_requirements {codes?: ["R001"], scope?: "batchable"|"all"}：确认需求。scope=batchable 只确认低风险的“批量确认”级。
- edit_requirement {code, text?, priority?, category?}：修改需求。priority 取 必须/重要/一般。
- delete_requirement {code, reason}：删除需求（可恢复）。
- add_requirement {text, category?, priority?}：新增需求。
- set_param {name, value}：设定测算参数（name 取参数字典）。用户明确说了数量时使用；客户的答复请用 answer_question。
- answer_question {id, answer}：用户转述了客户对某个澄清问题的答复。系统会再分析它带来的变更，让用户确认。
- generate_scenarios {}：从原始需求生成场景需求、来源映射和待确认事项，保留人工成果。
- confirm_scenarios {codes: ["SC001"]}：用户明确要求确认场景时使用。
- edit_scenario {code, name?, goal?, context?, trigger?}：修改场景，保存后待确认。
- generate_capabilities {}：从需求归纳业务能力（先推演业务场景，再归纳能力；能力只讲业务上需要什么，不涉及产品）。历史兼容功能，新流程优先使用generate_scenarios。
- confirm_capabilities {codes?: ["C01"], scope?: "all"}：确认业务能力。
- edit_capability {code, name?, description?, activity?, priority?}：修改业务能力。
- delete_capability {code, reason}：删除业务能力（可恢复）。
- generate_pbs {}：生成（或重新生成）PBS。人工改过的项会保留。
- edit_item {id, name?, source?, product_ref?, qty?, unit?, parent?}：修改 PBS 项。用户直接给出数量时用 qty（会标记为人工确认）。
- delete_item {id}：删除 PBS 项。
- rematch_item {id, instruction?}：让系统重新判断某一项该用哪个产品或外采、自研。
- confirm_items {ids?: [..], scope?: "all"}：确认 PBS 项。
- finish {}：标记项目完成。
- show {view: requirements|scenarios|questions|pbs|materials|export}：让右侧工作区切到某个页面。

规则：
- 只依据“项目现状”回答，不要编造现状里没有的编号、数字或产品。引用编号时必须是现状里存在的。
- 用户问“为什么”“依据是什么”时，用现状里该项的需求、产品能力、限制、数量规则来解释，不需要 action。
- 用户的意思不明确、或缺少必要信息（比如没说改成多少）时，不要猜，在 reply 里问清楚，actions 给空数组。
- 一条消息可以包含多个 action，按顺序执行。需要先抽取需求再生成 PBS 时，两个 action 都给出。
- 不要执行用户没有要求的操作。用户只是在聊或提问时，actions 为空。
- reply 是在操作之前写的，所以写成“好的，我来……”或直接回答问题；系统会在操作后自动补上结果摘要，你不要在 reply 里预测结果。
- reply 不超过 120 字，除非是在解释一项的依据（可以到 200 字）。用中文，不用 Markdown 标题。

只输出 JSON：{"reply":"...","actions":[{"type":"edit_item","id":12,"qty":12}]}`;

// ---------- context the model sees ----------

function context(projectId, view) {
  const { sizing } = runtimeConfig(projectId);
  const s = view.steps;
  const lines = [];
  lines.push(`项目：${view.project.name}（客户：${view.project.customer || "未填"}，行业：${view.project.industry || "未填"}）`);
  lines.push(
    `进度：材料 ${s.materials.count} 份（未处理 ${s.materials.pending}）；需求 ${s.requirements.total} 条（待确认 ${s.requirements.pending}，必审未处理 ${s.requirements.mustReview}）；澄清问题待处理 ${s.questions.open}，已答复待应用 ${s.questions.answered}；PBS ${s.pbs.items} 项（未覆盖 ${s.pbs.uncovered}，待复核 ${s.pbs.stale}，数量待估 ${s.pbs.pendingQty}，约束冲突 ${s.pbs.conflicts}）`,
  );

  lines.push("\n测算参数字典（name：含义 = 当前值，来源）：");
  const params = new Map(view.params.map((p) => [p.name, p]));
  for (const [name, spec] of Object.entries(sizing.params)) {
    const p = params.get(name);
    lines.push(`- ${name}：${spec.label}（${spec.unit}）= ${p?.value ?? "未知"}${p ? `，${p.status}` : ""}`);
  }

  const reqs = view.requirements.filter((r) => r.status !== "已删除");
  if (reqs.length) {
    lines.push("\n需求（编号 [类别/优先级/状态/审核] 内容）：");
    for (const r of reqs.slice(0, 150)) lines.push(`${r.code} [${r.category}/${r.priority}/${r.status}${r.review ? "/" + r.review : ""}${r.star ? "/★" : ""}] ${r.text}`);
    if (reqs.length > 150) lines.push(`……另有 ${reqs.length - 150} 条`);
  }

  if (view.scenarios.length) {
    lines.push("\n场景需求（编号 版本 状态 名称 目标 关联需求）：");
    for (const scene of view.scenarios.filter((s) => s.status !== "已归档")) lines.push(`${scene.code} v${scene.revision} ${scene.status} ${scene.name} ${scene.goal} ${scene.links.map((l) => l.req_id).join("、")}`);
  }
  const caps = view.capabilities.filter((c) => c.status !== "已删除");
  if (caps.length) {
    lines.push("\n业务能力（编号 [优先级/状态] 名称｜业务活动｜被哪些 PBS 项实现）：");
    for (const c of caps.slice(0, 60)) lines.push(`${c.code} [${c.priority}/${c.status}] ${c.name}｜${c.activity}｜${c.leaves.join("、") || "尚未被 PBS 实现"}`);
  }

  const qs = view.questions.filter((q) => ["待处理", "待答复", "已答复"].includes(q.status));
  if (qs.length) {
    lines.push("\n未结清的澄清问题（Q编号 状态 问题）：");
    for (const q of qs.slice(0, 30)) lines.push(`Q${q.id} ${q.status} ${q.question}${q.answer ? `（已答复：${q.answer}）` : ""}`);
  }

  if (view.items.length) {
    const reqByCode = new Map(view.requirements.map((r) => [r.code, r]));
    lines.push("\nPBS 项（id 编码 名称｜来源｜产品｜数量｜数量依据｜依据）：");
    for (const it of view.items.slice(0, 80)) {
      const m = it.match;
      const matchText = m?.type === "限制拆出" ? `被 ${m.product_name} 的限制挡住：${m.limit}` : m?.capabilities?.length ? `命中能力：${m.capabilities.join("、")}` : m ? "产品配套项" : "";
      const rule = it.sizing?.rule_id ? `${it.sizing.rule_id} ${it.sizing.expr}（${(it.sizing.inputs ?? []).map((i) => `${i.label}=${i.value}`).join("，")}）` : it.qty_basis;
      const why = it.req_ids.map((c) => `${c} ${reqByCode.get(c)?.text ?? ""}`).join("；");
      lines.push(`${it.id} ${it.code} ${it.name}｜${it.source}｜${it.product_ref ?? "-"}｜${it.qty ?? "待估"}${it.unit}｜${it.manual_qty ? "人工确认" : rule}｜${matchText}${why ? `｜承接：${why}` : ""}${it.stale ? `｜待复核：${it.stale}` : ""}`);
    }
  }
  if (view.conflicts.length) {
    lines.push("\n约束冲突：");
    for (const c of view.conflicts) lines.push(`- ${c.product_name} 不满足 ${c.req_id}：${c.evidence}`);
  }

  const products = repo.listProducts().filter((p) => p.metadata.active !== false);
  lines.push(`\n产品库共 ${products.length} 个产品：${products.map((p) => `${p.id} ${p.name}（${p.metadata.delivery_source ?? "自有产品"}，${p.metadata.availability ?? "待核实"}）`).join("、")}`);
  return lines.join("\n");
}

function history(projectId) {
  return repo
    .listChat(projectId, 8)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 300)}`)
    .join("\n");
}

// ---------- action validation ----------

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Returns { run } for a valid action, or { error } describing why it was skipped. */
function plan(action, view, ctx) {
  const reqs = new Map(view.requirements.map((r) => [r.code, r]));
  const items = new Map(view.items.map((i) => [i.id, i]));
  const questions = new Map(view.questions.map((q) => [q.id, q]));
  const { sizing } = runtimeConfig(view.project.id);
  const a = action ?? {};
  const needReq = () => {
    const r = reqs.get(String(a.code));
    if (!r) throw new Error(`没有找到需求 ${a.code}`);
    return r;
  };
  const needItem = () => {
    const i = items.get(Number(a.id));
    if (!i) throw new Error(`没有找到 PBS 项 #${a.id}`);
    return i;
  };

  switch (a.type) {
    case "add_material": {
      const text = ctx.attachment?.text ?? ctx.text;
      if (String(text).trim().length < 20) throw new Error("材料内容太短（至少 20 个字）");
      return { label: "添加材料", steps: [], run: () => (svc.addMaterial(ctx.projectId, { kind: a.kind, title: a.title, text, fileName: ctx.attachment?.name }), `已添加材料「${a.title || ctx.attachment?.name || "新材料"}」`) };
    }
    case "analyze":
      return {
        label: "抽取需求",
        steps: ["模型抽取需求", "保存与校验", "生成澄清问题"],
        run: async (sub) => {
          const r = await svc.analyzeMaterials(ctx.projectId, { all: Boolean(a.all), llm: ctx.llm, progress: sub });
          return { text: `抽取了 ${r.requirements} 条需求，新增 ${r.questions} 个澄清问题`, open: "requirements" };
        },
      };
    case "confirm_requirements": {
      let codes = Array.isArray(a.codes) ? a.codes.map(String) : [];
      if (a.scope === "batchable") codes = view.requirements.filter((r) => r.status === "待确认" && r.review === "批量确认").map((r) => r.code);
      if (a.scope === "all") codes = view.requirements.filter((r) => r.status === "待确认").map((r) => r.code);
      codes = codes.filter((c) => reqs.get(c)?.status === "待确认");
      if (!codes.length) throw new Error("没有可确认的需求");
      return { label: "确认需求", steps: [], run: () => (svc.confirmRequirements(ctx.projectId, codes), { text: `已确认 ${codes.length} 条需求`, open: "requirements" }) };
    }
    case "edit_requirement": {
      const r = needReq();
      const body = {};
      if (a.text) body.text = String(a.text);
      if (a.priority && ["必须", "重要", "一般"].includes(a.priority)) body.priority = a.priority;
      if (a.category && CATEGORIES.includes(a.category)) body.category = a.category;
      if (!Object.keys(body).length) throw new Error("没有要修改的内容");
      return { label: "修改需求", steps: [], run: () => (svc.editRequirement(ctx.projectId, r.code, body), { text: `已修改 ${r.code}`, open: "requirements" }) };
    }
    case "delete_requirement": {
      const r = needReq();
      return { label: "删除需求", steps: [], run: () => (svc.editRequirement(ctx.projectId, r.code, { status: "已删除", reason: String(a.reason || "对话中删除") }), { text: `已删除 ${r.code}（可在需求页恢复）`, open: "requirements" }) };
    }
    case "add_requirement": {
      if (!String(a.text ?? "").trim()) throw new Error("新增需求缺少内容");
      return { label: "新增需求", steps: [], run: () => ({ text: `已新增需求 ${svc.addRequirement(ctx.projectId, { text: a.text, category: a.category, priority: a.priority, source_note: "对话中新增" })}`, open: "requirements" }) };
    }
    case "set_param": {
      const spec = sizing.params[a.name];
      const value = num(a.value);
      if (!spec) throw new Error(`没有「${a.name}」这个参数`);
      if (value === null || !Number.isFinite(value)) throw new Error("参数值必须是数字");
      return { label: "设定参数", steps: [], run: () => (svc.setParam(ctx.projectId, a.name, { value, note: "对话中设定" }), { text: `「${spec.label}」设为 ${value}${spec.unit}，相关数量已重算`, open: "pbs" }) };
    }
    case "answer_question": {
      const q = questions.get(Number(String(a.id).replace(/^Q/i, "")));
      if (!q) throw new Error(`没有找到问题 Q${a.id}`);
      if (!String(a.answer ?? "").trim()) throw new Error("缺少客户答复内容");
      return {
        label: "分析客户答复",
        steps: ["模型分析答复的影响"],
        run: async (sub) => {
          sub.step(0);
          const proposal = await svc.proposeAnswer(ctx.projectId, q.id, { answer: a.answer, answer_source: "对话" }, ctx.llm);
          return { text: proposal.changes.length ? `记下了 Q${q.id} 的答复，分析出 ${proposal.changes.length} 项变更，请确认` : `记下了 Q${q.id} 的答复，这条答复没有带来变更`, card: { kind: "proposal", question_id: q.id } };
        },
      };
    }
    case "generate_scenarios":
      return { label: "生成场景需求", steps: ["归纳场景与待确认事项", "校验来源并保存草稿"], run: async (progress) => {
        const result = await scenarios.generateScenarios(ctx.projectId, { llm: ctx.llm, progress });
        return { text: `生成 ${result.created} 条场景需求，保留 ${result.kept} 条人工成果`, open: "scenarios" };
      } };
    case "confirm_scenarios": {
      const selected = view.scenarios.filter((s) => s.status !== "已归档" && a.codes?.includes(s.code));
      if (!selected.length) throw new Error("请选择真实存在的场景编号");
      return { label: "确认场景", steps: [], run: () => (scenarios.confirmScenarios(ctx.projectId, { scenarios: selected.map((s) => ({ code: s.code, revision: s.revision })) }), { text: `已确认 ${selected.length} 条场景`, open: "scenarios" }) };
    }
    case "edit_scenario": {
      const scene = view.scenarios.find((s) => s.code === a.code);
      if (!scene) throw new Error("场景不存在");
      const fields = Object.fromEntries(["name", "goal", "context", "trigger"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      return { label: "修改场景", steps: [], run: () => (scenarios.editScenario(ctx.projectId, scene.code, { ...fields, revision: scene.revision }), { text: `${scene.code} 已保存，待确认`, open: "scenarios" }) };
    }
    case "generate_capabilities":
      if (!view.requirements.some((r) => r.status !== "已删除")) throw new Error("还没有需求，先添加材料并抽取需求");
      return {
        label: "归纳业务能力",
        steps: ["模型推演业务场景并归纳能力", "校验与保存"],
        run: async (sub) => {
          const r = await svc.generateCapabilities(ctx.projectId, { llm: ctx.llm, progress: sub });
          return { text: `归纳出 ${r.capabilities} 条业务能力${r.uncovered ? `，另有 ${r.uncovered} 条必须需求没有对应能力` : ""}`, open: "capabilities" };
        },
      };
    case "confirm_capabilities": {
      const caps = new Map(view.capabilities.map((c) => [c.code, c]));
      let codes = Array.isArray(a.codes) ? a.codes.map(String) : [];
      if (a.scope === "all") codes = view.capabilities.filter((c) => c.status === "待确认").map((c) => c.code);
      codes = codes.filter((c) => caps.get(c)?.status === "待确认");
      if (!codes.length) throw new Error("没有可确认的业务能力");
      return { label: "确认业务能力", steps: [], run: () => (svc.confirmCapabilities(ctx.projectId, codes), { text: `已确认 ${codes.length} 条业务能力`, open: "capabilities" }) };
    }
    case "edit_capability": {
      const cap = view.capabilities.find((c) => c.code === String(a.code));
      if (!cap) throw new Error(`没有找到业务能力 ${a.code}`);
      const body = {};
      for (const k of ["name", "description", "activity"]) if (a[k]) body[k] = String(a[k]);
      if (a.priority && ["必须", "重要", "一般"].includes(a.priority)) body.priority = a.priority;
      if (!Object.keys(body).length) throw new Error("没有要修改的内容");
      return { label: "修改业务能力", steps: [], run: () => (svc.editCapability(ctx.projectId, cap.code, body), { text: `已修改 ${cap.code}`, open: "capabilities" }) };
    }
    case "delete_capability": {
      const cap = view.capabilities.find((c) => c.code === String(a.code));
      if (!cap) throw new Error(`没有找到业务能力 ${a.code}`);
      return { label: "删除业务能力", steps: [], run: () => (svc.editCapability(ctx.projectId, cap.code, { status: "已删除", reason: String(a.reason || "对话中删除") }), { text: `已删除 ${cap.code}（可在能力页恢复）`, open: "capabilities" }) };
    }
    case "generate_pbs":
      if (!view.requirements.some((r) => r.status !== "已删除")) throw new Error("还没有需求，先添加材料并抽取需求");
      return {
        label: "生成 PBS",
        steps: ["检索产品库与手册", "模型生成 PBS 并匹配产品", "校验匹配与补漏", "规则测算与审核"],
        run: async (sub) => {
          const r = await svc.generateProjectPbs(ctx.projectId, { llm: ctx.llm, progress: sub });
          return { text: `生成了 ${r.items} 项 PBS${r.kept ? `（保留你改过的 ${r.kept} 项）` : ""}${r.conflicts ? `，发现 ${r.conflicts} 个约束冲突` : ""}`, open: "pbs" };
        },
      };
    case "edit_item": {
      const it = needItem();
      const body = {};
      for (const k of ["name", "unit", "parent"]) if (a[k] !== undefined && a[k] !== null) body[k] = String(a[k]);
      if (a.source) {
        if (!SOURCES.includes(a.source)) throw new Error("来源只能是 自有产品/外采/自研/服务");
        body.source = a.source;
      }
      if (a.product_ref !== undefined) body.product_ref = a.product_ref || null;
      if (a.qty !== undefined) {
        const q = num(a.qty);
        if (q !== null && (!Number.isFinite(q) || q < 0)) throw new Error("数量必须是非负数");
        body.qty = q;
      }
      if (!Object.keys(body).length) throw new Error("没有要修改的内容");
      return { label: "修改 PBS 项", steps: [], run: () => (svc.saveItem(ctx.projectId, it.id, body), { text: `已修改 ${it.code} ${it.name}`, open: "pbs", focus: it.id }) };
    }
    case "delete_item": {
      const it = needItem();
      return { label: "删除 PBS 项", steps: [], confirm: { text: `删除 PBS 项 ${it.code}「${it.name}」？`, kind: "delete_item", item_id: it.id }, run: () => (svc.deleteItem(ctx.projectId, it.id), { text: `已删除 ${it.code} ${it.name}`, open: "pbs" }) };
    }
    case "rematch_item": {
      const it = needItem();
      return {
        label: "重新匹配",
        steps: ["检索并重新匹配"],
        run: async (sub) => {
          sub.step(0);
          const r = await svc.rematchItem(ctx.projectId, it.id, { instruction: String(a.instruction ?? ""), llm: ctx.llm });
          return { text: `重新判断了 ${it.code} ${it.name}，请看建议`, card: { kind: "rematch", item_id: it.id, suggestion: r.suggestion, chunks: r.chunks, notes: r.notes, before: { name: it.name, source: it.source, product_ref: it.product_ref } } };
        },
      };
    }
    case "confirm_items": {
      let ids = Array.isArray(a.ids) ? a.ids.map(Number) : [];
      if (a.scope === "all") ids = view.items.filter((i) => !i.confirmed).map((i) => i.id);
      ids = ids.filter((id) => items.has(id));
      if (!ids.length) throw new Error("没有可确认的 PBS 项");
      return { label: "确认 PBS 项", steps: [], run: () => (svc.confirmItems(ctx.projectId, ids), { text: `已确认 ${ids.length} 项`, open: "pbs" }) };
    }
    case "finish":
      return { label: "标记完成", steps: [], run: () => (repo.updateProject(ctx.projectId, { done: true }), repo.logEvent(ctx.projectId, "项目", "标记完成"), { text: "项目已标记为完成，可以导出了", open: "finish" }) };
    case "show": {
      const views = ["requirements", "scenarios", "capabilities", "questions", "pbs", "materials", "export"];
      if (!views.includes(a.view)) throw new Error("不认识的页面");
      return { label: "切换页面", steps: [], run: () => ({ text: "", open: a.view === "export" ? "finish" : a.view === "capabilities" ? "scenarios" : a.view }) };
    }
    default:
      throw new Error(`不支持的操作 ${a.type}`);
  }
}

// ---------- suggestions (quick replies) ----------

export function suggestions(view) {
  const s = view.steps;
  const out = [];
  if (!s.materials.count) return [{ label: "用示例试试", ui: "samples" }];
  if (s.materials.pending) out.push({ label: `抽取 ${s.materials.pending} 份新材料的需求`, actions: [{ type: "analyze" }] });
  const batchable = view.requirements.filter((r) => r.status === "待确认" && r.review === "批量确认").length;
  if (batchable) out.push({ label: `确认 ${batchable} 条低风险需求`, actions: [{ type: "confirm_requirements", scope: "batchable" }] });
  if (s.requirements.mustReview) out.push({ label: `看 ${s.requirements.mustReview} 条必审需求`, ui: "open:requirements" });
  if (s.questions.answered) out.push({ label: `应用 ${s.questions.answered} 条已答复`, ui: "open:questions" });
  if (s.requirements.total && !s.scenarios.active) out.push({ label: "拆分场景需求", actions: [{ type: "generate_scenarios" }] });
  if (s.scenarios.pending) out.push({ label: `审阅 ${s.scenarios.pending} 条场景需求`, ui: "open:scenarios" });
  if (s.requirements.total && !s.pbs.items) out.push({ label: "生成 PBS", actions: [{ type: "generate_pbs" }] });
  if (s.pbs.items) {
    if (s.pbs.stale) out.push({ label: `复核 ${s.pbs.stale} 项变化`, ui: "open:pbs" });
    if (s.pbs.conflicts) out.push({ label: `看 ${s.pbs.conflicts} 个约束冲突`, ui: "open:pbs" });
    if (s.pbs.pendingQty) out.push({ label: `${s.pbs.pendingQty} 项数量待估`, ui: "open:pbs" });
    if (s.questions.open) out.push({ label: `${s.questions.open} 个澄清问题待处理`, ui: "open:questions" });
    out.push({ label: "导出 Excel", ui: "export" });
    if (!view.project.done && !s.pbs.blockers && !s.pbs.uncovered) out.push({ label: "标记完成", actions: [{ type: "finish" }] });
  }
  return out.slice(0, 5);
}

// ---------- one conversational turn ----------

/**
 * body: { text?, file?: {name, text}, actions? }  — `actions` skips intent detection (quick-reply buttons).
 */
export async function chatTurn(projectId, body, { llm, progress }) {
  const text = String(body.text ?? "").trim();
  const attachment = body.attachment ?? null;
  if (!text && !attachment && !body.actions?.length) throw new Error("请输入内容");
  const userLabel = text || (attachment ? `（上传了文件 ${attachment.name}）` : body.label || "");
  if (userLabel) repo.addChat(projectId, "user", userLabel, attachment ? { attachment: { name: attachment.name, size: attachment.text.length } } : {});

  progress.setSteps(["理解你的意思"]);
  let reply = "";
  let actions = body.actions ?? [];

  if (!actions.length) {
    progress.step(0);
    const view = svc.projectView(projectId);
    const attachNote = attachment ? `\n\n用户随消息上传了文件《${attachment.name}》（${attachment.text.length} 字），开头：${attachment.text.slice(0, 200)}` : "";
    const longNote = !attachment && text.length > 150 ? `\n\n（这条消息有 ${text.length} 字，很可能是一份客户材料。）` : "";
    const data = await llm.json({
      step: "chat",
      system: SYSTEM,
      user: `项目现状：\n${context(projectId, view)}\n\n最近对话：\n${history(projectId)}\n\n用户这条消息：\n${text.slice(0, 1500)}${attachNote}${longNote}`,
      maxTokens: 1500,
    });
    reply = String(data.reply ?? "").trim();
    actions = Array.isArray(data.actions) ? data.actions.slice(0, 6) : [];
  }

  // Validate everything first so a bad action does not leave half the batch applied.
  const view = svc.projectView(projectId);
  const ctx = { projectId, text, attachment, llm };
  const planned = [];
  const results = [];
  for (const action of actions) {
    try {
      planned.push({ action, ...plan(action, view, ctx) });
    } catch (error) {
      results.push({ ok: false, text: error.message });
    }
  }

  const heavy = planned.flatMap((p) => p.steps.map((name) => ({ name, owner: p })));
  if (heavy.length) progress.setSteps(["理解你的意思", ...heavy.map((h) => h.name)], 1);

  const cards = [];
  const opens = [];
  let offset = 1;
  for (const p of planned) {
    if (p.confirm) {
      cards.push({ ...p.confirm, state: "pending" });
      continue;
    }
    const sub = {
      step: (i, d) => progress.step(offset + i, d),
      detail: (d) => progress.detail(d),
    };
    try {
      const out = await p.run(sub);
      const result = typeof out === "string" ? { text: out } : out;
      if (result.text) results.push({ ok: true, text: result.text });
      if (result.card) cards.push({ ...result.card, state: "pending" });
      if (result.open) opens.push({ tab: result.open, focus: result.focus });
    } catch (error) {
      results.push({ ok: false, text: `${p.label}失败：${error.message}` });
    }
    offset += p.steps.length;
  }

  const lastOpen = opens.at(-1) ?? null;
  const next = suggestions(svc.projectView(projectId));
  const content = reply || (results.length ? "" : "好的。");
  const id = repo.addChat(projectId, "assistant", content, { results, cards, open: lastOpen, suggestions: next });
  return { messageId: id };
}

/**
 * Close a card in the conversation. Deleting an item happens here; proposal and rematch cards are
 * applied through their own endpoints first and only recorded here.
 */
export function resolveCard(projectId, messageId, cardIndex, decision) {
  const msg = repo.getChat(projectId, messageId);
  const card = msg.payload.cards?.[cardIndex];
  if (!card || card.state !== "pending") throw new Error("这张卡片已经处理过了");
  let note = decision === "accept" ? "已采纳" : "已取消";
  if (decision === "accept" && card.kind === "delete_item") {
    svc.deleteItem(projectId, card.item_id);
    note = "已删除";
  }
  card.state = decision === "accept" ? "accepted" : "dismissed";
  card.note = note;
  repo.updateChatPayload(projectId, messageId, msg.payload);
  return { note };
}

export const chatHistory = (projectId) => repo.listChat(projectId, 200);
