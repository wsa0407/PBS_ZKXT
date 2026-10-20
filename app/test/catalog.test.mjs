import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { defaultPack, installDefaultCatalog, readCatalog, previewImport, importCatalog, saveEntry, runtimeConfig } from "../server/catalog.mjs";
import { saveProjectSolutions, captureProjectBom, projectCatalogView, solutionContext } from "../server/project-solutions.mjs";
import { expandBom, validatePack, digest } from "../engine/catalog.mjs";
import { createContext, enforceLeaves, normalizeLeaf, productText } from "../engine/pbs.mjs";
import { resolveParams, missingRules } from "../engine/sizing.mjs";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as rag from "../server/rag.mjs";
import { exportProject } from "../server/xlsx.mjs";

beforeEach(() => { resetDb(":memory:"); rag.setRetrievalMode({ kind: "keyword" }); });
const installed = () => installDefaultCatalog();
const changePack = (fn) => { const p = defaultPack(); p.version = "1.2.0"; fn(p); return p; };
const importPack = (pack) => { const p = previewImport(pack); return importCatalog({ pack, token: p.token }); };
function projectWithItems() {
  installed();
  const id = repo.createProject({ name: "专业目录验收" }).id;
  const req = svc.addRequirement(id, { text: "道路夜间巡逻和事故取证", category: "功能" });
  const item = svc.saveItem(id, null, { parent: "2", name: "值守单元", product_ref: "LA-P07", source: "自有产品", qty: 3, req_ids: [req] });
  return { id, req, item };
}

test("professional pack is complete, source-linked and does not claim OEM manufacturing BOMs", () => {
  const p = validatePack(defaultPack());
  assert.equal(p.products.length, 23); assert.ok(!Object.hasOwn(p, "solutions")); assert.equal(p.boms.length, 23);
  for (const product of p.products.filter((p) => p.metadata.data_kind === "厂商公开参考")) {
    assert.ok(product.metadata.reference_ids.length);
    assert.equal(p.boms.find((b) => b.product_ref === product.id).kind, "模拟交付配置");
  }
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});

test("pack validator rejects broken references, duplicate products, invalid quantities and BOM cycles", () => {
  let p = defaultPack(); p.boms[0].lines[0].product_ref = "missing"; assert.throws(() => validatePack(p), /不存在/);
  p = defaultPack(); p.products.push(p.products[0]); assert.throws(() => validatePack(p), /重复/);
  p = defaultPack(); p.boms[0].lines[0].qty = -1; assert.throws(() => validatePack(p), /非负数/);
  p = defaultPack(); p.boms[0].lines[0].product_ref = p.boms[0].product_ref; p.boms[0].lines[0].unit = p.products[0].unit; assert.throws(() => validatePack(p), /循环/);
  p = defaultPack(); p.products[0].metadata.reference_ids = ["MISSING"]; assert.throws(() => validatePack(p), /来源不存在/);
  p = defaultPack(); p.sizing.rules[0].param = "no_such_param"; assert.throws(() => validatePack(p), /参数不存在/);
});

test("default installation is idempotent, preserves edited legacy products and archives untouched seeds", () => {
  svc.saveProduct("P01", { ...repo.getProduct("P01"), summary: "客户已维护的真实内容" });
  const first = installed();
  assert.equal(repo.getProduct("P01").summary, "客户已维护的真实内容"); assert.notEqual(repo.getProduct("P01").metadata.active, false);
  assert.equal(repo.getProduct("P02").metadata.active, false);
  assert.equal(installed().revision, first.revision);
  assert.equal(repo.listProducts().length, 35);
});

test("archived seed products and manuals are excluded from current search while evidence remains readable", async () => {
  svc.rebuildIndex(); const oldId = getDb().prepare("SELECT id FROM chunks WHERE product_id='P02' LIMIT 1").get().id;
  const docId = repo.createDoc({ productId: "P02", name: "old", text: "旧版机场覆盖100平方公里" });
  rag.indexManual({ docId, productId: "P02", text: "旧版机场覆盖100平方公里" });
  installed(); svc.rebuildIndex();
  const [hits] = await rag.search(["机场无人值守"], { topK: 100 });
  assert.ok(hits.length); assert.ok(hits.every((h) => h.chunk.product_id !== "P02"));
  assert.equal(rag.getChunks([oldId])[0].product_id, "P02");
});

test("professional sizing does not invent dock coverage, spare aircraft or mandatory legacy lines", () => {
  installed(); const config = runtimeConfig();
  const resolved = resolveParams({ road_km: [{ value: 120 }], area_km2: [{ value: 500 }] }, config.sizing);
  assert.equal(resolved.dock_count.value, null);
  assert.equal(missingRules("机场、夜间、AI识别、低温-30℃", resolved, config.sizing, []).length, 0);
  assert.ok(config.sizing.rules.every((r) => r.product_ref.startsWith("LA-")));
});

