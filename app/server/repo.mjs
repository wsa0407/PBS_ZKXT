import { getDb, json, now, parse, tx } from "./db.mjs";
import { notFound } from "./errors.mjs";

// ---------- products ----------

export function rowToProduct(row) {
  return row && { ...row, capabilities: parse(row.capabilities, []), limits: parse(row.limits, []) };
}

export function listProducts() {
  return getDb().prepare("SELECT * FROM products ORDER BY id").all().map(rowToProduct);
}

export function getProduct(id) {
  return rowToProduct(getDb().prepare("SELECT * FROM products WHERE id = ?").get(id));
}

function nextProductId() {
  const ids = getDb().prepare("SELECT id FROM products").all().map((r) => Number(String(r.id).replace(/^P/, "")) || 0);
  return `P${String(Math.max(0, ...ids) + 1).padStart(2, "0")}`;
}

export function saveProduct(id, p) {
  const db = getDb();
  if (id) {
    if (!db.prepare("SELECT 1 FROM products WHERE id = ?").get(id)) throw notFound("产品");
    db.prepare("UPDATE products SET name = ?, summary = ?, capabilities = ?, limits = ?, xinchuang = ?, unit = ?, updated_at = ? WHERE id = ?").run(
      p.name,
      p.summary,
      json(p.capabilities),
      json(p.limits),
      p.xinchuang,
      p.unit,
      now(),
      id,
    );
    return getProduct(id);
  }
  const newId = nextProductId();
  db.prepare("INSERT INTO products (id, name, summary, capabilities, limits, xinchuang, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    newId,
    p.name,
    p.summary,
    json(p.capabilities),
    json(p.limits),
    p.xinchuang,
    p.unit,
    now(),
  );
  return getProduct(newId);
}

export function findProductByName(name) {
  return rowToProduct(getDb().prepare("SELECT * FROM products WHERE name = ?").get(name));
}

export function deleteProduct(id) {
  return getDb().prepare("DELETE FROM products WHERE id = ?").run(id).changes > 0;
}

// ---------- product manuals ----------

export function listDocs(productId) {
  const sql = productId ? "SELECT id, product_id, name, status, created_at, length(text) AS size FROM product_docs WHERE product_id = ? ORDER BY id DESC" : "SELECT id, product_id, name, status, created_at, length(text) AS size FROM product_docs ORDER BY id DESC";
  return productId ? getDb().prepare(sql).all(productId) : getDb().prepare(sql).all();
}

export function getDoc(id) {
  const row = getDb().prepare("SELECT * FROM product_docs WHERE id = ?").get(id);
  return row && { ...row, draft: parse(row.draft, null) };
}

export function createDoc({ productId, name, text }) {
  const r = getDb().prepare("INSERT INTO product_docs (product_id, name, text, status, created_at) VALUES (?, ?, ?, '解析中', ?)").run(productId ?? null, name, text, now());
  return Number(r.lastInsertRowid);
}

