import { readFileSync } from "node:fs";
import { digest, expandBom, validatePack } from "../engine/catalog.mjs";
import { getDb, json, loadConfig, now, parse, readSeed, tx } from "./db.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import * as repo from "./repo.mjs";
import * as rag from "./rag.mjs";

export const defaultPack = () => JSON.parse(readFileSync(new URL("../catalogs/low-altitude-demo/catalog.json", import.meta.url), "utf8"));
const latest = () => getDb().prepare("SELECT * FROM catalog_revisions ORDER BY revision DESC LIMIT 1").get();
const productData = (p) => ({ id: p.id, name: p.name, summary: p.summary, capabilities: p.capabilities, limits: p.limits, xinchuang: p.xinchuang ?? "", unit: p.unit,
  metadata: { kind: "未分类", delivery_source: "自有产品", availability: "待核实", data_kind: "人工维护", quantity_policy: "unknown", active: true, compatibility: [], deliverables: [], reference_ids: [], ...p.metadata } });

export function readCatalog() {
  const row = latest();
  if (!row) return null;
  const pack = parse(row.data, {});
  pack.products = repo.listProducts().map(productData);
  return { revision: row.revision, updated_at: row.created_at, pack, fingerprint: digest(pack) };
}

function persist(pack, reason) {
  const checked = validatePack(pack);
  const previous = latest();
  if (previous && digest(parse(previous.data, {})) === digest(checked)) return readCatalog();
  tx((db) => {
    const put = db.prepare(`INSERT INTO products(id,name,summary,capabilities,limits,xinchuang,unit,metadata,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,summary=excluded.summary,capabilities=excluded.capabilities,limits=excluded.limits,xinchuang=excluded.xinchuang,unit=excluded.unit,metadata=excluded.metadata,updated_at=excluded.updated_at`);
    for (const p of checked.products) put.run(p.id, p.name, p.summary, json(p.capabilities), json(p.limits), p.xinchuang ?? "", p.unit, json(p.metadata), now());
    db.prepare("INSERT INTO catalog_revisions(data,reason,created_at) VALUES(?,?,?)").run(json(checked), reason, now());
    // Catalogue changes affect source/availability/BOM as well as capability text.
    db.exec("UPDATE pbs_items SET confirmed=0, stale='产品目录或BOM版本已变化，请复核' WHERE product_ref IS NOT NULL OR sizing_rule IS NOT NULL");
  });
  for (const p of repo.listProducts()) {
    if (p.metadata.active === false) rag.removeProductChunks(p.id);
    else rag.indexProduct(p);
  }
  return readCatalog();
}

/** Once only. Existing edits and all historical IDs are retained. No startup reseeding. */
export function installDefaultCatalog() {
  if (latest()) return readCatalog();
  const pack = validatePack(defaultPack());
  const seeds = readSeed("products.json");
  const legacy = repo.listProducts().map((p) => {
    const original = seeds.find((s) => s.id === p.id);
    const untouched = original && ["name", "summary", "capabilities", "limits", "xinchuang", "unit"].every((k) => json(original[k]) === json(p[k]));
    return productData({ ...p, metadata: { ...p.metadata, ...(untouched ? { active: false, data_kind: "旧版模拟（已归档）" } : {}) } });
  });
  pack.products.push(...legacy);
  tx((db) => {
    persist(pack, "首次安装独立低空模拟目录，保留历史产品");
    db.prepare("INSERT INTO catalog_imports(id,data) VALUES(?,?)").run(pack.id, json(defaultPack()));
  });
  return readCatalog();
}

const collections = ["references", "products", "solutions", "boms"];
/** Three-way merge. Local edits win, including locally removed records. */
export function previewImport(input) {
  const incoming = validatePack(input);
  const current = readCatalog();
  const base = parse(getDb().prepare("SELECT data FROM catalog_imports WHERE id=?").get(incoming.id)?.data, {});
  const merged = structuredClone(current?.pack ?? incoming);
  const changes = []; const conflicts = [];
  for (const kind of collections) {
    const old = new Map((base[kind] ?? []).map((x) => [x.id, x]));
    const local = new Map((merged[kind] ?? []).map((x) => [x.id, x]));
    const next = new Map(incoming[kind].map((x) => [x.id, x]));
    for (const [id, row] of next) {
      const here = local.get(id);
      if (digest(here) === digest(row)) continue;
      if ((here && !old.has(id)) || (old.has(id) && digest(here) !== digest(old.get(id)))) {
        conflicts.push({ kind, id, name: row.name ?? row.title ?? id, reason: "已有人工修改，保留当前内容" }); continue;
      }
      local.set(id, row); changes.push({ kind, id, action: here ? "更新" : "新增" });
    }
    for (const [id, row] of old) {
      if (next.has(id) || !local.has(id)) continue;
      if (digest(local.get(id)) !== digest(row)) { conflicts.push({ kind, id, reason: "数据包移除但本地已修改，保留" }); continue; }
      if (kind === "products") local.set(id, { ...local.get(id), metadata: { ...row.metadata, active: false } });
      else local.delete(id);
      changes.push({ kind, id, action: kind === "products" ? "归档" : "移除" });
    }
    merged[kind] = [...local.values()];
  }
  for (const key of ["id", "version", "name", "description", "sizing", "schema_version"]) {
    if (!current || !base[key] || digest(merged[key]) === digest(base[key])) merged[key] = incoming[key];
    else if (digest(merged[key]) !== digest(incoming[key])) conflicts.push({ kind: "配置", id: key, reason: "配置已有本地修改，保留" });
  }
  try { validatePack(merged); } catch (error) { throw badRequest(`${error.message}；请调整数据包中的关联后重试`); }
  return { pack: incoming, merged, changes, conflicts, token: digest({ current: current?.fingerprint, incoming }) };
}

