import { ROLES } from "../../agents/pbs/roles.mjs";
import { getDb, json, now, parse, tx } from "./db.mjs";
import * as store from "./collaboration-store.mjs";
import { collaborationAdapter } from "./collaboration-tools.mjs";
import { assertApproval, understandingVersion } from "./collaboration-approval.mjs";
import { runRole } from "./agent-runner.mjs";
import { HttpError } from "./errors.mjs";
import * as conversation from "./conversation-store.mjs";
import { applyMessageReview, offerUnderstanding } from "./conversation-review.mjs";

const running = new Map();
const roleStage = { materials: "materials", understanding: "understanding", pbs: "pbs" };
const stageGoal = {
  materials: "完整检查待处理材料，按顺序阅读并保存有依据的需求、覆盖与疑点。只做材料拆解，场景交由需求理解专家。",
  understanding: "基于已保存需求组织客户场景、共性约束和澄清；需要原文解释时咨询材料专家。保存成果并请求人工审阅，不编制PBS。",
  pbs: "依据已确认需求理解包编制PBS与客户方案，按需向需求理解专家或材料专家多轮求证，保存待人工审阅草稿。",
};
export function createCollaboration(projectId, { goal, role = "understanding", flow = "single", approvalId = null, mode = "main" }) {
  if (!ROLES[role]) throw new HttpError(400, "专家不存在");
  return tx((db) => {
    const id = store.uid();
    db.prepare("INSERT INTO collaboration_tasks(id,project_id,goal,stage,status,approval_id,created_at,updated_at) VALUES (?,?,?,?,'running',?,?,?)")
      .run(id, projectId, goal, ["discussion", "conversation"].includes(mode) ? "discussion" : roleStage[role], approvalId, now(), now());
    const t = store.task(id);
    if (mode !== "conversation") store.enqueue(t, role, mode, { goal, flow });
    return t;
  });
}
export function receiveMessage(t, input) {
  return tx(db => {
    const old = conversation.message(input.id);
    if (old) {
      if (old.project_id !== t.project_id || old.content !== input.content) throw new HttpError(409, "消息编号已用于其他内容");
      return old;
    }
    t = store.task(t.id);
    const saved = conversation.saveMessage(t, input);
    store.updateTask(t.id, { revision: t.revision + 1, status: ["paused", "failed", "pausing"].includes(t.status) ? t.status : "syncing" });
    db.prepare("UPDATE collaboration_consultations SET state='stale' WHERE task_id=? AND state='waiting'").run(t.id);
    db.prepare("UPDATE collaboration_activations SET state='cancelled' WHERE task_id=? AND state='queued' AND mode IN ('consultation','intervention')").run(t.id);
    running.get(t.id)?.controller.abort(new Error("同步新的对话消息"));
    return saved;
  });
}
export function receiveIntervention(t, { id, text, target, consultationId, materialId }) {
  return tx((db) => {
    const previous = db.prepare("SELECT * FROM collaboration_interventions WHERE id=?").get(id);
    if (previous) {
      if (previous.project_id !== t.project_id || previous.content !== text) throw new HttpError(409, "消息编号已用于其他内容");
      return previous;
    }
    t = store.task(t.id);
    if (consultationId && !store.consultations(t.id).some((c) => c.id === consultationId)) throw new HttpError(400, "这段讨论不属于当前任务");
    target ||= materialId ? "materials" : (t.stage === "pbs" ? "understanding" : t.stage);
    if (!ROLES[target]) target = "understanding";
    const revision = t.revision + 1;
    db.prepare("INSERT INTO collaboration_interventions(id,task_id,project_id,target,content,data,revision,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, t.id, t.project_id, target, text, json({ consultationId, materialId, provenance: "用户补充，非正式招标答疑" }), revision, now());
    const paused = ["paused", "failed"].includes(t.status);
    store.updateTask(t.id, { revision, status: paused ? t.status : "syncing" });
    store.event(t, "intervention", "human", target, text, { interventionId: id, consultationId, status: "received", ...(materialId ? { open: { tab: "materials", focus: materialId } } : {}) });
    // Pending input and revision change commit before interruption or any further write.
    db.prepare("UPDATE collaboration_consultations SET state='stale' WHERE task_id=? AND state='waiting'").run(t.id);
    db.prepare("UPDATE collaboration_activations SET state='cancelled' WHERE task_id=? AND state='queued' AND mode='consultation'").run(t.id);
    db.prepare("UPDATE collaboration_activations SET state='cancelled' WHERE task_id=? AND state='queued' AND mode='intervention'").run(t.id);
    running.get(t.id)?.controller.abort(new Error("同步人工补充"));
    return { id, revision, state: "received" };
  });
}
export function pauseCollaboration(t) {
  store.updateTask(t.id, { status: "pausing" });
  const active = running.get(t.id);
  if (active) active.controller.abort(new Error("用户暂停任务"));
  else store.updateTask(t.id, { status: "paused" });
  store.event(t, "pause", "system", "human", active ? "正在暂停，已保存成果与补充保留。" : "任务已暂停，继续时会先处理你的补充。", { status: "paused" });
}
function prompt(t, a) {
  if (a.mode === "claim") return `你是${ROLES[a.role].label}。这是群聊收件活动，不是执行任务。先调用 collaboration_state，必要时只读项目资料，然后必须调用 respond_to_message，结束本次活动。
没有 @ 的消息同时投递给三位专家；有 @ 仅投递给指定专家。只按你自己的职责判断，不因为其他人未回答就包揽所有工作。
职责：材料专家负责原文、条款拆解和引用；需求理解专家负责意图、场景、交付边界和澄清；PBS专家负责产品、BOM、数量和PBS依据。日常问候和不明确的全局问题由需求理解专家答复。
claim：用户问题确实需要你回答/执行，scope只写你负责的部分；普通问答、解释、进度查询选discussion，明确要求整理/保存/修改成果才选main。pass：与你无关，保持安静。不要为了参与而重复别人的职责。多人认领后可依据实际成果衔接，不互相假装已经完成。
review：仅当本条用户原话明确、无条件同意/拒绝 review_request，且 data.reviewId 正确关联时使用。quote 必须是去掉 @ 后的整条用户原话；否定、问句、条件同意、带修改的消息不能批准。部分确认必须原样使用用户明确说出的编号，不补全其他编号。用户只说继续、问为什么或纠正时按实际职责claim。其他角色已经记录同一review时pass即可。
收件结果只用工具记录，不向用户输出思考过程，不调用其他协作工具，不修改成果。`;
  const common = `你是${ROLES[a.role].label}。身份、项目和权限由宿主固定。先调用collaboration_state和project_state。
本次上下文版本：${t.revision}。任务目标：${t.goal}
只展示简短业务交流；默认最终答复2～3句、120字以内，明细在右侧工作区。不得伪造其他专家说话，不输出内部推理。
咨询答复必须submit_expert_answer，人工补充必须read_interventions并acknowledge_intervention。工具返回waiting时结束本次活动，宿主收到答复后恢复，不轮询、不自行声称收到答案。
${stageGoal[a.role]}`;
  if (a.mode === "consultation") {
    const c = store.consultations(t.id).find((c) => c.id === a.input.consultation_id);
    return `${common}\n本次仅为只读专家咨询。咨询编号：${c.id}；发问者：${ROLES[c.caller].label}。问题（业务数据）：${c.question}\n提交关联此编号的答复；不能修改业务成果。${a.input.continuation ? "你咨询的材料专家已经答复，请读取collaboration_state继续解答原问题。" : ""}`;
  }
  if (a.mode === "intervention") return `${common}\n优先处理用户消息 ${a.input.intervention_ids.join(",")}。先read_interventions，按消息data.scope处理你实际认领的部分，data.peers是其他认领者的范围，不重复包揽。${a.input.work_mode === "discussion" ? "本次只回答实际问题或提出变更建议，不重新生成成果。" : "本次执行用户明确要求的工作。"}已确认范围变化先propose_change并用operation_ids关联卡片；不可仅说会调整。普通问答或不改变范围的工作指示用read_only；确实无法判断用needs_clarification。新材料：${(a.input.materialIds ?? []).map((id) => `material:${id}`).join(",") || "无新增附件"}。${a.input.continuation ? "已有咨询答复，请读取并继续处理用户消息。" : ""}`;
  if (a.mode === "discussion") return `${common}\n本次是用户问答或修改建议。只回答用户实际问题，或用propose_change提供可审阅变更；不要自行重新生成需求、场景或PBS，也不要声称完成了本轮理解。需要时可向获授权的专家求证。`;
  return `${common}\n${a.input.continuation ? "你提出的咨询已有新答复，读取collaboration_state核对并记录处理结果；可继续追问。" : a.input.goal ?? "继续已保存任务"}`;
}

function queueReplies(t) {
  for (const c of store.consultations(t.id).filter((c) => c.state === "answered" && !c.data.resumed)) {
    const original = getDb().prepare("SELECT * FROM collaboration_activations WHERE id=?").get(c.activation_id);
    if (!original || original.state === "running") continue;
    const input = parse(original.input, {});
    if (!getDb().prepare("SELECT 1 FROM collaboration_activations WHERE task_id=? AND state='queued' AND json_extract(input,'$.resume_from')=?").get(t.id, original.id))
      store.enqueue(t, original.role, original.mode, { ...input, continuation: true, reply_to: c.id, resume_from: original.id });
    getDb().prepare("UPDATE collaboration_consultations SET data=? WHERE id=?").run(json({ ...c.data, resumed: true }), c.id);
  }
}

/** Durable activations, not a second model loop. Each activation runs the official dsh loop. */
export async function runCollaboration(taskId, ctx = {}) {
  let t = store.task(taskId);
  store.updateTask(taskId, { status: "running", job_id: ctx.jobId ?? null, error: null });
  const countStart = getDb().prepare("SELECT SUM(attempts) AS n FROM collaboration_activations WHERE task_id=?").get(taskId).n ?? 0;
  const previousUsage = getDb().prepare("SELECT COALESCE(SUM(json_extract(stats,'$.tokens')),0) AS tokens FROM agent_runs WHERE json_extract(stats,'$.taskId')=?").get(taskId).tokens;
  let taskTokens = previousUsage;
  const startedAt = Date.now();
  let activations = 0;
  try {
    for (;;) {
      t = store.task(taskId);
      if (ctx.signal?.aborted || ["pausing", "paused"].includes(t.status)) {
        store.updateTask(taskId, { status: "paused" });
        return { taskId, status: "paused" };
      }
      if (++activations > 36 || countStart + activations > 90) throw new Error("本轮协作已达处理预算，请复核已有成果后继续");
      if (Date.now() - startedAt > 30 * 60 * 1000 || taskTokens >= Number(process.env.APP_COLLABORATION_MAX_TOKENS || 3000000)) throw new Error("协作已达到共同时间或用量预算，已保存成果可复核");
      queueReplies(t);
      for (const m of conversation.pendingMessages(taskId)) {
        if (!m.targets.every(role => conversation.claims(m.id).some(c => c.role === role))) continue;
        tx(() => { applyMessageReview(t, m); conversation.dispatchClaims(store.task(taskId), m); });
      }
      t = store.task(taskId);
      conversation.queueClaims(t);
      const pending = store.pendingInputs(taskId);
      const waitingInputs = new Set(store.consultations(taskId).filter((c) => c.state === "waiting").flatMap((c) => {
        const a = getDb().prepare("SELECT mode,input FROM collaboration_activations WHERE id=?").get(c.activation_id);
        return a?.mode === "intervention" ? parse(a.input, {}).intervention_ids ?? [] : [];
      }));
      const unassigned = pending.filter((i) => !waitingInputs.has(i.id));
      if (!conversation.pendingMessages(taskId).length && unassigned.length && !getDb().prepare("SELECT 1 FROM collaboration_activations WHERE task_id=? AND mode='intervention' AND state='queued'").get(taskId)) {
        const first = unassigned[0];
        const mine = unassigned.filter((i) => i.target === first.target && i.data.work_mode === first.data.work_mode);
        store.enqueue(t, first.target, "intervention", { intervention_ids: mine.map((i) => i.id), materialIds: mine.map((i) => i.data.materialId).filter(Boolean), work_mode: first.data.work_mode });
      }
      let a = store.nextActivation(taskId);
      if (!a) break;
      if (a.mode === "claim" && conversation.claims(a.input.message_id).some(c => c.role === a.role)) {
        getDb().prepare("UPDATE collaboration_activations SET state='done' WHERE id=?").run(a.id);
        continue;
      }
      if (a.mode === "consultation") {
        const c = store.consultations(taskId).find((c) => c.id === a.input.consultation_id);
        if (!c || c.state !== "waiting") { getDb().prepare("UPDATE collaboration_activations SET state='cancelled' WHERE id=?").run(a.id); continue; }
        if (c.revision !== t.revision || c.input_version !== understandingVersion(t.project_id)) {
          getDb().prepare("UPDATE collaboration_consultations SET state='stale' WHERE id=?").run(c.id);
          getDb().prepare("UPDATE collaboration_activations SET state='cancelled' WHERE id=?").run(a.id);
          const caller = getDb().prepare("SELECT * FROM collaboration_activations WHERE id=?").get(c.activation_id);
          if (caller) store.enqueue(t, caller.role, caller.mode, { ...parse(caller.input, {}), continuation: true, stale_consultation: c.id });
          store.event(t, "stale_consultation", "system", c.caller, "这段咨询的依据已变化，请按当前成果重新核对。", { consultationId: c.id });
          continue;
        }
      }
      if (a.role === "pbs" && a.mode === "main") {
        try { assertApproval(t); } catch {
          store.updateTask(taskId, { stage: "understanding", status: "awaiting_confirmation" });
          offerUnderstanding(t);
          return { taskId, status: "awaiting_confirmation" };
        }
      }
      store.updateTask(taskId, { status: pending.length ? "syncing" : "running" });
      const controller = new AbortController();
      const abort = () => controller.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener("abort", abort, { once: true });
      running.set(taskId, { controller, activationId: a.id });
      getDb().prepare("UPDATE collaboration_activations SET state='running',attempts=attempts+1 WHERE id=?").run(a.id);
      const adapter = collaborationAdapter(t, a, { signal: controller.signal, onProgress: (name) => ctx.progress?.detail(name.startsWith("submit_") ? "核对并保存成果" : "核对资料与协作答复") });
      ctx.progress?.setSteps([`${ROLES[a.role].label}正在处理`]); ctx.progress?.step(0);
      const runId = store.uid();
      getDb().prepare("INSERT INTO agent_runs(id,project_id,goal,status,created_at) VALUES (?,?,?,'running',?)").run(runId, t.project_id, `${a.role}/${a.mode}: ${t.goal}`, now());
      if (a.mode !== "claim") store.event(t, "activity", a.role, "human", a.mode === "consultation" ? "正在回查依据，准备答复。" : a.mode === "intervention" ? "这部分由我处理，我先核对相关信息。" : a.mode === "discussion" ? "正在查看项目，准备答复。" : "开始处理本轮任务。", { status: "processing", consultationId: a.input.consultation_id });
      let result, budgetError, runTokens = 0;
      const toolTrace = [];
      const saveStats = () => getDb().prepare("UPDATE agent_runs SET stats=? WHERE id=?").run(json({ taskId, role: a.role, tokens: runTokens, tools: toolTrace }), runId);
      try {
        result = await runRole({ projectId: t.project_id, role: a.role, goal: prompt(t, a), tools: adapter.tools, execute: adapter.execute, signal: controller.signal,
          sessionId: store.sessionId(t.project_id, a.role), onSession: (id) => { store.saveSession(t.project_id, a.role, id); getDb().prepare("UPDATE agent_runs SET session_id=? WHERE id=?").run(id, runId); },
          onTool: (call) => { toolTrace.push({ name: call.name, ok: call.ok, error: call.result?.error?.message, errors: call.result?.data?.errors?.length ?? 0 }); saveStats(); },
          onUsage: (usage) => {
            runTokens += usage.promptTokens + usage.completionTokens;
            taskTokens += usage.promptTokens + usage.completionTokens;
            saveStats();
            ctx.onCall?.({ ...usage, step: `expert:${a.role}`, cached: false, ms: 0, ok: true });
            if (taskTokens >= Number(process.env.APP_COLLABORATION_MAX_TOKENS || 3000000) || Date.now() - startedAt > 30 * 60 * 1000) {
              budgetError = new Error("协作已达到共同预算，已保存成果和咨询保留"); controller.abort(budgetError);
            }
          } });
        controller.signal.throwIfAborted();
        getDb().prepare("UPDATE collaboration_activations SET state='done' WHERE id=?").run(a.id);
        getDb().prepare("UPDATE agent_runs SET status='needs_review',result=?,finished_at=? WHERE id=?").run(json({ role: a.role, activationId: a.id, taskId, reply: result.finalResponse }), now(), runId);
      } catch (error) {
        const supersededInput = a.mode === "intervention" && store.task(taskId).revision !== t.revision;
        getDb().prepare("UPDATE collaboration_activations SET state=? WHERE id=?").run(supersededInput ? "cancelled" : "queued", a.id);
        getDb().prepare("UPDATE agent_runs SET status=?,error=?,finished_at=? WHERE id=?").run(controller.signal.aborted ? "interrupted" : "failed", String(error.message).slice(0, 600), now(), runId);
        if (budgetError || error.code === "RUNTIME_CLEANUP_FAILED") throw budgetError ?? error;
        if (controller.signal.aborted) continue;
        throw error;
      } finally {
        // runRole resolves only after closing the old runtime and draining its MCP tools.
        ctx.signal?.removeEventListener("abort", abort);
        running.delete(taskId);
      }
      t = store.task(taskId);
      const mine = store.consultations(taskId);
      if (a.mode === "claim") {
        if (!conversation.claims(a.input.message_id).some(c => c.role === a.role)) {
          getDb().prepare("UPDATE collaboration_activations SET state='queued' WHERE id=?").run(a.id);
          throw new Error(`${ROLES[a.role].label}尚未完成消息认领，消息已保留，可继续处理`);
        }
      } else if (a.mode === "consultation") {
        const c = mine.find((c) => c.id === a.input.consultation_id);
        if (c.state !== "answered" && !mine.some((q) => q.activation_id === a.id && q.state === "waiting")) {
          getDb().prepare("UPDATE collaboration_activations SET state='queued' WHERE id=?").run(a.id);
          throw new Error(`${ROLES[a.role].label}尚未提交对应咨询答复，可继续处理`);
        }
      } else if (a.mode === "intervention") {
        if (store.pendingInputs(taskId).some((i) => a.input.intervention_ids.includes(i.id))) {
          if (mine.some((c) => c.activation_id === a.id && c.state === "waiting")) continue;
          getDb().prepare("UPDATE collaboration_activations SET state='queued' WHERE id=?").run(a.id);
          throw new Error("人工补充尚未给出明确处理结果，已暂缓后续写入，可继续处理");
        }
        if (a.input.work_mode === "main") {
          let stage = "understanding";
          if (a.role === "pbs") { try { assertApproval(store.task(taskId)); stage = "pbs"; } catch { /* Ask about the current scope below. */ } }
          store.updateTask(taskId, { stage });
        }
        if (a.input.materialIds?.length && !a.input.work_mode) store.enqueue(t, "understanding", "main", { goal: "根据补充材料重新核对需求理解", flow: "single" });
        if (!conversation.inbox(taskId).length && !store.pendingInputs(taskId).length && store.interventions(taskId).some((i) => i.revision <= t.revision && ["requires_confirmation", "needs_clarification"].includes(i.result?.outcome))) {
          store.updateTask(taskId, { status: "awaiting_confirmation" });
          return { taskId, status: "awaiting_confirmation" };
        }
      } else {
        if (result.finalResponse?.trim()) store.event(t, "summary", a.role, "human", result.finalResponse.trim(), { open: { tab: a.role === "pbs" ? "pbs" : "understanding" } });
        const awaiting = mine.some((c) => c.caller === a.role && c.state === "waiting");
        if (!awaiting && a.role === "materials" && a.input.flow === "analyze") {
          store.updateTask(taskId, { stage: "understanding" });
          const report = adapter.report();
          store.event(t, "handoff", "materials", "understanding", "已交接当前保存的需求与原文依据，请组织客户场景并核对疑点。", { coverage: report.documents.map(({ title, total_sections, remaining }) => ({ title, total_sections, remaining })), open: { tab: "understanding" } });
          store.enqueue(t, "understanding", "main", { goal: stageGoal.understanding });
        }
      }
    }
    t = store.task(taskId);
    const waiting = store.consultations(taskId).some((c) => c.state === "waiting");
    if (waiting) throw new Error("仍有未答复咨询，已保留记录，请继续处理");
    const status = t.stage === "discussion" ? "done" : t.stage === "pbs" ? "awaiting_review" : "awaiting_confirmation";
    store.updateTask(taskId, { status });
    if (status === "awaiting_confirmation") offerUnderstanding(t);
    return { taskId, status };
  } catch (error) {
    store.updateTask(taskId, { status: "failed", error: error.message.slice(0, 600) });
    store.event(t, "failure", "system", "human", "本轮协作未完成，已保存成果和交流保留，可继续处理。", { error: true, detail: error.message.slice(0, 600), resumable: true });
    throw error;
  }
}
