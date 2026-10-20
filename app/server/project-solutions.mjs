// Customer-specific solution composition; never part of the shared product catalogue.
import { digest, expandBom } from "../engine/catalog.mjs";
import { readCatalog } from "./catalog.mjs";
import { getDb, now } from "./db.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import * as repo from "./repo.mjs";

const projectDesign = (s) => ({ id: s.id, name: s.name, scenario_ids: s.scenario_ids ?? [], req_ids: s.req_ids ?? [], item_ids: s.item_ids ?? [], design_notes: s.design_notes ?? "", status: s.status ?? "草稿" });
export function solutionContext(projectId) {
  return (repo.getProject(projectId).pbs_meta.solution_designs ?? []).map(projectDesign);
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
    return { id: String(s.id), name: String(s.name).trim(), scenario_ids: [...new Set(s.scenario_ids)], req_ids: [...new Set(s.req_ids)], item_ids: [...new Set(s.item_ids)], design_notes: String(s.design_notes ?? ""), status: "草稿" };
  });
  repo.updateProject(projectId, { pbs_meta: { ...project.pbs_meta, solution_designs: clean } });
  return clean;
}

export const projectInputHash = (projectId) => digest({ designs: repo.getProject(projectId).pbs_meta.solution_designs ?? [], items: repo.listItems(projectId), scenarios: getDb().prepare("SELECT code,revision,status FROM scenarios WHERE project_id=? ORDER BY code").all(projectId), requirements: repo.listRequirements(projectId) });

export function buildProjectBom(projectId) {
  const current = readCatalog();
  if (!current) return null;
  const designs = solutionContext(projectId);
  const items = repo.listItems(projectId);
  const products = new Map(current.pack.products.map((p) => [p.id, p]));
  const buildItem = (item) => {
    const p = products.get(item.product_ref);
    const unitMismatch = p && item.unit !== p.unit;
    return { ...item, product: p ?? null, bom: p ? expandBom(current.pack, p.id, unitMismatch ? null : item.qty) : [], warnings: [unitMismatch && "PBS数量单位与产品BOM单位不一致，展开用量保留待确认", !p && "未关联目录产品，无法展开BOM", p?.metadata.active === false && "产品已归档", item.qty === null && "产品数量待确认", p && !current.pack.boms.some((b) => b.product_ref === p.id) && "尚未维护BOM", item.stale && "PBS项待复核"].filter(Boolean) };
  };
  const solutions = designs.map((s) => ({ ...s, products: s.item_ids.map((id) => items.find((i) => i.id === id)).filter(Boolean).map(buildItem), missing_items: s.item_ids.filter((id) => !items.some((i) => i.id === id)) }));
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
  return { designs: solutionContext(projectId), snapshot, snapshot_stale: Boolean(snapshot && (snapshot.input_hash !== projectInputHash(projectId) || snapshot.catalog_fingerprint !== current.fingerprint)), preview: buildProjectBom(projectId) };
}