export function updateDoc(id, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  getDb()
    .prepare(`UPDATE product_docs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...Object.values(fields).map((v) => (v !== null && typeof v === "object" ? json(v) : v)), id);
}

export function deleteDoc(id) {
  return getDb().prepare("DELETE FROM product_docs WHERE id = ?").run(id).changes > 0;
}

// ---------- projects ----------

export function listProjects() {
  return getDb()
    .prepare(
      `SELECT p.*,
        (SELECT count(*) FROM materials m WHERE m.project_id = p.id) AS materials,
        (SELECT count(*) FROM requirements r WHERE r.project_id = p.id AND r.status != '已删除') AS requirements,
        (SELECT count(*) FROM requirements r WHERE r.project_id = p.id AND r.status = '已确认') AS confirmed,
        (SELECT count(*) FROM questions q WHERE q.project_id = p.id AND q.status IN ('待处理', '待答复')) AS open_questions,
        (SELECT count(*) FROM pbs_items i WHERE i.project_id = p.id) AS pbs_items
      FROM projects p ORDER BY p.updated_at DESC`,
    )
    .all()
    .map((p) => ({ ...p, pbs_meta: parse(p.pbs_meta, {}) }));
}

export function getProject(id) {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) throw notFound("项目");
  return { ...row, pbs_meta: parse(row.pbs_meta, {}), done: Boolean(row.done) };
}

export function createProject({ name, customer = "", industry = "" }) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  getDb().prepare("INSERT INTO projects (id, name, customer, industry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, customer, industry, now(), now());
  return getProject(id);
}

export function updateProject(id, fields) {
  const allowed = ["name", "customer", "industry", "done", "pbs_meta"];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return getProject(id);
  getDb()
    .prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => (k === "pbs_meta" ? json(fields[k]) : k === "done" ? (fields[k] ? 1 : 0) : fields[k])), now(), id);
  return getProject(id);
}

export function touchProject(id) {
  getDb().prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function deleteProject(id) {
  tx((db) => {
    for (const table of ["materials", "segments", "source_snapshots", "requirements", "param_overrides", "questions", "pbs_items", "capabilities", "scenarios", "scenario_requirements", "scenario_revisions", "requirement_dispositions", "scenario_runs", "events", "llm_calls", "chat_messages"]) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    }
    db.prepare("DELETE FROM jobs WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  });
}

export function logEvent(projectId, kind, message) {
  getDb().prepare("INSERT INTO events (project_id, at, kind, message) VALUES (?, ?, ?, ?)").run(projectId, now(), kind, message);
}

export function listEvents(projectId, limit = 200) {
  return getDb().prepare("SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit);
}

// ---------- chat ----------

const rowToChat = (r) => ({ ...r, payload: parse(r.payload, {}) });

export function addChat(projectId, role, content, payload = {}) {
  const r = getDb().prepare("INSERT INTO chat_messages (project_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(projectId, role, content, json(payload), now());
  return Number(r.lastInsertRowid);
}

export function listChat(projectId, limit = 200) {
  return getDb()
    .prepare("SELECT * FROM (SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
    .all(projectId, limit)
    .map(rowToChat);
}

export function getChat(projectId, id) {
  const row = getDb().prepare("SELECT * FROM chat_messages WHERE project_id = ? AND id = ?").get(projectId, id);
  if (!row) throw notFound("消息");
  return rowToChat(row);
}

export function updateChatPayload(projectId, id, payload) {
  getDb().prepare("UPDATE chat_messages SET payload = ? WHERE project_id = ? AND id = ?").run(json(payload), projectId, id);
}

export function clearChat(projectId) {
  getDb().prepare("DELETE FROM chat_messages WHERE project_id = ?").run(projectId);
}

// ---------- materials & segments ----------

export function listMaterials(projectId) {
  return getDb()
    .prepare(
      `SELECT m.id, m.no, m.kind, m.title, m.file_name, m.numbered, m.meta, m.extracted_at, m.created_at, length(m.text) AS size,
        (SELECT count(*) FROM segments s WHERE s.project_id = m.project_id AND s.material_id = m.id) AS segments
       FROM materials m WHERE m.project_id = ? ORDER BY m.no`,
    )
    .all(projectId)
    .map((m) => ({ ...m, meta: parse(m.meta, {}), numbered: Boolean(m.numbered) }));
}

export function getMaterial(projectId, id) {
  const row = getDb().prepare("SELECT * FROM materials WHERE project_id = ? AND id = ?").get(projectId, id);
  if (!row) throw notFound("材料");
  return { ...row, meta: parse(row.meta, {}), numbered: Boolean(row.numbered) };
}

export function addMaterial(projectId, { kind, title, fileName, text, doc }) {
  return tx((db) => {
    const currentNo = db.prepare("SELECT max(no) AS n FROM materials WHERE project_id = ?").get(projectId)?.n ?? 0;
    const historyNo = db.prepare("SELECT max(json_extract(data, '$.material_no')) AS n FROM source_snapshots WHERE project_id = ?").get(projectId)?.n ?? 0;
    const no = Math.max(currentNo, historyNo) + 1;
    const r = db
      .prepare("INSERT INTO materials (project_id, no, kind, title, file_name, text, numbered, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, no, kind, title, fileName ?? null, text, doc.numbered ? 1 : 0, json(doc.meta), now());
    const materialId = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO segments (project_id, uid, material_id, seg_id, chapter, text, star, triangle, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const snapshot = db.prepare("INSERT INTO source_snapshots(project_id, uid, data) VALUES (?, ?, ?)");
    doc.segments.forEach((s, i) => {
      const uid = `M${no}:${s.id}`;
      ins.run(projectId, uid, materialId, s.id, s.chapter ?? "", s.text, s.star ? 1 : 0, s.triangle ? 1 : 0, no * 100000 + i);
      snapshot.run(projectId, uid, json({ ...s, uid, seg_id: s.id, material_id: materialId, material_no: no, material_title: title, material_kind: kind }));
    });
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), projectId);
    return materialId;
  });
}

export function deleteMaterial(projectId, id) {
  tx((db) => {
    const uids = db.prepare("SELECT uid FROM segments WHERE project_id = ? AND material_id = ?").all(projectId, id).map((r) => r.uid);
    db.prepare("DELETE FROM segments WHERE project_id = ? AND material_id = ?").run(projectId, id);
    if (uids.length) {
      db.prepare(`UPDATE requirements SET quote_verified = 0, source_note = '来源材料已删除，请复核', revision = revision + 1 WHERE project_id = ? AND seg_uid IN (${uids.map(() => "?").join(",")})`).run(projectId, ...uids);
      db.prepare(`UPDATE source_snapshots SET active = 0 WHERE project_id = ? AND uid IN (${uids.map(() => "?").join(",")})`).run(projectId, ...uids);
    }
    db.prepare("DELETE FROM materials WHERE project_id = ? AND id = ?").run(projectId, id);
  });
}

export function markExtracted(materialId) {
  getDb().prepare("UPDATE materials SET extracted_at = ? WHERE id = ?").run(now(), materialId);
}

export function listSegments(projectId) {
  return getDb()
    .prepare("SELECT s.*, m.no AS material_no, m.title AS material_title, m.kind AS material_kind FROM segments s JOIN materials m ON m.id = s.material_id WHERE s.project_id = ? ORDER BY s.ord")
    .all(projectId)
    .map((s) => ({ ...s, star: Boolean(s.star), triangle: Boolean(s.triangle) }));
}

export function listSourceSnapshots(projectId) {
  return getDb().prepare("SELECT * FROM source_snapshots WHERE project_id = ? ORDER BY uid").all(projectId)
    .map((r) => ({ ...parse(r.data, {}), active: Boolean(r.active) }));
}

// ---------- requirements ----------

export function rowToReq(r) {
  return {
    ...r,
    quote_verified: Boolean(r.quote_verified),
    inferred: Boolean(r.inferred),
    star: Boolean(r.star),
    triangle: Boolean(r.triangle),
    edited: Boolean(r.edited),
    retired: Boolean(r.retired),
    answer_evidence: parse(r.answer_evidence, []),
    params: parse(r.params, []),
    rejected_params: parse(r.rejected_params, []),
  };
}

export function listRequirements(projectId, { includeDeleted = true } = {}) {
  const sql = `SELECT * FROM requirements WHERE project_id = ? ${includeDeleted ? "" : "AND status != '已删除'"} ORDER BY ord, code`;
  return getDb().prepare(sql).all(projectId).map(rowToReq);
}

export function getRequirement(projectId, code) {
  const row = getDb().prepare("SELECT * FROM requirements WHERE project_id = ? AND code = ?").get(projectId, code);
  if (!row) throw notFound("需求");
  return rowToReq(row);
}

export function nextReqCode(projectId) {
  const codes = getDb().prepare("SELECT code FROM requirements WHERE project_id = ?").all(projectId).map((r) => Number(r.code.slice(1)) || 0);
  return `R${String(Math.max(0, ...codes) + 1).padStart(3, "0")}`;
}

export function insertRequirement(projectId, r) {
  const code = r.code ?? nextReqCode(projectId);
  getDb()
    .prepare(
      `INSERT INTO requirements (project_id, code, seg_uid, text, quote, quote_verified, category, priority, inferred, star, triangle, params, rejected_params, status, origin, source_note, edited, ord)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      code,
      r.seg_uid ?? null,
      r.text,
      r.quote ?? "",
      r.quote_verified ? 1 : 0,
      r.category,
      r.priority,
      r.inferred ? 1 : 0,
      r.star ? 1 : 0,
      r.triangle ? 1 : 0,
      json(r.params ?? []),
      json(r.rejected_params ?? []),
      r.status ?? "待确认",
      r.origin ?? "系统",
      r.source_note ?? "",
      r.edited ? 1 : 0,
      r.ord ?? 1e12,
    );
  return code;
}