export function importCatalog({ pack, token }) {
  const plan = previewImport(pack);
  if (token !== plan.token) throw new HttpError(409, "目录已变化，请重新预览导入结果");
  return tx((db) => {
    const result = persist(plan.merged, `导入数据包 ${pack.id}@${pack.version}`);
    db.prepare("INSERT OR REPLACE INTO catalog_imports(id,data) VALUES(?,?)").run(pack.id, json(plan.pack));
    return { ...result, changes: plan.changes, conflicts: plan.conflicts };
  });
}

export function saveEntry(kind, id, entry, fingerprint) {
  if (!["solutions", "boms"].includes(kind)) throw badRequest("目录类型错误");
  const current = readCatalog();
  if (!current || current.fingerprint !== fingerprint) throw new HttpError(409, "目录已变化，请重新加载后修改");
  const pack = current.pack;
  const index = pack[kind].findIndex((r) => r.id === id);
  if (entry === null) {
    if (index < 0) throw badRequest("目录条目不存在");
    pack[kind].splice(index, 1);
  } else {
    if (entry.id !== id) throw badRequest("编辑时不能更改条目编号");
    if (index >= 0 && entry.version === pack[kind][index].version && digest(entry) !== digest(pack[kind][index])) {
      const semver = /^(\d+)\.(\d+)\.(\d+)$/.exec(entry.version);
      entry.version = semver ? `${semver[1]}.${semver[2]}.${Number(semver[3]) + 1}` : `${entry.version}-r${current.revision + 1}`;
    }
    if (index < 0) pack[kind].push(entry); else pack[kind][index] = entry;
  }
  try { return persist(pack, `人工维护 ${kind}/${id}`); } catch (error) { if (error.message.startsWith("目录校验")) throw badRequest(error.message); throw error; }
}

export function recordProductChange() {
  const current = readCatalog();
  if (current) persist(current.pack, "人工维护产品信息");
}

/** Legacy project rules remain interpretable but cannot trigger new procurement lines. */
export function runtimeConfig(projectId) {
  const base = loadConfig();
  const current = readCatalog();
  if (!current) return base;
  const used = new Set(projectId ? repo.listItems(projectId).map((i) => i.sizing_rule) : []);
  const profile = current.pack.sizing;
  const params = { ...profile.params };
  const retained = base.sizing.rules.filter((r) => used.has(r.id)).map(({ required_when, required_if, defaults, ...r }) => r);
  for (const rule of retained) for (const name of rule.inputs) if (!params[name]) {
    const spec = { ...base.sizing.params[name] }; delete spec.derive; params[name] = spec;
  }
  return { ...base, history: [], sizing: { params, rules: [...profile.rules.map((r) => ({ ...r, strict_product: true, inputs: [r.param], expr: r.param, note: "仅按已确认输入计量，不由覆盖面积推定数量" })), ...retained] } };
}

export function solutionContext(projectId) {
  const current = readCatalog();
  if (!current) return [];
  const selected = repo.getProject(projectId).pbs_meta.solution_designs ?? [];
  return selected.map((s) => ({ ...s, template: current.pack.solutions.find((t) => t.id === s.template_id) ?? null }));
}

