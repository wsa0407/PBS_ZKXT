import { getDb, json, now, parse } from "./db.mjs";
import * as store from "./collaboration-store.mjs";
import { ROLES } from "../../agents/pbs/roles.mjs";
import { hash } from "../engine/scenario.mjs";

const decode = r => r && ({ ...r, data: parse(r.data, {}), targets: parse(r.targets, []) });
export const message = id => decode(getDb().prepare("SELECT * FROM conversation_messages WHERE id=?").get(id));
export const inbox = taskId => getDb().prepare("SELECT * FROM conversation_messages WHERE task_id=? ORDER BY rowid").all(taskId).map(decode);
export const pendingMessages = taskId => inbox(taskId).filter(m => m.state === "pending");
export const claims = id => getDb().prepare("SELECT * FROM conversation_claims WHERE message_id=? ORDER BY rowid").all(id).map(r => ({ ...r, data: parse(r.data, {}) }));
export function saveMessage(t, { id, content, targets = [], data = {} }) {
  const recipients = targets.length ? [...new Set(targets)] : Object.keys(ROLES);
  data = { ...data, addressed: targets.length > 0 };
  getDb().prepare("INSERT INTO conversation_messages(id,task_id,project_id,content,targets,data,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, t.id, t.project_id, content, json(recipients), json(data), now());
  store.event(t, "message", "human", targets.length === 1 ? targets[0] : "all", content, { messageId: id, recipients, status: "received", ...(data.attachment ? { attachment: data.attachment } : {}) });
  return message(id);
}
export function recordClaim(id, role, args) {
  const old = claims(id).find(c => c.role === role);
  if (old) {
    if (json(old.data) !== json(args)) throw new Error("该消息已有认领结果，请使用已记录结果");
    return;
  }
  getDb().prepare("INSERT INTO conversation_claims(message_id,role,decision,data) VALUES (?,?,?,?)").run(id, role, args.decision, json(args));
}
export function queueClaims(t) {
  for (const m of pendingMessages(t.id)) for (const role of m.targets) {
    if (claims(m.id).some(c => c.role === role)) continue;
    if (!getDb().prepare("SELECT 1 FROM collaboration_activations WHERE task_id=? AND role=? AND mode='claim' AND state IN ('queued','running') AND json_extract(input,'$.message_id')=?").get(t.id, role, m.id))
      store.enqueue(t, role, "claim", { message_id: m.id });
  }
}
export function dispatchClaims(t, m) {
  const all = claims(m.id);
  if (!m.targets.every(role => all.some(c => c.role === role))) return false;
  const owners = all.filter(c => c.decision === "claim");
  for (const c of owners) {
    const id = hash({ messageId: m.id, role: c.role });
    getDb().prepare("INSERT OR IGNORE INTO collaboration_interventions(id,task_id,project_id,target,content,data,revision,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, t.id, t.project_id, c.role, m.content, json({ ...m.data, messageId: m.id, work_mode: c.data.work_mode, scope: c.data.scope,
        peers: owners.filter(p => p.role !== c.role).map(p => ({ role: p.role, scope: p.data.scope })) }), t.revision, now());
  }
  getDb().prepare("UPDATE conversation_messages SET state='dispatched' WHERE id=?").run(m.id);
  if (!owners.length && !all.some(c => c.decision === "review"))
    store.event(t, "clarification", m.targets.includes("understanding") ? "understanding" : m.targets[0], "human", "这条消息的处理目标还不明确。请直接说希望核对什么，或 @ 对应专家补充说明。", {});
  return true;
}