test("old projects retain rules already used without triggering other legacy procurement", () => {
  const id = repo.createProject({ name: "旧项目" }).id;
  svc.saveItem(id, null, { parent: "2", name: "旧机场", source: "自有产品", product_ref: "P02", sizing_rule: "R01" });
  installed();
  const c = runtimeConfig(id);
  assert.ok(c.sizing.rules.some((r) => r.id === "R01")); assert.ok(!c.sizing.rules.some((r) => r.id === "R02"));
  assert.ok(!c.sizing.rules.find((r) => r.id === "R01").required_when);
  assert.doesNotThrow(() => svc.saveItem(id, repo.listItems(id)[0].id, { name: "旧机场复核" }));
});

test("external and planned products keep product references; hardware kits remain unknown without an input", () => {
  installed(); const config = runtimeConfig();
  const ctx = createContext({ requirements: [], segments: [], ...config, products: repo.listProducts() });
  const leaves = ["LA-E04", "LA-P06", "LA-P07", "LA-P01"].map((product_ref, i) => normalizeLeaf({ parent: "2", code: `2.${i+1}`, name: product_ref, source: "自有产品", product_ref }, ctx));
  enforceLeaves(leaves, ctx);
  assert.equal(leaves[0].source, "外采"); assert.equal(leaves[0].product_ref, "LA-E04");
  assert.equal(leaves[1].source, "自研"); assert.ok(ctx.issues.some((i) => i.message.includes("待研发")));
  assert.equal(leaves[2].qty, null); assert.equal(leaves[2].sizing_rule, "LA-Q01");
  assert.equal(leaves[3].qty, 1);
  assert.match(productText(repo.getProduct("LA-E04")), /delivery_source：外采/);
});

test("service editing retains purchased product references and does not turn hardware 套 into a licence", () => {
  const { id } = projectWithItems();
  const item = svc.saveItem(id, null, { parent: "2", name: "热成像载荷", source: "自有产品", product_ref: "LA-E04" });
  assert.equal(repo.getItem(id, item).product_ref, "LA-E04"); assert.equal(repo.getItem(id, item).source, "外采");
  const hardware = svc.saveItem(id, null, { parent: "2", name: "值守套装待估", source: "自有产品", product_ref: "LA-P07" });
  assert.equal(repo.getItem(id, hardware).qty, null);
});

test("BOM multiplies nested quantities, propagates unknowns and excludes optional configuration", () => {
  const p = defaultPack(); const rows = expandBom(p, "LA-P07", 3);
  assert.equal(rows.find((l) => l.product_ref === "LA-E01").total_qty, 3);
  assert.equal(rows.find((l) => l.parent_product === "LA-E01").total_qty, 3);
  assert.equal(rows.find((l) => l.name === "电源与接地材料").total_qty, null);
  assert.equal(rows.find((l) => l.product_ref === "LA-I01").included, false);
  assert.ok(expandBom(p, "LA-P07", null).every((l) => l.total_qty === null));
  assert.equal(expandBom(p, "LA-P07", 0).find((l) => l.product_ref === "LA-E01").total_qty, 0);
});

test("three-way product import updates unchanged records and preserves manual products and BOM versions", () => {
  installed(); svc.saveProduct("LA-P01", { ...repo.getProduct("LA-P01"), summary: "业务同事维护" });
  let current = readCatalog(); const bom = structuredClone(current.pack.boms[0]); bom.lines[0].qty = 2;
  current = saveEntry("boms", bom.id, bom, current.fingerprint); assert.equal(current.pack.boms[0].version, "1.0.1");
  const incoming = changePack((p) => { p.products[0].summary = "上游变化"; p.products[1].summary = "可更新资料"; p.boms[0].lines[0].qty = 3; });
  const plan = previewImport(incoming);
  assert.ok(plan.conflicts.some((c) => c.id === "LA-P01")); assert.ok(plan.conflicts.some((c) => c.id === bom.id));
  importCatalog({ pack: incoming, token: plan.token });
  assert.equal(repo.getProduct("LA-P01").summary, "业务同事维护"); assert.equal(repo.getProduct("LA-P02").summary, "可更新资料");
  assert.equal(readCatalog().pack.boms[0].lines[0].qty, 2);
});

test("import refuses stale previews and invalid local edits roll back atomically", () => {
  installed(); const incoming = changePack((p) => { p.products[0].summary = "更新"; }); const plan = previewImport(incoming);
  svc.saveProduct("LA-P02", { ...repo.getProduct("LA-P02"), summary: "期间编辑" });
  assert.throws(() => importCatalog({ pack: incoming, token: plan.token }), /重新预览/);
  assert.throws(() => svc.saveProduct("LA-P01", { ...repo.getProduct("LA-P01"), metadata: { kind: "硬件", quantity_policy: "single_license" } }), /只有软件/);
  assert.equal(repo.getProduct("LA-P01").metadata.kind, "软件");
});