export function saveProjectSolutions(projectId, designs, inputHash) {
  if (inputHash && inputHash !== projectInputHash(projectId)) throw new HttpError(409, "项目已变化，请重新加载后编辑方案");
  const project = repo.getProject(projectId);
  if (!Array.isArray(designs)) throw badRequest("解决方案应为数组");
  const itemIds = new Set(repo.listItems(projectId).map((i) => i.id));
  const sceneIds = new Set(getDb().prepare("SELECT code FROM scenarios WHERE project_id=? AND status!='已归档'").all(projectId).map((s) => s.code));
  const reqIds = new Set(repo.listRequirements(projectId, { includeDeleted: false }).map((r) => r.code));
  const ids = new Set();
  const clean = designs.map((s) => {
    if (!s.id || ids.has(s.id) || !String(s.name ?? "").trim()) throw badRequest("项目方案编号不能重复、名称不能为空");
    ids.add(s.id);
    if (!Array.isArray(s.item_ids) || s.item_ids.some((id) => !itemIds.has(id))) throw badRequest("方案关联的PBS产品项已变化");
    if (!Array.isArray(s.scenario_ids) || s.scenario_ids.some((id) => !sceneIds.has(id))) throw badRequest("方案关联场景不存在或已归档");
    if (!Array.isArray(s.req_ids) || s.req_ids.some((id) => !reqIds.has(id))) throw badRequest("方案关联需求不存在");
    if (!s.scenario_ids.length && !s.req_ids.length) throw badRequest("项目方案至少关联一个客户场景或原始需求");
    if (s.template_id && !readCatalog()?.pack.solutions.some((t) => t.id === s.template_id)) throw badRequest("参考方案不存在");
    return { id: String(s.id), name: String(s.name).trim(), template_id: s.template_id || null, scenario_ids: [...new Set(s.scenario_ids)], req_ids: [...new Set(s.req_ids)], item_ids: [...new Set(s.item_ids)], design_notes: String(s.design_notes ?? ""), status: "草稿" };
  });
  repo.updateProject(projectId, { pbs_meta: { ...project.pbs_meta, solution_designs: clean } });
  return clean;
}

export const projectInputHash = (projectId) => digest({ designs: repo.getProject(projectId).pbs_meta.solution_designs ?? [], items: repo.listItems(projectId), scenarios: getDb().prepare("SELECT code,revision,status FROM scenarios WHERE project_id=? ORDER BY code").all(projectId), requirements: repo.listRequirements(projectId) });

export function buildProjectBom(projectId) {
  const current = readCatalog();
  if (!current) return null;
  const project = repo.getProject(projectId);
  const designs = project.pbs_meta.solution_designs ?? [];
  const items = repo.listItems(projectId);
  const products = new Map(current.pack.products.map((p) => [p.id, p]));
  const used = new Set();
  const buildItem = (item) => {
    used.add(item.id);
    const p = products.get(item.product_ref);
    const unitMismatch = p && item.unit !== p.unit;
    return { ...item, product: p ?? null, bom: p ? expandBom(current.pack, p.id, unitMismatch ? null : item.qty) : [], warnings: [unitMismatch && "PBS数量单位与产品BOM单位不一致，展开用量保留待确认", !p && "未关联目录产品，无法展开BOM", p?.metadata.active === false && "产品已归档", item.qty === null && "产品数量待确认", p && !current.pack.boms.some((b) => b.product_ref === p.id) && "尚未维护BOM", item.stale && "PBS项待复核"].filter(Boolean) };
  };
  const solutions = designs.map((s) => ({ ...s, template: current.pack.solutions.find((t) => t.id === s.template_id) ?? null, products: s.item_ids.map((id) => items.find((i) => i.id === id)).filter(Boolean).map(buildItem), missing_items: s.item_ids.filter((id) => !items.some((i) => i.id === id)) }));
  // Shared PBS items appear under each solution for traceability; the unique list governs totals.
  const uniqueProducts = items.map(buildItem);
  const componentRefs = new Set(uniqueProducts.flatMap((i) => i.bom.filter((l) => l.included && l.product_ref).map((l) => l.product_ref)));
  const overlap = uniqueProducts.filter((i) => i.product_ref && componentRefs.has(i.product_ref)).map((i) => `${i.code} ${i.name} 同时出现在其他产品BOM中，请核对采购范围，避免重复计量`);
  return { catalog_revision: current.revision, catalog_version: current.pack.version, catalog_fingerprint: current.fingerprint, input_hash: projectInputHash(projectId), created_at: now(), solutions, unassigned: items.filter((i) => !designs.some((s) => s.item_ids.includes(i.id))).map((i) => i.id), products: uniqueProducts, warnings: overlap, note: "MOCK目录展开草稿；BOM为组成关系，不额外计入PBS报价。可选项未选配，未知数量保留待确认。" };
}

export function captureProjectBom(projectId) {
  const snapshot = buildProjectBom(projectId);
  if (!snapshot) throw badRequest("尚未安装产品目录");
  const project = repo.getProject(projectId);
  repo.updateProject(projectId, { pbs_meta: { ...project.pbs_meta, catalog_snapshot: snapshot } });
  repo.logEvent(projectId, "产品BOM", `保存方案与BOM快照（目录版本 ${snapshot.catalog_version} / 修订 ${snapshot.catalog_revision}）`);
  return snapshot;
}

export function projectCatalogView(projectId) {
  const current = readCatalog();
  if (!current) return null;
  const p = repo.getProject(projectId);
  const snapshot = p.pbs_meta.catalog_snapshot ?? null;
  return { designs: p.pbs_meta.solution_designs ?? [], snapshot, snapshot_stale: Boolean(snapshot && (snapshot.input_hash !== projectInputHash(projectId) || snapshot.catalog_fingerprint !== current.fingerprint)), preview: buildProjectBom(projectId) };
}