export function updateRequirement(projectId, code, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const val = (k) => {
    const v = fields[k];
    if (["params", "rejected_params", "answer_evidence"].includes(k)) return json(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  };
  getDb()
    .prepare(`UPDATE requirements SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE project_id = ? AND code = ?`)
    .run(...keys.map(val), projectId, code);
}

export function deleteRequirement(projectId, code) {
  // Keep historical references and never reuse requirement IDs.
  getDb().prepare("UPDATE requirements SET status = '已删除', retired = 1, revision = revision + 1, delete_reason = '已被重新抽取结果替代' WHERE project_id = ? AND code = ?").run(projectId, code);
}

// ---------- business capabilities ----------

export function rowToCapability(r) {
  return { ...r, req_ids: parse(r.req_ids, []), edited: Boolean(r.edited) };
}

export function listCapabilities(projectId, { includeDeleted = true } = {}) {
  const sql = `SELECT * FROM capabilities WHERE project_id = ? ${includeDeleted ? "" : "AND status != '已删除'"} ORDER BY ord, code`;
  return getDb().prepare(sql).all(projectId).map(rowToCapability);
}

export function getCapability(projectId, code) {
  const row = getDb().prepare("SELECT * FROM capabilities WHERE project_id = ? AND code = ?").get(projectId, code);
  if (!row) throw notFound("业务能力");
  return rowToCapability(row);
}

export function nextCapabilityCode(projectId) {
  const nums = getDb().prepare("SELECT code FROM capabilities WHERE project_id = ?").all(projectId).map((r) => Number(r.code.slice(1)) || 0);
  return `C${String(Math.max(0, ...nums) + 1).padStart(2, "0")}`;
}

export function insertCapability(projectId, c) {
  const code = c.code ?? nextCapabilityCode(projectId);
  getDb()
    .prepare(
      "INSERT INTO capabilities (project_id, code, name, description, activity, req_ids, priority, status, origin, edited, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(projectId, code, c.name, c.description ?? "", c.activity, json(c.req_ids ?? []), c.priority ?? "重要", c.status ?? "待确认", c.origin ?? "系统", c.edited ? 1 : 0, c.ord ?? 1e9);
  return code;
}

export function updateCapability(projectId, code, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const val = (k) => (k === "req_ids" ? json(fields[k]) : typeof fields[k] === "boolean" ? (fields[k] ? 1 : 0) : fields[k]);
  getDb()
    .prepare(`UPDATE capabilities SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE project_id = ? AND code = ?`)
    .run(...keys.map(val), projectId, code);
}

export function deleteCapability(projectId, code) {
  getDb().prepare("UPDATE capabilities SET status = '已删除', delete_reason = '已被重新生成结果替代' WHERE project_id = ? AND code = ?").run(projectId, code);
}

// ---------- parameters ----------

export function listOverrides(projectId) {
  const rows = getDb().prepare("SELECT * FROM param_overrides WHERE project_id = ?").all(projectId);
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

export function setOverride(projectId, name, { value, source, note = "", questionId = null }) {
  getDb()
    .prepare("INSERT OR REPLACE INTO param_overrides (project_id, name, value, source, note, question_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(projectId, name, value, source, note, questionId);
}

export function clearOverride(projectId, name) {
  getDb().prepare("DELETE FROM param_overrides WHERE project_id = ? AND name = ?").run(projectId, name);
}

// ---------- questions ----------

export function rowToQuestion(q) {
  return { ...q, req_ids: parse(q.req_ids, []), scenario_ids: parse(q.scenario_ids, []), field_paths: parse(q.field_paths, []), proposal: parse(q.proposal, null), applied: parse(q.applied, null), edited: Boolean(q.edited) };
}

export function listQuestions(projectId) {
  return getDb()
    .prepare(
      `SELECT * FROM questions WHERE project_id = ?
       ORDER BY CASE status WHEN '已答复' THEN 0 WHEN '待处理' THEN 1 WHEN '待答复' THEN 2 WHEN '已应用' THEN 3 ELSE 4 END,
                CASE impact WHEN '影响废标风险' THEN 0 WHEN '影响报价' THEN 1 ELSE 2 END, id`,
    )
    .all(projectId)
    .map(rowToQuestion);
}

export function getQuestion(projectId, id) {
  const row = getDb().prepare("SELECT * FROM questions WHERE project_id = ? AND id = ?").get(projectId, id);
  if (!row) throw notFound("澄清问题");
  return rowToQuestion(row);
}

export function insertQuestion(projectId, q) {
  getDb()
    .prepare(
      `INSERT INTO questions (project_id, source, topic, param, req_ids, question, reason, impact, suggested_answer, scenario_ids, field_paths, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待处理', ?, ?)`,
    )
    .run(projectId, q.source, q.topic ?? "", q.param ?? null, json(q.req_ids ?? []), q.question, q.reason ?? "", q.impact, q.suggested_answer ?? "", json(q.scenario_ids ?? []), json(q.field_paths ?? []), now(), now());
}

export function updateQuestion(projectId, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const val = (k) => (["req_ids", "scenario_ids", "field_paths", "proposal", "applied"].includes(k) ? json(fields[k]) : typeof fields[k] === "boolean" ? (fields[k] ? 1 : 0) : fields[k]);
  getDb()
    .prepare(`UPDATE questions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE project_id = ? AND id = ?`)
    .run(...keys.map(val), now(), projectId, id);
}

export function deleteQuestion(projectId, id) {
  getDb().prepare("DELETE FROM questions WHERE project_id = ? AND id = ?").run(projectId, id);
}

// ---------- PBS items ----------

const ITEM_JSON = ["matched_capabilities", "blocked_by", "evidence_chunks", "capability_ids", "scenario_ids", "req_ids", "history_ref", "repairs"];
const ITEM_BOOL = ["manual_qty", "edited", "confirmed", "reviewed"];
const ITEM_COLUMNS = [
  "code",
  "parent",
  "name",
  "spec",
  "source",
  "product_ref",
  ...ITEM_JSON,
  "sizing_rule",
  "qty",
  "qty_quote",
  "qty_basis",
  "unit",
  "manual_qty",
  "basis",
  "origin",
  "edited",
  "confirmed",
  "reviewed",
  "stale",
  "last_qty",
];

export function rowToItem(row) {
  const item = { ...row };
  for (const k of ITEM_JSON) item[k] = parse(row[k], k === "blocked_by" ? null : []);
  for (const k of ITEM_BOOL) item[k] = Boolean(row[k]);
  return item;
}

export function listItems(projectId) {
  return getDb().prepare("SELECT * FROM pbs_items WHERE project_id = ? ORDER BY parent, CAST(substr(code, instr(code, '.') + 1) AS INTEGER)").all(projectId).map(rowToItem);
}

export function getItem(projectId, id) {
  const row = getDb().prepare("SELECT * FROM pbs_items WHERE project_id = ? AND id = ?").get(projectId, id);
  if (!row) throw notFound("PBS 项");
  return rowToItem(row);
}

const itemValue = (item, k) => {
  const v = item[k];
  if (ITEM_JSON.includes(k)) return json(v ?? (k === "blocked_by" ? null : []));
  if (ITEM_BOOL.includes(k)) return v ? 1 : 0;
  if (k === "qty_basis") return item.qty_basis ?? item.qtyBasis ?? "待估";
  return v ?? (["spec", "qty_quote", "unit", "basis", "stale"].includes(k) ? "" : null);
};

/** Upsert: items with an id are updated, the rest inserted. Returns ids in input order. */
export function saveItems(projectId, items) {
  const db = getDb();
  const insert = db.prepare(`INSERT INTO pbs_items (project_id, ${ITEM_COLUMNS.join(", ")}) VALUES (?, ${ITEM_COLUMNS.map(() => "?").join(", ")})`);
  const update = db.prepare(`UPDATE pbs_items SET ${ITEM_COLUMNS.map((c) => `${c} = ?`).join(", ")} WHERE project_id = ? AND id = ?`);
  return items.map((item) => {
    const values = ITEM_COLUMNS.map((k) => itemValue(item, k));
    if (item.id) {
      update.run(...values, projectId, item.id);
      return item.id;
    }
    const id = Number(insert.run(projectId, ...values).lastInsertRowid);
    item.id = id;
    return id;
  });
}

export function deleteItems(projectId, ids) {
  if (!ids.length) return;
  getDb().prepare(`DELETE FROM pbs_items WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`).run(projectId, ...ids);
}