test("exported data pack can be re-imported without false conflicts caused by JSON key order", () => {
  installed(); const exported = readCatalog().pack;
  const reversed = Object.fromEntries(Object.entries(exported).reverse());
  const plan = previewImport(reversed);
  assert.equal(plan.changes.length, 0); assert.equal(plan.conflicts.length, 0);
  assert.doesNotThrow(() => importCatalog({ pack: reversed, token: plan.token }));
});

test("solution and BOM snapshots keep historical data after catalogue edits and show stale state", () => {
  const { id, req, item } = projectWithItems();
  saveProjectSolutions(id, [{ id: "PS1", name: "道路项目方案", req_ids: [req], scenario_ids: [], item_ids: [item], design_notes: "本期值守3站" }]);
  const snap = captureProjectBom(id);
  assert.equal(snap.solutions[0].products[0].qty, 3); assert.equal(snap.products.length, 1); assert.equal(projectCatalogView(id).snapshot_stale, false);
  const current = readCatalog(); const bom = structuredClone(current.pack.boms.find((b) => b.product_ref === "LA-P07")); bom.lines[0].qty = 2;
  saveEntry("boms", bom.id, bom, current.fingerprint);
  const after = projectCatalogView(id);
  assert.equal(after.snapshot_stale, true);
  assert.equal(after.snapshot.products[0].bom.find((l) => l.product_ref === "LA-E01").total_qty, 3);
  assert.equal(after.preview.products[0].bom.find((l) => l.product_ref === "LA-E01").total_qty, 6);
});

test("shared PBS items appear in two solutions but export BOM uses unique product list", async () => {
  const { id, req, item } = projectWithItems();
  saveProjectSolutions(id, ["A", "B"].map((key) => ({ id: key, name: "项目方案" + key, req_ids: [req], scenario_ids: [], item_ids: [item] })));
  const snap = captureProjectBom(id); assert.equal(snap.solutions.length, 2); assert.equal(snap.products.length, 1);
  const ExcelJS = (await import("exceljs")).default; const book = new ExcelJS.Workbook();
  await book.xlsx.load(await exportProject(svc.projectView(id)));
  assert.ok(book.getWorksheet("解决方案产品关系"));
  const sheet = book.getWorksheet("产品BOM组成");
  assert.equal(sheet.rowCount, snap.products[0].bom.length + 2);
});

test("project solution links reject foreign records and require customer context", () => {
  const { id, req, item } = projectWithItems();
  assert.throws(() => saveProjectSolutions(id, [{ id: "X", name: "无来源方案", req_ids: [], scenario_ids: [], item_ids: [item] }]), /至少关联/);
  assert.throws(() => saveProjectSolutions(id, [{ id: "X", name: "跨项目", req_ids: [req], scenario_ids: [], item_ids: [999999] }]), /PBS/);
  assert.throws(() => saveProjectSolutions(id, [], "outdated"), /项目已变化/);
});

test("data pack removal archives products and keeps historical references; new automatic matches cannot use them", () => {
  installed(); const incoming = changePack((p) => { p.products = p.products.filter((p) => p.id !== "LA-C02"); p.boms = p.boms.filter((b) => b.product_ref !== "LA-C02"); });
  importPack(incoming); assert.equal(repo.getProduct("LA-C02").metadata.active, false);
  const config = runtimeConfig(); const ctx = createContext({ ...config, requirements: [], segments: [], products: repo.listProducts() });
  const node = normalizeLeaf({ parent: "3", name: "archived", source: "自研", product_ref: "LA-C02" }, ctx);
  enforceLeaves([node], ctx); assert.equal(node.product_ref, null);
});

test("product-specific sizing rules cannot be attached to unrelated equipment", () => {
  const { id } = projectWithItems();
  assert.throws(() => svc.saveItem(id, null, { parent: "2", name: "错误套用机场数量", source: "外采", product_ref: "LA-E04", sizing_rule: "LA-Q01" }), /不一致/);
});

test("BOM product units must match and project unit mismatches never produce false totals", () => {
  const p = defaultPack(); p.boms.find((b) => b.product_ref === "LA-P07").lines[0].unit = "箱";
  assert.throws(() => validatePack(p), /单位不一致/);
  const { id, item } = projectWithItems();
  svc.saveItem(id, item, { unit: "箱" });
  const current = projectCatalogView(id).preview.products[0];
  assert.ok(current.warnings.some((w) => w.includes("单位"))); assert.ok(current.bom.every((l) => l.total_qty === null));
});

