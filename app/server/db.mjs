import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const seedDir = new URL("../seed/", import.meta.url);
const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS collaboration_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal TEXT NOT NULL,
  stage TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  approval_id TEXT, job_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_activations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, mode TEXT NOT NULL,
  input TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_sessions (
  project_id TEXT NOT NULL, role TEXT NOT NULL, session_id TEXT NOT NULL,
  PRIMARY KEY(project_id, role)
);
CREATE TABLE IF NOT EXISTS collaboration_consultations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
  caller TEXT NOT NULL, target TEXT NOT NULL, activation_id TEXT NOT NULL,
  revision INTEGER NOT NULL, input_version TEXT NOT NULL,
  question TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting',
  answer TEXT, outcome TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_interventions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
  target TEXT NOT NULL, content TEXT NOT NULL, data TEXT NOT NULL,
  revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'received',
  delivered_activation TEXT, result TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_approvals (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, input_version TEXT NOT NULL,
  snapshot TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT,
  kind TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT, content TEXT NOT NULL,
  payload TEXT NOT NULL, chat_id INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_events_project ON collaboration_events(project_id,seq);
CREATE INDEX IF NOT EXISTS collaboration_queue ON collaboration_activations(task_id,state);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT, goal TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT, error TEXT, stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_operations (
  project_id TEXT NOT NULL, operation_id TEXT NOT NULL, tool TEXT NOT NULL,
  input_hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, operation_id)
);
CREATE TABLE IF NOT EXISTS agent_coverage (
  project_id TEXT NOT NULL, evidence_id TEXT NOT NULL, document_version TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(project_id, evidence_id, document_version)
);

CREATE TABLE IF NOT EXISTS catalog_revisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_imports (id TEXT PRIMARY KEY, data TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  limits TEXT NOT NULL DEFAULT '[]',
  xinchuang TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '套',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待确认',
  draft TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  product_id TEXT,
  doc_id INTEGER,
  history_id TEXT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_product ON chunks(product_id);

CREATE TABLE IF NOT EXISTS source_snapshots (
  project_id TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (project_id, uid)
);
CREATE TABLE IF NOT EXISTS scenarios (
  project_id TEXT NOT NULL, code TEXT NOT NULL, data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待确认', revision INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT '系统', edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, code)
);
CREATE TABLE IF NOT EXISTS scenario_requirements (
  project_id TEXT NOT NULL, scenario_code TEXT NOT NULL, req_code TEXT NOT NULL,
  role TEXT NOT NULL, PRIMARY KEY (project_id, scenario_code, req_code)
);
CREATE TABLE IF NOT EXISTS scenario_revisions (
  project_id TEXT NOT NULL, scenario_code TEXT NOT NULL, revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scenario_code, revision)
);
CREATE TABLE IF NOT EXISTS requirement_dispositions (
  project_id TEXT NOT NULL, req_code TEXT NOT NULL, data TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, req_code)
);
CREATE TABLE IF NOT EXISTS scenario_runs (
  project_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  result TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, request_id)
);

CREATE TABLE IF NOT EXISTS embed_cache (
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (hash, model)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  pbs_meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT,
  text TEXT NOT NULL,
  numbered INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  extracted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  project_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  material_id INTEGER NOT NULL,
  seg_id TEXT NOT NULL,
  chapter TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  star INTEGER NOT NULL DEFAULT 0,
  triangle INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL,
  PRIMARY KEY (project_id, uid)
);

CREATE TABLE IF NOT EXISTS requirements (
  project_id TEXT NOT NULL,
  code TEXT NOT NULL,
  seg_uid TEXT,
  text TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  quote_verified INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  inferred INTEGER NOT NULL DEFAULT 0,
  star INTEGER NOT NULL DEFAULT 0,
  triangle INTEGER NOT NULL DEFAULT 0,
  params TEXT NOT NULL DEFAULT '[]',
  rejected_params TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT '待确认',
  origin TEXT NOT NULL DEFAULT '系统',
  source_note TEXT NOT NULL DEFAULT '',
  edited INTEGER NOT NULL DEFAULT 0,
  delete_reason TEXT NOT NULL DEFAULT '',
  ord INTEGER NOT NULL,
  PRIMARY KEY (project_id, code)
);

CREATE TABLE IF NOT EXISTS param_overrides (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  question_id INTEGER,
  PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  param TEXT,
  req_ids TEXT NOT NULL DEFAULT '[]',
  question TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL,
  suggested_answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '待处理',
  assignee TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  answer_source TEXT NOT NULL DEFAULT '',
  proposal TEXT,
  applied TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pbs_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  code TEXT NOT NULL,
  parent TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  product_ref TEXT,
  matched_capabilities TEXT NOT NULL DEFAULT '[]',
  blocked_by TEXT,
  evidence_chunks TEXT NOT NULL DEFAULT '[]',
  capability_ids TEXT NOT NULL DEFAULT '[]',
  req_ids TEXT NOT NULL DEFAULT '[]',
  sizing_rule TEXT,
  qty REAL,
  qty_quote TEXT NOT NULL DEFAULT '',
  qty_basis TEXT NOT NULL DEFAULT '待估',
  unit TEXT NOT NULL DEFAULT '',
  manual_qty INTEGER NOT NULL DEFAULT 0,
  history_ref TEXT NOT NULL DEFAULT '[]',
  basis TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'model',
  repairs TEXT NOT NULL DEFAULT '[]',
  edited INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  stale TEXT NOT NULL DEFAULT '',
  last_qty REAL
);

