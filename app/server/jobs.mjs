import { randomUUID } from "node:crypto";
import { createHarnessLlm } from "./agent-runner.mjs";
import { getDb, json, now, parse } from "./db.mjs";
import { HttpError } from "./errors.mjs";
import { selectedModel } from "./models.mjs";

const active = new Map();
const cancellations = new Map();
let llmFactory = (options) => createHarnessLlm({ model: selectedModel(), ...options });

/** Tests swap in a scripted model. Production always uses the real one. */
export function setLlmFactory(factory) {
  llmFactory = factory;
}

function logCall(projectId, jobId, call) {
  getDb()
    .prepare(
      "INSERT INTO llm_calls (project_id, job_id, step, model, cached, ms, prompt_tokens, completion_tokens, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(projectId, jobId, call.step, call.model, call.cached ? 1 : 0, call.ms, call.promptTokens, call.completionTokens, call.ok ? 1 : 0, now());
}

function saveSteps(id, steps) {
  getDb().prepare("UPDATE jobs SET steps = ? WHERE id = ?").run(json(steps), id);
}

/**
 * Runs `run({ llm, progress })` in the background. One job at a time per project
 * (or per global kind, e.g. product manual parsing).
 */
export function startJob({ projectId = null, kind, steps, run, lock: lockKey }) {
  const lock = lockKey ?? projectId ?? `global:${kind}`;
  if (active.has(lock)) throw new HttpError(409, "已有任务正在处理，请等它完成");
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const controller = new AbortController();
  cancellations.set(id, controller);
  const state = steps.map((name) => ({ name, state: "pending", detail: "" }));
  getDb()
    .prepare("INSERT INTO jobs (id, project_id, kind, status, steps, created_at) VALUES (?, ?, ?, '处理中', ?, ?)")
    .run(id, projectId, kind, json(state), now());

  let current = -1;
  const progress = {
    /** Replace the step list (chat jobs only know their work after the intent is understood). */
    setSteps(names, doneCount = 0) {
      state.length = 0;
      names.forEach((name, i) => state.push({ name, state: i < doneCount ? "done" : "pending", detail: "" }));
      current = -1;
      saveSteps(id, state);
    },
    step(index, detail = "") {
      for (let i = 0; i < index; i += 1) if (state[i].state !== "done") state[i].state = "done";
      current = index;
      state[index] = { ...state[index], state: "running", detail };
      saveSteps(id, state);
    },
    detail(text) {
      if (current >= 0) state[current].detail = text;
      saveSteps(id, state);
    },
  };

  const onCall = (call) => logCall(projectId, id, call);
  const llm = llmFactory({ onCall, signal: controller.signal, projectId });
  active.set(lock, id);
  const promise = Promise.resolve()
    .then(() => run({ llm, progress, jobId: id, signal: controller.signal, onCall }))
    .then((result) => {
      controller.signal.throwIfAborted();
      state.forEach((s) => (s.state = "done"));
      getDb()
        .prepare("UPDATE jobs SET status = '已完成', steps = ?, result = ?, finished_at = ? WHERE id = ?")
        .run(json(state), json(result ?? null), now(), id);
      return result;
    })
    .catch((error) => {
      if (!controller.signal.aborted) console.error(`[job ${kind} ${id}]`, error);
      if (current >= 0) state[current].state = "failed";
      getDb()
        .prepare("UPDATE jobs SET status = ?, steps = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(controller.signal.aborted ? "已取消" : "失败", json(state), controller.signal.aborted ? "任务已停止，已保存的草稿保留" : String(error.message ?? error).slice(0, 600), now(), id);
    })
    .finally(() => { active.delete(lock); cancellations.delete(id); });
  return { id, promise };
}

export function getJob(id) {
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, steps: parse(row.steps, []), result: parse(row.result, null) };
}

export function activeJob(projectId) {
  const id = active.get(projectId);
  return id ? getJob(id) : null;
}

export function failInterruptedJobs() {
  getDb().prepare("UPDATE jobs SET status = '失败', error = '服务重启，任务中断，请重新执行', finished_at = ? WHERE status = '处理中'").run(now());
  getDb().prepare("UPDATE agent_runs SET status='interrupted',error='服务重启，可继续已保存会话与草稿',finished_at=? WHERE status='running'").run(now());
}

export function cancelJob(id) {
  const controller = cancellations.get(id);
  if (!controller) throw new HttpError(409, "任务已结束或不在当前服务中");
  controller.abort(new Error("用户停止任务"));
  return { stopping: true };
}

export function llmCalls(projectId) {
  return getDb().prepare("SELECT * FROM llm_calls WHERE project_id = ? ORDER BY id DESC").all(projectId);
}
