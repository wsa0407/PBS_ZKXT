import { ROLES } from "../../agents/pbs/roles.mjs";
import { hash } from "../engine/scenario.mjs";
import { getDb, json, parse, tx } from "./db.mjs";
import * as repo from "./repo.mjs";
import * as svc from "./services.mjs";
import * as store from "./collaboration-store.mjs";
import { approveUnderstanding, assertApproval, approvalPreview } from "./collaboration-approval.mjs";
import { createCollaboration, pauseCollaboration, receiveMessage, runCollaboration } from "./collaboration.mjs";
import { activeJob, startJob } from "./jobs.mjs";
import { HttpError } from "./errors.mjs";
import { parseMentions } from "../shared/mentions.mjs";
import { latestReview, offerUnderstanding, ensureChangeReviews } from "./conversation-review.mjs";
import * as conversation from "./conversation-store.mjs";

function launch(t) {
  const job = startJob({ projectId: t.project_id, kind: "collaboration", steps: ["专家协作"], run: (ctx) => runCollaboration(t.id, ctx) });
  store.updateTask(t.id, { job_id: job.id });
  return { taskId: t.id, jobId: job.id };
}
export function collaborationView(projectId) {
  const t = store.latestTask(projectId);
  if (t) ensureChangeReviews(t);
  // Upgrade an awaiting pre-conversation task to an explicit, versioned chat request.
  if (t?.status === "awaiting_confirmation" && !getDb().prepare("SELECT 1 FROM conversation_reviews WHERE project_id=?").get(projectId)) offerUnderstanding(t);
  return { task: t, consultations: t ? store.consultations(t.id) : [], interventions: t ? store.interventions(t.id) : [],
    seq: getDb().prepare("SELECT MAX(seq) AS seq FROM collaboration_events WHERE project_id=?").get(projectId).seq ?? 0,
    review: latestReview(projectId), inbox: t ? conversation.inbox(t.id).map(m => ({ id: m.id, state: m.state, recipients: m.targets, claims: conversation.claims(m.id).map(c => ({ role: c.role, decision: c.decision, scope: c.data.scope })) })) : [],
    roles: Object.fromEntries(Object.entries(ROLES).map(([id, role]) => [id, role.label])) };
}
export function submitCollaboration(projectId, body) {
  repo.getProject(projectId);
  // Old generation buttons may submit one intent, never an executable action batch.
  const legacyIntents = { analyze: "理解客户材料", generate_scenarios: "整理客户场景与待澄清事项", generate_capabilities: "根据客户场景归纳业务活动", generate_pbs: "编制PBS草稿", resume_agent: "继续处理" };
  if (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.length > 1 || body.actions.some(a => !a || !Object.hasOwn(legacyIntents, a.type)))) throw new HttpError(400, "旧版操作指令已停用，请直接在对话中说明需求，或在工作区编辑");
  const requestId = body.requestId ?? store.uid();
  if (typeof requestId !== "string" || requestId.length > 160) throw new HttpError(400, "消息编号无效");
  const key = `collaboration-request:${projectId}:${requestId}`, fingerprint = hash(body);
  const previous = parse(getDb().prepare("SELECT value FROM settings WHERE key=?").get(key)?.value, null);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new HttpError(409, "这条消息已发送；修改内容请作为新消息发送");
    return previous.result;
  }
  const latest = store.latestTask(projectId), job = activeJob(projectId);
  if (job && job.kind !== "collaboration") throw new HttpError(409, "正在处理已有任务，请完成后再启动专家协作");
  if (body.target && !ROLES[body.target]) throw new HttpError(400, "专家不存在");
  const text = String(body.text ?? body.label ?? "").trim();
  const mentions = parseMentions(text);
  if (mentions.unknown.length) throw new HttpError(400, "没有找到被 @ 的专家，请输入 @ 并从材料拆解、需求理解或 PBS 专家中选择");
  const action = body.actions?.[0]?.type ?? (/^(继续|继续处理|恢复任务)[。！! ]*$/.test(text) && ["paused", "failed"].includes(latest?.status) ? "resume_agent" : undefined);
  if (!text && !body.attachment && !action) throw new HttpError(400, "请输入内容");
  let result;
  tx(() => {
    const isMaterial = body.attachment || (!job && text.length > 400 && /(?:^|\n)(?:#{1,3}|第[一二三四五六七八九十\d]+章|\d+\.\d+[.、\s])/.test(text));
    let materialId;
    if (isMaterial) materialId = svc.addMaterial(projectId, { title: body.attachment?.name?.replace(/\.[^.]+$/, ""), fileName: body.attachment?.name, text: body.attachment?.text ?? text, description: body.attachment ? text : "" });
    const label = text || (body.attachment ? `上传了文件 ${body.attachment.name}` : legacyIntents[action]);
    const targets = mentions.targets.length ? mentions.targets : body.target ? [body.target] : [];
    if (action === "resume_agent" && latest && !job && !text) {
      result = launch(latest);
    } else {
      const reuse = latest && (job || ["paused", "pausing", "failed", "awaiting_confirmation"].includes(latest.status));
      let approvalId = latest?.approval_id ?? null;
      try { if (approvalId) assertApproval(latest); } catch { approvalId = null; }
      const t = reuse ? latest : createCollaboration(projectId, { goal: label, mode: "conversation", approvalId });
      const received = receiveMessage(t, { id: requestId, content: label, targets,
        data: { materialId, reviewId: body.reviewId, ...(body.attachment ? { attachment: { name: body.attachment.name } } : {}) } });
      result = { taskId: t.id, jobId: job?.id ?? null, messageId: received.id, received: true };
      if (!job && (!["paused", "pausing", "failed"].includes(t.status) || action === "resume_agent")) result = { ...result, ...launch(store.task(t.id)) };
    }
    getDb().prepare("INSERT INTO settings(key,value) VALUES (?,?)").run(key, json({ fingerprint, result }));
  });
  return result;
}
export function confirmAndStart(projectId, body) {
  const key = `collaboration-confirm:${projectId}:${body.requestId}`;
  const previous = parse(getDb().prepare("SELECT value FROM settings WHERE key=?").get(key)?.value, null);
  if (previous) {
    if (previous.fingerprint !== hash(body)) throw new HttpError(409, "确认请求已用于另一范围，请重新打开范围卡片");
    return previous.result;
  }
  if (activeJob(projectId)) throw new HttpError(409, "当前任务仍在处理，请完成后再确认本轮范围；补充或纠正可直接在对话中发送");
  if (!body.requestId || body.requestId.length > 160) throw new HttpError(400, "请携带确认请求编号");
  return tx(() => {
    const previousTask = store.latestTask(projectId);
    if (previousTask && (store.pendingInputs(previousTask.id).length || conversation.pendingMessages(previousTask.id).length)) throw new HttpError(409, "还有你的消息未处理，请先继续任务并核对处理结果");
    if (previousTask && getDb().prepare("SELECT payload FROM chat_messages WHERE project_id=? AND json_extract(payload,'$.taskId')=?").all(projectId, previousTask.id).some((m) => parse(m.payload, {}).cards?.some((c) => c.kind === "agent_change" && c.state === "pending"))) throw new HttpError(409, "请先采纳或不采纳聊天中的变更建议，再确认本轮范围");
    const confirmed = approveUnderstanding(projectId, body);
    getDb().prepare("UPDATE conversation_reviews SET state='superseded' WHERE project_id=? AND kind='understanding' AND state='pending'").run(projectId);
    const t = createCollaboration(projectId, { goal: "依据用户确认的本轮范围编制PBS草稿，按需向两位上游专家求证", role: "pbs", approvalId: confirmed.id });
    if (previousTask) {
      store.updateTask(previousTask.id, { status: "superseded" });
      getDb().prepare("UPDATE collaboration_activations SET state='cancelled' WHERE task_id=? AND state='queued'").run(previousTask.id);
    }
    store.event(t, "handoff", "human", "pbs", `本轮确认了 ${confirmed.snapshot.requirements.length} 条需求、${confirmed.snapshot.scenarios.length} 个场景，请据此编制PBS。`, { approvalId: confirmed.id, open: { tab: "understanding" } });
    const result = launch(t);
    getDb().prepare("INSERT INTO settings(key,value) VALUES (?,?)").run(key, json({ fingerprint: hash(body), result }));
    return result;
  });
}
export function pauseProject(projectId) {
  const t = store.latestTask(projectId);
  if (!t) throw new HttpError(404, "没有可暂停的协作任务");
  pauseCollaboration(t);
  return { paused: true };
}
export function resumeProject(projectId) {
  const t = store.latestTask(projectId);
  if (!t || !["paused", "failed"].includes(t.status)) throw new HttpError(409, "当前没有可继续的协作任务");
  if (activeJob(projectId)) throw new HttpError(409, "正在结束上一次运行，请稍后继续");
  store.event(t, "resume", "system", "human", "继续处理，先核对尚未处理的人工补充。", {});
  return launch(t);
}
export { approvalPreview };
