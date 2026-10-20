import { validateArguments } from "../../agents/pbs/contracts/tools.mjs";
import { COLLABORATION_TOOLS } from "../../agents/pbs/contracts/collaboration.mjs";
import { ROLES, roleTools } from "../../agents/pbs/roles.mjs";
import { hash } from "../engine/scenario.mjs";
import { normalize } from "../engine/text.mjs";
import { localAgentAdapter } from "./agent-adapter.mjs";
import { getDb, json, now, parse, tx } from "./db.mjs";
import * as repo from "./repo.mjs";
import * as scenes from "./scenarios.mjs";
import * as store from "./collaboration-store.mjs";
import { approval, assertApproval, understandingVersion } from "./collaboration-approval.mjs";
import * as conversation from "./conversation-store.mjs";
import { latestReview, review, validateReviewReply, offerChange, offerUnderstanding } from "./conversation-review.mjs";
import { changeVersion } from "./chat.mjs";

const fail = (message) => { throw new Error(message); };
export function collaborationAdapter(t, activation, { signal, onProgress } = {}) {
  const { role, mode } = activation;
  const effectiveMode = mode === "intervention" && activation.input.work_mode === "discussion" ? "discussion" : mode;
  const revision = t.revision;
  const scope = `${t.id}:${role}:${activation.id}`;
  const allowed = [...roleTools(role, effectiveMode), ...COLLABORATION_TOOLS.filter((tool) => mode === "claim"
    ? ["collaboration_state", "respond_to_message"].includes(tool.name)
    : tool.name !== "respond_to_message" && (tool.name !== "submit_expert_answer" || mode === "consultation") && (tool.name !== "request_confirmation" || (mode !== "consultation" && role !== "materials")))];
  const readEvidence = new Map();
  const readInputs = new Set();
  const current = () => store.task(t.id);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const live = current();
    if (!["running", "syncing", "waiting_expert"].includes(live.status)) fail("任务已暂停，不能继续提交");
    if (live.revision !== revision) fail("已收到新的人工补充，当前依据已过期，请结束本次活动等待同步");
    return live;
  };
  const checkReferences = (references = []) => {
    const ids = new Set([...repo.listRequirements(t.project_id).map((r) => r.code), ...scenes.listScenarios(t.project_id).map((r) => r.code), ...repo.listItems(t.project_id).flatMap((r) => [r.code, `pbs:${r.id}`]), ...repo.listSegments(t.project_id).map((s) => s.uid)]);
    if (references.some((ref) => !ids.has(ref))) fail("关联编号不存在于当前项目，请先读取真实成果");
  };
  const checkWrite = (name, args) => {
    const live = assertCurrent();
    if (["consultation", "claim"].includes(mode) || !ROLES[role].writes.includes(name)) fail("该角色或咨询任务没有此项写入权限");
    if (conversation.pendingMessages(t.id).length) fail("新消息仍在收件认领，先完成消息同步再写入成果");
    const pending = store.pendingInputs(t.id);
    if (pending.length && (mode !== "intervention" || pending.some((i) => !readInputs.has(i.id)))) fail("人工补充尚未处理，业务写入暂缓");
    if (["submit_pbs", "submit_solutions"].includes(name)) {
      const approved = assertApproval(live).snapshot;
      const reqIds = new Set(approved.requirements.map((r) => r.code)), sceneIds = new Set(approved.scenarios.map((s) => s.code));
      if ((args.items ?? args.solutions).some((r) => r.req_ids?.some((id) => !reqIds.has(id)) || r.scenario_ids?.some((id) => !sceneIds.has(id)))) fail("提交超出了本轮人工确认的需求或场景范围");
      if (name === "submit_solutions") for (const solution of args.solutions) for (const itemId of solution.item_ids) {
        const item = repo.getItem(t.project_id, itemId);
        if (item.req_ids.some((id) => !reqIds.has(id)) || item.scenario_ids.some((id) => !sceneIds.has(id))) fail("方案所含PBS项超出了本轮确认范围，请先调整范围或方案组合");
      }
      if (store.consultations(t.id).some((c) => c.caller === role && c.state === "waiting")) fail("有关专家咨询尚未答复，请收到答复后再提交PBS");
    }
  };
  const local = localAgentAdapter(t.project_id, { signal, onProgress, operationScope: scope, checkWrite, pbsScope: () => assertApproval(current()).snapshot.requirements.map((r) => r.code) });
  const handlers = {
    collaboration_state: () => ({ task: current(), role, activation_mode: mode, consultation_id: activation.input.consultation_id,
      message: mode === "claim" ? conversation.message(activation.input.message_id) : null,
      inbox: conversation.inbox(t.id).map(m => ({ id: m.id, content: m.content, targets: m.targets, state: m.state })),
      claims: mode === "claim" ? conversation.claims(activation.input.message_id) : [],
      review_request: mode === "claim" ? review(conversation.message(activation.input.message_id)?.data.reviewId) : latestReview(t.project_id),
      capabilities: { business_tools: roleTools(role, effectiveMode).map((tool) => tool.name),
        consultation_targets: mode === "claim" ? [] : ROLES[role].consult.map((target) => ({ role: target, label: ROLES[target].label })) },
      confirmation: approval(current().approval_id, t.project_id), consultations: store.consultations(t.id), interventions: store.interventions(t.id),
      rules: "只能使用实际工具答复。等待专家时结束本次活动，宿主将恢复。人工补充先read_interventions再处理。" }),
    respond_to_message(args) {
      assertCurrent();
      const m = conversation.message(args.message_id);
      if (mode !== "claim" || args.message_id !== activation.input.message_id || m?.task_id !== t.id || m.state !== "pending" || !m.targets.includes(role)) fail("只能对当前实际投递给本角色的消息作出认领");
      if (args.decision === "claim" && (!args.scope?.trim() || !args.work_mode)) fail("认领需说明本角色处理的具体范围，并区分问答与成果执行");
      if (args.decision === "review") validateReviewReply(m, args);
      conversation.recordClaim(m.id, role, args);
      return { recorded: true, next: "结束收件活动；待所有接收者判断后，宿主安排认领者处理。不要在收件活动执行业务。" };
    },
    request_confirmation(args) {
      assertCurrent();
      if (conversation.pendingMessages(t.id).length || store.pendingInputs(t.id).some(i => !readInputs.has(i.id))) fail("先读取并处理用户的新消息，再展示确认范围");
      const selection = args.requirements || args.scenarios ? { requirements: args.requirements, scenarios: args.scenarios } : undefined;
      const request = offerUnderstanding(current(), selection);
      if (!request) fail("当前没有可交接的需求范围，或仍有变更建议需要先处理");
      return { review_id: request.id, scope: request.data, state: "awaiting_user", next: "已在对话中请用户确认；本轮不能据此生成PBS。" };
    },
    ask_expert(args) {
      assertCurrent(); checkReferences(args.references);
      if (!ROLES[role].consult.includes(args.target)) fail("当前角色不允许向该专家发起咨询");
      const all = store.consultations(t.id);
      if (all.length >= 18) fail("本轮咨询已达18次，请保留待澄清事项并结束");
      if (all.some((c) => c.caller === role && c.target === args.target && normalize(c.question) === normalize(args.question) && c.revision === revision && c.input_version === understandingVersion(t.project_id) && c.state !== "stale")) fail("该问题已提交，请读取已有咨询；追问需说明新增疑点");
      if (args.followup_to && !all.some((c) => c.id === args.followup_to && c.caller === role && c.state === "answered")) fail("追问必须关联本角色已收到的真实答复");
      const id = store.uid();
      getDb().prepare("INSERT INTO collaboration_consultations(id,task_id,project_id,caller,target,activation_id,revision,input_version,question,data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, t.id, t.project_id, role, args.target, activation.id, revision, understandingVersion(t.project_id), args.question, json({ references: args.references ?? [], followup_to: args.followup_to }), now());
      store.enqueue(t, args.target, "consultation", { consultation_id: id });
      store.event(t, "question", role, args.target, args.question, { consultationId: id, references: args.references ?? [], followupTo: args.followup_to, status: "waiting" });
      return { consultation_id: id, status: "waiting", next: "结束本次活动，答复后宿主恢复；不要轮询。" };
    },
    submit_expert_answer(args) {
      assertCurrent();
      const c = store.consultations(t.id).find((c) => c.id === args.consultation_id);
      if (mode !== "consultation" || c?.target !== role || c.id !== activation.input.consultation_id || c.state !== "waiting") fail("答复与当前咨询、角色或状态不匹配");
      if (c.revision !== revision || c.input_version !== understandingVersion(t.project_id)) fail("咨询依据已变化，旧答复不能用于当前成果");
      if (args.nature === "source_fact" && !args.evidence?.length) fail("原文事实必须返回可回读引用");
      if (args.nature === "human_confirmed") assertApproval(current());
      for (const e of args.evidence ?? []) {
        const source = readEvidence.get(e.evidence_id);
        if (!source) fail(`引用 ${e.evidence_id} 尚未在本次活动回读，请用read_evidence或read_document_batch读取后提交`);
        if (source.document_version !== e.document_version) fail(`引用 ${e.evidence_id} 的版本不匹配，请使用回读结果中的document_version`);
        if (!normalize(e.quote) || !normalize(source.text).includes(normalize(e.quote))) fail(`引用 ${e.evidence_id} 的quote不是已读取片段的连续原文，请回读并直接摘录`);
        const segment = repo.listSegments(t.project_id).find((s) => s.uid === e.evidence_id);
        if (!segment || hash(repo.getMaterial(t.project_id, segment.material_id).text) !== e.document_version) fail("原文来源已变化");
        if (!normalize(segment.text).includes(normalize(e.quote))) fail(`引用 ${e.evidence_id} 不是原文的连续摘录`);
      }
      getDb().prepare("UPDATE collaboration_consultations SET state='answered',answer=? WHERE id=?").run(json(args), c.id);
      store.event(t, "answer", role, c.caller, args.answer, { consultationId: c.id, nature: args.nature, evidence: args.evidence ?? [], unknowns: args.unknowns ?? [], status: "answered" });
      return { accepted: true, consultation_id: c.id };
    },
    record_consultation_outcome(args) {
      assertCurrent(); checkReferences(args.references);
      const c = store.consultations(t.id).find((c) => c.id === args.consultation_id);
      if (c?.caller !== role || c.state !== "answered" || c.revision !== revision || c.input_version !== understandingVersion(t.project_id)) fail("只能记录本角色当前有效答复的处理结果");
      getDb().prepare("UPDATE collaboration_consultations SET outcome=? WHERE id=?").run(json(args), c.id);
      store.event(t, "outcome", role, "human", args.explanation, { consultationId: c.id, references: args.references ?? [], outcome: args.outcome });
      return { recorded: true };
    },
    read_interventions() {
      assertCurrent();
      if (mode !== "intervention") return { messages: store.interventions(t.id).filter((i) => i.state === "handled"), instruction: "有新输入时结束活动，由宿主安排专门处理" };
      const all = store.pendingInputs(t.id);
      all.forEach((i) => readInputs.add(i.id));
      const pending = all.filter((i) => activation.input.intervention_ids.includes(i.id));
      for (const i of pending) {
        getDb().prepare("UPDATE collaboration_interventions SET state='delivered',delivered_activation=? WHERE id=?").run(activation.id, i.id);
        if (i.delivered_activation !== activation.id && !i.data.messageId) store.event(t, "delivery", role, "human", "已读到你的补充，正在核对相关依据与影响。", { interventionId: i.id, status: "delivered" });
      }
      return { messages: pending, other_pending_context: all.filter((i) => !activation.input.intervention_ids.includes(i.id)), note: "仅处理定向给本角色的messages；其他补充作为上下文参考。调整需实际保存，已确认范围变化需提交变更建议。" };
    },
    acknowledge_intervention(args) {
      assertCurrent(); checkReferences(args.references);
      const i = store.pendingInputs(t.id).find((i) => i.id === args.intervention_id);
      if (mode !== "intervention" || i?.delivered_activation !== activation.id) fail("请先通过read_interventions读取这条人工消息");
      const receipts = (args.operation_ids ?? []).map((id) => getDb().prepare("SELECT tool,result FROM agent_operations WHERE project_id=? AND operation_id=?").get(t.project_id, `${scope}:${id}`));
      const valid = receipts.filter((r) => r && parse(r.result, {}).ok);
      if (args.outcome === "adjusted" && !valid.some((r) => ["submit_requirements", "submit_scenarios", "submit_pbs", "submit_solutions"].includes(r.tool) && (parse(r.result, {}).data?.accepted?.length || parse(r.result, {}).data?.solutions?.length || parse(r.result, {}).data?.saved_items?.length))) fail("没有本次实际保存成果的记录，不能声称已据此调整");
      if (args.outcome === "requires_confirmation" && !valid.some((r) => r.tool === "propose_change")) fail("需要先提交可审阅的变更建议，再记录需人工确认");
      if (args.outcome !== "read_only") {
        // Conservative invalidation until the affected range has been explicitly reviewed.
        const before = changeVersion(t.project_id);
        getDb().prepare("UPDATE pbs_items SET stale='人工补充已影响本轮理解，请复核',confirmed=0 WHERE project_id=?").run(t.project_id);
        store.updateTask(t.id, { approval_id: null });
        const after = changeVersion(t.project_id);
        // Only the known host invalidation above may rebase still-current proposals.
        // Actual content changes continue to make older cards stale.
        if (before !== after) for (const row of getDb().prepare("SELECT id,payload FROM chat_messages WHERE project_id=?").all(t.project_id)) {
          const payload = parse(row.payload, {});
          const cards = payload.cards?.filter(c => c.kind === "agent_change" && c.state === "pending" && c.input_version === before) ?? [];
          if (cards.length) { cards.forEach(c => { c.input_version = after; }); repo.updateChatPayload(t.project_id, row.id, payload); }
        }
        if (before !== after) getDb().prepare("UPDATE conversation_reviews SET version=? WHERE project_id=? AND kind='change' AND state='pending' AND version=?").run(after, t.project_id, before);
      }
      getDb().prepare("UPDATE collaboration_interventions SET state='handled',result=? WHERE id=?").run(json(args), i.id);
      store.event(t, "intervention_result", role, "human", args.explanation, { interventionId: i.id, status: args.outcome, references: args.references ?? [] });
      return { recorded: true, outcome: args.outcome };
    },
  };
  return { tools: allowed, report: local.report, async execute(name, args) {
    const definition = allowed.find((tool) => tool.name === name);
    if (!definition) return { ok: false, error: { code: "ROLE_PERMISSION", message: "当前专家或咨询任务没有此工具权限" } };
    try {
      validateArguments(definition.inputSchema, args);
      if (handlers[name]) return tx((db) => {
        assertCurrent();
        const opId = args.operation_id ? `${scope}:${args.operation_id}` : null;
        const inputHash = hash({ name, args });
        const old = opId && db.prepare("SELECT * FROM agent_operations WHERE project_id=? AND operation_id=?").get(t.project_id, opId);
        if (old) { if (old.input_hash !== inputHash) fail("操作编号已用于其他内容"); return parse(old.result, {}); }
        const result = { ok: true, data: handlers[name](args) };
        if (opId) db.prepare("INSERT INTO agent_operations(project_id,operation_id,tool,input_hash,result,created_at) VALUES (?,?,?,?,?,?)").run(t.project_id, opId, name, inputHash, json(result), now());
        return result;
      });
      const result = await local.execute(name, args);
      if (result.ok && ["read_evidence", "read_document_batch"].includes(name)) {
        const read = name === "read_evidence" ? [result.data.source, ...result.data.neighbors] : result.data.items;
        for (const source of read) {
          const old = readEvidence.get(source.evidence_id);
          readEvidence.set(source.evidence_id, { ...source, text: old?.document_version === source.document_version ? `${old.text}\n${source.text}` : source.text });
        }
      }
      if (result.ok && result.data?.card) {
        const key = `${scope}:${args.operation_id}`;
        if (!getDb().prepare("SELECT 1 FROM collaboration_events WHERE project_id=? AND json_extract(payload,'$.operationKey')=?").get(t.project_id, key)) {
          const e = store.event(t, "change_proposal", role, "human", `${result.data.card.text}。请直接回复是否采纳，或告诉我需要怎样修改。`, { cards: [result.data.card], operationKey: key, status: "requires_confirmation" });
          offerChange(t, role, e, result.data.card);
        }
      }
      return result;
    } catch (error) { return { ok: false, error: { code: "COLLABORATION_VALIDATION", message: error.message } }; }
  } };
}