CREATE TABLE IF NOT EXISTS capabilities (
  project_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  activity TEXT NOT NULL,
  req_ids TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT '重要',
  status TEXT NOT NULL DEFAULT '待确认',
  origin TEXT NOT NULL DEFAULT '系统',
  edited INTEGER NOT NULL DEFAULT 0,
  delete_reason TEXT NOT NULL DEFAULT '',
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, code)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_project ON chat_messages(project_id, id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  job_id TEXT,
  step TEXT NOT NULL,
  model TEXT NOT NULL,
  cached INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  at TEXT NOT NULL
);
`;

export const now = () => new Date().toISOString();
export const json = (value) => JSON.stringify(value ?? null);
export const parse = (text, fallback) => {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export function readSeed(path) {
  return JSON.parse(readFileSync(new URL(path, seedDir), "utf8"));
}

let db = null;
let transactionDepth = 0;

export function openDb(file = process.env.APP_DB || fileURLToPath(new URL("../data/app.db", import.meta.url))) {
  if (db) return db;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  if (!db.prepare("SELECT 1 FROM products LIMIT 1").get()) seedProducts();
  return db;
}

// CREATE TABLE IF NOT EXISTS never alters an existing table, so new columns need an explicit step.
const MIGRATIONS = [
  { version: 6, table: "pbs_items", column: "input_scope", ddl: "ALTER TABLE pbs_items ADD COLUMN input_scope TEXT NOT NULL DEFAULT '[]'" },
  { version: 4, table: "products", column: "metadata", ddl: "ALTER TABLE products ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'" },
  { version: 2, table: "pbs_items", column: "capability_ids", ddl: "ALTER TABLE pbs_items ADD COLUMN capability_ids TEXT NOT NULL DEFAULT '[]'" },
  { version: 3, table: "pbs_items", column: "scenario_ids", ddl: "ALTER TABLE pbs_items ADD COLUMN scenario_ids TEXT NOT NULL DEFAULT '[]'" },
  { version: 3, table: "pbs_items", column: "reviewed", ddl: "ALTER TABLE pbs_items ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0" },
  { version: 3, table: "requirements", column: "revision", ddl: "ALTER TABLE requirements ADD COLUMN revision INTEGER NOT NULL DEFAULT 1" },
  { version: 3, table: "requirements", column: "retired", ddl: "ALTER TABLE requirements ADD COLUMN retired INTEGER NOT NULL DEFAULT 0" },
  { version: 3, table: "requirements", column: "answer_evidence", ddl: "ALTER TABLE requirements ADD COLUMN answer_evidence TEXT NOT NULL DEFAULT '[]'" },
  { version: 3, table: "questions", column: "scenario_ids", ddl: "ALTER TABLE questions ADD COLUMN scenario_ids TEXT NOT NULL DEFAULT '[]'" },
  { version: 3, table: "questions", column: "field_paths", ddl: "ALTER TABLE questions ADD COLUMN field_paths TEXT NOT NULL DEFAULT '[]'" },
  { version: 3, table: "chunks", column: "active", ddl: "ALTER TABLE chunks ADD COLUMN active INTEGER NOT NULL DEFAULT 1" },
  { version: 3, table: "requirement_dispositions", column: "revision", ddl: "ALTER TABLE requirement_dispositions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1" },
];

function migrate(database) {
  const current = Number(database.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value ?? 0);
  for (const m of MIGRATIONS) {
    const has = database.prepare(`PRAGMA table_info(${m.table})`).all().some((c) => c.name === m.column);
    if (!has) database.exec(m.ddl);
  }
  database.exec("UPDATE pbs_items SET reviewed = 1 WHERE confirmed = 1 AND reviewed = 0");
  // Snapshot existing source text before any material can be removed. No confirmation is inferred.
  const sources = database.prepare("SELECT s.*, m.title AS material_title, m.no AS material_no, m.kind AS material_kind FROM segments s JOIN materials m ON m.id = s.material_id").all();
  const putSource = database.prepare("INSERT OR IGNORE INTO source_snapshots(project_id, uid, data) VALUES (?, ?, ?)");
  for (const source of sources) putSource.run(source.project_id, source.uid, json(source));
  if (current < SCHEMA_VERSION) {
    database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  }
}

/** Tests use a fresh in-memory database per test. */
export function resetDb(file = ":memory:") {
  db?.close();
  db = null;
  return openDb(file);
}

export function getDb() {
  return db ?? openDb();
}

function seedProducts() {
  const insert = db.prepare(
    "INSERT INTO products (id, name, summary, capabilities, limits, xinchuang, unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const p of readSeed("products.json")) {
    insert.run(p.id, p.name, p.summary ?? "", json(p.capabilities), json(p.limits), p.xinchuang ?? "", p.unit ?? "套", now());
  }
}

export function tx(fn) {
  const d = getDb();
  const level = transactionDepth++;
  d.exec(level ? `SAVEPOINT nested_${level}` : "BEGIN");
  try {
    const result = fn(d);
    d.exec(level ? `RELEASE nested_${level}` : "COMMIT");
    return result;
  } catch (error) {
    d.exec(level ? `ROLLBACK TO nested_${level}` : "ROLLBACK");
    if (level) d.exec(`RELEASE nested_${level}`);
    throw error;
  } finally {
    transactionDepth -= 1;
  }
}

// Read-only configuration (not editable in this version).
let config = null;
export function loadConfig() {
  config ??= {
    template: readSeed("config/pbs_template.json"),
    sizing: readSeed("config/sizing_rules.json"),
    checklists: readSeed("config/checklists.json"),
    history: readSeed("config/history_projects.json"),
  };
  return config;
}