test("professional generation receives solution context and never revives the legacy mock catalogue", async () => {
  const { id, req } = projectWithItems();
  saveProjectSolutions(id, [{ id: "CUSTOM", name: "客户道路专用方案", req_ids: [req], scenario_ids: [], item_ids: repo.listItems(id).map((i) => i.id) }]);
  let prompt = "";
  const llm = { async json({ step, user }) {
    if (step === "pbs") {
      prompt = user;
      return { nodes: [{ parent: "2", name: "H30T热成像载荷", source: "外采", product_ref: "LA-E04", req_ids: [req] }], conflicts: [] };
    }
    return { links: [], new_nodes: [] };
  } };
  await svc.generateProjectPbs(id, { llm, progress: { step() {} } });
  assert.match(prompt, /客户道路专用方案/); assert.doesNotMatch(prompt, /reference_templates|模拟解决方案模板/);
  assert.ok(repo.listItems(id).some((i) => i.product_ref === "LA-E04" && i.source === "外采"));
  assert.ok(repo.listItems(id).every((i) => !/^P\d+$/.test(i.product_ref ?? "")));
});

test("product packs reject solution templates while legacy imports ignore them with an explicit notice", () => {
  installed();
  const pack = defaultPack(); pack.solutions = [{ id: "SHARED", name: "不应入库的方案" }];
  assert.throws(() => validatePack(pack), /属于客户项目/);
  assert.throws(() => saveEntry("solutions", "SHARED", pack.solutions[0], readCatalog().fingerprint), /客户项目/);
  pack.schema_version = 1;
  const plan = previewImport(pack);
  assert.ok(plan.warnings.length); assert.ok(!Object.hasOwn(plan.merged, "solutions"));
  importCatalog({ pack, token: plan.token });
  assert.equal(readCatalog().pack.schema_version, 2); assert.ok(!Object.hasOwn(readCatalog().pack, "solutions"));
});

test("existing catalogues migrate without changing customer combinations or historical snapshots", () => {
  const { id, req, item } = projectWithItems();
  repo.updateProject(id, { pbs_meta: { solution_designs: [{ id: "CUSTOM", name: "人工客户方案", template_id: "OLD", req_ids: [req], scenario_ids: [], item_ids: [item], design_notes: "自定义范围" }] } });
  const snapshot = captureProjectBom(id);
  const legacy = readCatalog().pack; legacy.schema_version = 1; legacy.solutions = [{ id: "OLD", name: "旧库模板" }];
  getDb().prepare("INSERT INTO catalog_revisions(data,reason,created_at) VALUES(?,?,?)").run(JSON.stringify(legacy), "legacy fixture", new Date().toISOString());
  svc.saveProduct("LA-P01", { ...repo.getProduct("LA-P01"), summary: "人工维护的产品能力" });
  // Simulate an old persisted pack again after the product edit.
  getDb().prepare("INSERT INTO catalog_revisions(data,reason,created_at) VALUES(?,?,?)").run(JSON.stringify(legacy), "legacy fixture", new Date().toISOString());
  installed();
  assert.ok(!Object.hasOwn(readCatalog().pack, "solutions"));
  assert.equal(repo.getProduct("LA-P01").summary, "人工维护的产品能力");
  assert.equal(solutionContext(id)[0].name, "人工客户方案");
  assert.ok(!Object.hasOwn(solutionContext(id)[0], "template_id"));
  assert.deepEqual(repo.getProject(id).pbs_meta.catalog_snapshot, snapshot);
  assert.equal(installed().revision, readCatalog().revision);
});

test("each customer freely combines the shared products without changing the product library", () => {
  const a = projectWithItems();
  const b = repo.createProject({ name: "另一客户" }).id;
  const req = svc.addRequirement(b, { text: "现场巡检仅做影像取证", category: "功能" });
  const item = svc.saveItem(b, null, { parent: "2", name: "机动载荷", source: "外采", product_ref: "LA-E04", req_ids: [req], qty: 1 });
  const before = readCatalog().fingerprint;
  saveProjectSolutions(a.id, [{ id: "CUSTOM", name: "道路客户组合", req_ids: [a.req], scenario_ids: [], item_ids: [a.item] }]);
  saveProjectSolutions(b, [{ id: "CUSTOM", name: "机动客户组合", req_ids: [req], scenario_ids: [], item_ids: [item] }]);
  assert.equal(solutionContext(a.id)[0].name, "道路客户组合");
  assert.equal(solutionContext(b)[0].name, "机动客户组合");
  assert.notEqual(captureProjectBom(a.id).solutions[0].products[0].product_ref, captureProjectBom(b).solutions[0].products[0].product_ref);
  assert.equal(readCatalog().fingerprint, before);
});
