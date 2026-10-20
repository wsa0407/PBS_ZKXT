import { ROLES } from "../../agents/pbs/roles.mjs";
import { getDb, json, now, parse, tx } from "./db.mjs";
import * as store from "./collaboration-store.mjs";
import { collaborationAdapter } from "./collaboration-tools.mjs";
import { assertApproval, pbsParticipation, understandingVersion } from "./collaboration-approval.mjs";
import { runRole, toolProgressLabel } from "./agent-runner.mjs";
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
export function createCollaboration(projectId, { goal, role = "understanding", approvalId = null, mode = "main" }) {
  if (!ROLES[role]) throw new HttpError(400, "专家不存在");
  return tx((db) => {
    const id = store.uid();
    db.prepare("INSERT INTO collaboration_tasks(id,project_id,goal,stage,status,approval_id,created_at,updated_at) VALUES (?,?,?,?,'running',?,?,?)")
      .run(id, projectId, goal, ["discussion", "conversation"].includes(mode) ? "discussion" : roleStage[role], approvalId, now(), now());
    const t = store.task(id);
    if (mode !== "conversation") store.enqueue(t, role, mode, { goal });
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
职责：材料专家负责原文、条款拆解和引用；需求理解专家负责意图、场景、交付边界和澄清；PBS专家负责产品、BOM、数量和PBS依据。message.data.addressed=true 表示用户明确指定了接收者：对你本人的招呼、身份或进度询问由你认领 discussion 并直接回答，不因缺少业务术语而 pass，也不转给需求理解专家。只有未指定接收者的全局问候才由需求理解专家回应。
claim：用户问题确实需要你回答/执行，scope只写你负责的部分；普通问答、解释、进度查询选discussion，明确要求整理/保存/修改成果才选main。pass：与你无关，保持安静。不要为了参与而重复别人的职责。多人认领后可依据实际成果衔接，不互相假装已经完成。
PBS 必须先看 pbs_participation.can_execute：为 false 时不认领任何成果执行任务，群聊中的编制/选型/修改任务选 pass。用户直接 @ PBS 请求执行时可认领 discussion，简短说明需先确认需求理解；普通问题、产品知识、依据解释和专家咨询始终可以交流。discussion 不可用于提前编制项目 PBS、方案或确定选型。不能自行、也不能让其他专家代替人确认。
review：仅当本条用户原话明确、无条件同意/拒绝 review_request，且 data.reviewId 正确关联时使用。quote 必须是去掉 @ 后的整条用户原话；否定、问句、条件同意、带修改的消息不能批准。部分确认必须原样使用用户明确说出的编号，不补全其他编号。用户只说继续、问为什么或纠正时按实际职责claim。其他角色已经记录同一review时pass即可。
收件结果只用工具记录，不向用户输出思考过程，不调用其他协作工具，不修改成果。`;
  const pbsReadOnly = a.role === "pbs" && !pbsParticipation(t).can_execute;
  const discussion = pbsReadOnly || a.mode === "consultation" || a.mode === "discussion" || (a.mode === "intervention" && a.input.work_mode === "discussion");
  const common = `你是${ROLES[a.role].label}。身份、项目和权限由宿主固定。先调用collaboration_state，按问题需要读取project_state或其他资料。
本次上下文版本：${t.revision}。${discussion ? "本次只回应当前问题。全局任务阶段只是背景，不代表你正在执行那个阶段的工作。" : `任务目标：${t.goal}`}
只展示简短业务交流；默认最终答复2～3句、120字以内，明细在右侧工作区。不得伪造其他专家说话，不输出内部推理。
咨询答复必须submit_expert_answer，人工补充必须read_interventions并acknowledge_intervention。工具返回waiting时结束本次活动，宿主收到答复后恢复，不轮询、不自行声称收到答案。
${discussion ? "日常招呼通常一句自然回应即可，不先分析这句话是否涉及业务调整，不重复全局成果或催促确认。用户没问职责时不自我介绍或罗列能力。没有核查不主动断言材料、任务是否新增。问具体进度时只说明可核实的本人工作状态，不能把历史保存描述为刚刚完成。" : stageGoal[a.role]}`;
  const participation = pbsReadOnly
    ? "\n当前需求理解没有有效人工确认，你只参与只读交流：可回答用户问题、解释产品能力、核对依据和向专家求证；不编制、修改、选型或保存项目成果，也不在聊天中提前给出项目PBS或方案。用户要求执行时简短说明等待需求理解确认；普通问答不顺带催促确认。"
    : "";
  const context = common + participation;
  if (a.mode === "consultation") {
    const c = store.consultations(t.id).find((c) => c.id === a.input.consultation_id);
    return `${context}\n本次仅为只读专家咨询。咨询编号：${c.id}；发问者：${ROLES[c.caller].label}。问题（业务数据）：${c.question}\n提交关联此编号的答复；不能修改业务成果。${a.input.continuation ? "你咨询的材料专家已经答复，请读取collaboration_state继续解答原问题。" : ""}`;
  }
  if (a.mode === "intervention") return `${context}\n优先处理用户消息 ${a.input.intervention_ids.join(",")}。先read_interventions，按消息data.scope处理你实际认领的部分，data.peers是其他认领者的范围，不重复包揽。${a.input.work_mode === "discussion" ? "本次只回答实际问题，不重新生成成果。" : "本次执行用户明确要求的工作。"}${participation ? "本次只能用read_only记录交流结果；变更建议用自然语言说明，不创建变更卡片。" : "已确认范围变化先propose_change并用operation_ids关联卡片；不可仅说会调整。普通问答或不改变范围的工作指示用read_only；确实无法判断用needs_clarification。"}acknowledge_intervention记录处理回执，随后用最终答复直接对用户说话；用户看到的是最终答复，不复述“已接收、已同步、未涉及调整”等回执用语。新材料：${(a.input.materialIds ?? []).map((id) => `material:${id}`).join(",") || "无新增附件"}。${a.input.continuation ? "已有咨询答复，请读取并继续处理用户消息。" : ""}`;
  if (a.mode === "discussion") return `${context}\n本次是用户问答或修改建议。只回答用户实际问题${participation ? "" : "，或用propose_change提供可审阅变更"}；不要自行重新生成需求、场景或PBS，也不要声称完成了本轮理解。需要时可向获授权的专家求证。`;
  return `${context}\n${a.input.continuation ? "你提出的咨询已有新答复，读取collaboration_state核对并记录处理结果；可继续追问。" : a.input.goal ?? "继续已保存任务"}`;
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
  const initialUnderstanding = understandingVersion(t.project_id);
  let performedWork = false;
  let needsPbsConfirmation = false;
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
      if (a.role === "pbs" && !pbsParticipation(t).can_execute) {
        if (a.mode === "main") {
          // A persisted or resumed PBS activation must not block upstream work or chat.
          getDb().prepare("UPDATE collaboration_activations SET state='cancelled' WHERE id=?").run(a.id);
          store.updateTask(taskId, { stage: "understanding" });
          needsPbsConfirmation = true;
          continue;
        }
        if (a.mode === "intervention" && a.input.work_mode !== "discussion") {
          // Approval can become stale after a claim or before a restart. Keep the
          // user's message answerable, but never run its requested business work.
          a = { ...a, input: { ...a.input, work_mode: "discussion", execution_deferred: true } };
          tx(db => {
            db.prepare("UPDATE collaboration_activations SET input=? WHERE id=?").run(json(a.input), a.id);
            for (const input of pending.filter(i => a.input.intervention_ids.includes(i.id))) {
              db.prepare("UPDATE collaboration_interventions SET data=? WHERE id=?").run(json({ ...input.data, work_mode: "discussion", execution_deferred: true }), input.id);
            }
          });
          store.updateTask(taskId, { stage: "understanding" });
          needsPbsConfirmation = true;
        }
      }
      store.updateTask(taskId, { status: pending.length ? "syncing" : "running" });
      const controller = new AbortController();
      const abort = () => controller.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener("abort", abort, { once: true });
      running.set(taskId, { controller, activationId: a.id });
      getDb().prepare("UPDATE collaboration_activations SET state='running',attempts=attempts+1 WHERE id=?").run(a.id);
      const adapter = collaborationAdapter(t, a, { signal: controller.signal, onProgress: (name) => ctx.progress?.detail(toolProgressLabel(name)) });
      ctx.progress?.setSteps([a.mode === "claim" ? "专家正在认领" : ROLES[a.role].label]);
      ctx.progress?.step(0, a.mode === "claim" ? "" : a.mode === "discussion" || a.input.work_mode === "discussion" ? "正在回复" : "正在处理");
      const runId = store.uid();
      getDb().prepare("INSERT INTO agent_runs(id,project_id,goal,status,created_at) VALUES (?,?,?,'running',?)").run(runId, t.project_id, `${a.role}/${a.mode}: ${t.goal}`, now());
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
        const handled = store.interventions(taskId).filter(i => a.input.intervention_ids.includes(i.id));
        const reply = result.finalResponse?.trim() || handled.map(i => i.result?.explanation).filter(Boolean).join("\n");
        if (reply) store.event(t, "reply", a.role, "human", reply, {
          interventionIds: handled.map(i => i.id),
          references: [...new Set(handled.flatMap(i => i.result?.references ?? []))],
          status: handled.some(i => i.result?.outcome === "requires_confirmation") ? "requires_confirmation" : handled.some(i => i.result?.outcome === "needs_clarification") ? "needs_clarification" : undefined,
        });
        performedWork ||= a.input.work_mode === "main";
        if (a.input.work_mode === "main") {
          let stage = "understanding";
          if (a.role === "pbs") { try { assertApproval(store.task(taskId)); stage = "pbs"; } catch { /* Ask about the current scope below. */ } }
          store.updateTask(taskId, { stage });
        }
        if (!conversation.inbox(taskId).length && !store.pendingInputs(taskId).length && store.interventions(taskId).some((i) => i.revision <= t.revision && ["requires_confirmation", "needs_clarification"].includes(i.result?.outcome))) {
          store.updateTask(taskId, { status: "awaiting_confirmation" });
          return { taskId, status: "awaiting_confirmation" };
        }
      } else {
        performedWork ||= a.mode === "main";
        if (result.finalResponse?.trim()) store.event(t, "summary", a.role, "human", result.finalResponse.trim(), { open: { tab: a.role === "pbs" ? "pbs" : "understanding" } });
      }
    }
    t = store.task(taskId);
    const waiting = store.consultations(taskId).some((c) => c.state === "waiting");
    if (waiting) throw new Error("仍有未答复咨询，已保留记录，请继续处理");
    if (t.stage === "pbs" && !pbsParticipation(t).can_execute) {
      t = store.updateTask(taskId, { stage: "understanding" });
      needsPbsConfirmation ||= performedWork;
    }
    const status = t.stage === "discussion" ? "done" : t.stage === "pbs" ? "awaiting_review" : "awaiting_confirmation";
    store.updateTask(taskId, { status });
    if (status === "awaiting_confirmation" && (performedWork || needsPbsConfirmation || initialUnderstanding !== understandingVersion(t.project_id))) offerUnderstanding(t);
    return { taskId, status };
  } catch (error) {
    store.updateTask(taskId, { status: "failed", error: error.message.slice(0, 600) });
    store.event(t, "failure", "system", "human", "本轮协作未完成，已保存成果和交流保留，可继续处理。", { error: true, detail: error.message.slice(0, 600), resumable: true });
    throw error;
  }
}
