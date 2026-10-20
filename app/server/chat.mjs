import { DELIVERY_SOURCES as SOURCES } from "../engine/catalog.mjs";
import { CATEGORIES } from "../engine/requirements.mjs";
import { runtimeConfig } from "./catalog.mjs";
import * as repo from "./repo.mjs";
import * as svc from "./services.mjs";
import * as scenarios from "./scenarios.mjs";
import { hash } from "../engine/scenario.mjs";
import { isConversationMessage } from "../shared/chat-events.mjs";

const AGENT_CHANGE_TYPES = new Set(["set_param", "edit_requirement", "add_requirement", "delete_requirement", "edit_scenario", "confirm_scenarios", "confirm_requirements", "edit_item", "confirm_items", "delete_item", "finish", "show"]);
export const changeVersion = (id) => hash({ requirements: repo.listRequirements(id), items: repo.listItems(id), params: repo.listOverrides(id), scenarios: scenarios.listScenarios(id), project: repo.getProject(id) });
export function proposeAgentChange(projectId, action) {
  if (!AGENT_CHANGE_TYPES.has(action.type)) throw new Error("该操作不能作为人工变更提案");
  const planned = plan(action, svc.projectView(projectId), { projectId });
  return { kind: "agent_change", state: "pending", text: planned.confirm?.text ?? planned.label, action, input_version: changeVersion(projectId) };
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Deterministic operations that run only after human acceptance of a proposal. */
function plan(action, view, ctx) {
  const reqs = new Map(view.requirements.map((r) => [r.code, r]));
  const items = new Map(view.items.map((i) => [i.id, i]));
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
    case "confirm_requirements": {
      let codes = Array.isArray(a.codes) ? a.codes.map(String) : [];
      if (a.scope === "batchable") codes = view.requirements.filter((r) => r.status === "待确认" && r.review === "批量确认").map((r) => r.code);
      if (a.scope === "all") codes = view.requirements.filter((r) => r.status === "待确认").map((r) => r.code);
      codes = codes.filter((c) => reqs.get(c)?.status === "待确认");
      if (!codes.length) throw new Error("没有可确认的需求");
      return { label: "确认需求", steps: [], run: () => (svc.confirmRequirements(ctx.projectId, codes), { text: `已确认 ${codes.length} 条需求描述，澄清事项仍保留`, open: "requirements" }) };
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
    case "confirm_items": {
      let ids = Array.isArray(a.ids) ? a.ids.map(Number) : [];
      if (a.scope === "all") ids = view.items.filter((i) => !i.confirmed).map((i) => i.id);
      ids = ids.filter((id) => items.has(id));
      if (!ids.length) throw new Error("没有可确认的 PBS 项");
      return { label: "确认 PBS 项", steps: [], run: () => (svc.confirmItems(ctx.projectId, ids), { text: `已确认 ${ids.length} 项`, open: "pbs" }) };
    }
    case "finish":
      return { label: "标记完成", steps: [], run: () => (repo.updateProject(ctx.projectId, { done: true }), repo.logEvent(ctx.projectId, "项目", "标记完成"), { text: "本轮整理已标记完成，检查结果与导出见右侧", open: "finish" }) };
    case "show": {
      const views = ["requirements", "scenarios", "capabilities", "questions", "pbs", "materials", "export"];
      if (!views.includes(a.view)) throw new Error("不认识的页面");
      return { label: "切换页面", steps: [], run: () => ({ text: "", open: a.view === "export" ? "finish" : a.view === "capabilities" ? "scenarios" : a.view }) };
    }
    default:
      throw new Error(`不支持的操作 ${a.type}`);
  }
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
  if (decision === "accept" && card.kind === "agent_change") {
    if (card.input_version !== changeVersion(projectId)) throw new Error("业务内容已变化，请重新提出变更建议");
    if (!AGENT_CHANGE_TYPES.has(card.action.type)) throw new Error("变更类型无效");
    const view = svc.projectView(projectId);
    if (card.action.type === "finish" && view.steps.pbs.blockers) throw new Error("PBS仍有未完成事项，请先处理");
    const change = plan(card.action, view, { projectId });
    const out = change.run();
    note = typeof out === "string" ? out : out.text || "已应用";
  }
  if (decision === "accept" && card.kind === "delete_item") {
    svc.deleteItem(projectId, card.item_id);
    note = "已删除";
  }
  card.state = decision === "accept" ? "accepted" : "dismissed";
  card.note = note;
  repo.updateChatPayload(projectId, messageId, msg.payload);
  return { note };
}

export const chatHistory = (projectId) => repo.listChat(projectId, 200).filter(isConversationMessage);
