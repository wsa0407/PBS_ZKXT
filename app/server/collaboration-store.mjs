import { randomUUID } from "node:crypto";
import { getDb, json, now, parse, tx } from "./db.mjs";
import * as repo from "./repo.mjs";

export const uid = () => randomUUID();
export const task = (id) => getDb().prepare("SELECT * FROM collaboration_tasks WHERE id=?").get(id);
export const latestTask = (projectId) => getDb().prepare("SELECT * FROM collaboration_tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 1").get(projectId) ?? null;
export function updateTask(id, values) {
  const allowed = ["stage", "status", "revision", "approval_id", "job_id", "error"];
  const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
  getDb().prepare(`UPDATE collaboration_tasks SET ${entries.map(([k]) => `${k}=?`).join(",")},updated_at=? WHERE id=?`).run(...entries.map(([, v]) => v), now(), id);
  return task(id);
}
export function event(t, kind, sender, recipient, content, payload = {}) {
  return tx((db) => {
    const chatId = repo.addChat(t.project_id, sender === "human" ? "user" : "assistant", content, { ...payload, collaboration: true, kind, sender, recipient, taskId: t.id });
    const result = db.prepare("INSERT INTO collaboration_events(project_id,task_id,kind,sender,recipient,content,payload,chat_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(t.project_id, t.id, kind, sender, recipient ?? null, content, json(payload), chatId, now());
    return { seq: Number(result.lastInsertRowid), chatId };
  });
}
export function events(projectId, after = 0) {
  return getDb().prepare("SELECT * FROM collaboration_events WHERE project_id=? AND seq>? ORDER BY seq LIMIT 300").all(projectId, Number(after) || 0).map((r) => ({ ...r, payload: parse(r.payload, {}) }));
}
export function enqueue(t, role, mode, input) {
  const id = uid();
  getDb().prepare("INSERT INTO collaboration_activations(id,task_id,role,mode,input,created_at) VALUES (?,?,?,?,?,?)").run(id, t.id, role, mode, json(input), now());
  return id;
}
export function nextActivation(id) {
  const row = getDb().prepare("SELECT * FROM collaboration_activations WHERE task_id=? AND state='queued' ORDER BY CASE mode WHEN 'claim' THEN -1 WHEN 'intervention' THEN 0 WHEN 'consultation' THEN 1 ELSE 2 END,rowid LIMIT 1").get(id);
  return row ? { ...row, input: parse(row.input, {}) } : null;
}
export const consultations = (id) => getDb().prepare("SELECT * FROM collaboration_consultations WHERE task_id=? ORDER BY rowid").all(id).map((r) => ({ ...r, data: parse(r.data, {}), answer: parse(r.answer, null), outcome: parse(r.outcome, null) }));
export const interventions = (id) => getDb().prepare("SELECT * FROM collaboration_interventions WHERE task_id=? ORDER BY rowid").all(id).map((r) => ({ ...r, data: parse(r.data, {}), result: parse(r.result, null) }));
export const pendingInputs = (id) => interventions(id).filter((r) => ["received", "delivered"].includes(r.state));
export const sessionId = (projectId, role) => getDb().prepare("SELECT session_id FROM collaboration_sessions WHERE project_id=? AND role=?").get(projectId, role)?.session_id;
export const saveSession = (projectId, role, id) => getDb().prepare("INSERT OR REPLACE INTO collaboration_sessions(project_id,role,session_id) VALUES (?,?,?)").run(projectId, role, id);
export function recoverCollaboration() {
  // Never silently start paid work on boot. Resume the same sessions on explicit continue.
  getDb().prepare("UPDATE collaboration_activations SET state='queued' WHERE state='running'").run();
  getDb().prepare("UPDATE collaboration_tasks SET status='paused',error='服务重启，已保存交流与成果，可继续处理' WHERE status IN ('running','syncing','waiting_expert')").run();
}
