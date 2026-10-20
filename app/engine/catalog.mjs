// Domain-neutral catalogue contract. Industry content lives in JSON data packs.
import { createHash } from "node:crypto";

export const DELIVERY_SOURCES = ["自有产品", "外采", "自研", "服务"];
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const digest = (data) => createHash("sha256").update(JSON.stringify(canonical(data)) ?? "undefined").digest("hex");
const fail = (message) => { throw new Error(`目录校验：${message}`); };
const text = (v, label) => { if (typeof v !== "string" || !v.trim()) fail(`${label}不能为空`); };
const list = (v, label) => { if (!Array.isArray(v)) fail(`${label}必须为数组`); };
const unique = (items, label) => {
  list(items, label);
  const ids = new Set();
  for (const row of items) {
    if (!row || typeof row !== "object") fail(`${label}条目不正确`);
    text(row.id, `${label}编号`);
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(row.id) || ids.has(row.id)) fail(`${label}编号无效或重复：${row.id}`);
    ids.add(row.id);
  }
  return ids;
};
const qty = (v, label) => { if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) fail(`${label}必须为非负数或 null（待确认）`); };
const strings = (v, label) => { list(v, label); for (const s of v) text(s, label); };

export function validatePack(input) {
  if (!input || ![1, 2].includes(input.schema_version)) fail("仅支持 schema_version=1/2");
  if (input.schema_version === 2 && Object.hasOwn(input, "solutions")) fail("解决方案属于客户项目，不能存入产品库数据包");
  const pack = structuredClone(input);
  pack.schema_version = 2;
  delete pack.solutions; // Legacy v1 templates are ignored; project solutions remain untouched.
  text(pack.id, "数据包编号"); text(pack.version, "数据包版本"); text(pack.name, "数据包名称");
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(pack.id)) fail("数据包编号格式错误");
  const refs = unique(pack.references, "资料来源");
  for (const r of pack.references) {
    text(r.title, "资料标题");
    if (!/^https:\/\//.test(r.url)) fail("资料来源须为 HTTPS 链接");
    text(r.checked_at, "核对日期");
  }
  const checkRefs = (ids = []) => { strings(ids, "来源编号"); for (const id of ids) if (!refs.has(id)) fail(`来源不存在：${id}`); };
  const products = unique(pack.products, "产品");
  const names = new Set();
  for (const p of pack.products) {
    text(p.name, "产品名称"); text(p.unit, "产品单位"); text(p.summary, "产品简介");
    if (names.has(p.name)) fail(`产品名称重复：${p.name}`);
    names.add(p.name);
    strings(p.capabilities, "产品能力"); strings(p.limits, "产品限制");
    const m = p.metadata;
    if (!m || !DELIVERY_SOURCES.includes(m.delivery_source)) fail(`${p.id} 产品来源错误`);
    for (const key of ["kind", "availability", "data_kind"]) text(m[key], `${p.id}.${key}`);
    if (!["unknown", "single_license"].includes(m.quantity_policy)) fail(`${p.id} 数量策略错误`);
    if (m.quantity_policy === "single_license" && m.kind !== "软件") fail(`${p.id} 只有软件可使用单套许可策略`);
    if (m.requires_validation !== undefined && typeof m.requires_validation !== "boolean") fail("专项验证标记须为布尔值");
    if (typeof m.active !== "boolean") fail(`${p.id} active 必须为布尔值`);
    strings(m.compatibility, "产品适配条件"); strings(m.deliverables, "产品交付物"); checkRefs(m.reference_ids);
  }
  unique(pack.boms, "BOM");
  const byProduct = new Map();
  for (const bom of pack.boms) {
    if (!products.has(bom.product_ref) || byProduct.has(bom.product_ref)) fail(`BOM 产品不存在或重复：${bom.product_ref}`);
    text(bom.version, "BOM版本"); text(bom.basis, "BOM依据");
    if (!["模拟产品组成", "模拟交付配置"].includes(bom.kind)) fail("BOM类型错误");
    const product = pack.products.find((p) => p.id === bom.product_ref);
    if (product.metadata.data_kind === "厂商公开参考" && bom.kind !== "模拟交付配置") fail("厂商参考产品只能维护模拟交付配置，不能声称制造BOM");
    unique(bom.lines, "BOM行");
    for (const line of bom.lines) {
      text(line.name, "组成项名称"); text(line.unit, "组成项单位");
      qty(line.qty, "单产品用量");
      if (typeof line.optional !== "boolean") fail("BOM可选标记须为布尔值");
      if (line.optional) text(line.condition, "可选条件");
      if (!DELIVERY_SOURCES.includes(line.source)) fail("BOM组成项来源错误");
      if (line.product_ref && !products.has(line.product_ref)) fail(`BOM引用不存在产品：${line.product_ref}`);
      if (line.product_ref && line.unit !== pack.products.find((p) => p.id === line.product_ref).unit) fail(`BOM关联产品单位不一致：${line.product_ref}`);
    }
    byProduct.set(bom.product_ref, bom);
  }
  const visit = (id, path) => {
    if (path.includes(id)) fail(`BOM循环引用：${[...path, id].join(" → ")}`);
    for (const line of byProduct.get(id)?.lines ?? []) if (line.product_ref) visit(line.product_ref, [...path, id]);
  };
  for (const id of byProduct.keys()) visit(id, []);
  if (!pack.sizing || typeof pack.sizing.params !== "object" || Array.isArray(pack.sizing.params)) fail("缺少测算参数定义");
  for (const [key, p] of Object.entries(pack.sizing.params)) {
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(key) || ["constructor", "prototype"].includes(key)) fail("参数编号格式错误");
    text(p.label, "参数名称"); text(p.unit, "参数单位");
    if (p.units !== undefined) strings(p.units, "参数单位别名");
    if (p.keywords !== undefined) strings(p.keywords, "参数关键词");
    if (p.derive !== undefined || p.default !== undefined) fail("数据包参数不支持隐式推导或默认值");
  }
  unique(pack.sizing.rules, "测算规则");
  for (const r of pack.sizing.rules) {
    if (!products.has(r.product_ref) || !Object.hasOwn(pack.sizing.params, r.param)) fail("测算规则的产品或参数不存在");
    text(r.name, "测算规则名称"); text(r.unit, "测算规则单位");
  }
  return pack;
}

/** Quantity unknown is contagious. BOM is composition, never an additional quote line. */
export function expandBom(pack, productId, quantity, { includeOptional = false } = {}) {
  const products = new Map(pack.products.map((p) => [p.id, p]));
  const boms = new Map(pack.boms.map((b) => [b.product_ref, b]));
  const rows = [];
  const walk = (id, count, path) => {
    if (path.includes(id)) fail("BOM循环引用");
    const bom = boms.get(id);
    if (!bom) return;
    for (const line of bom.lines) {
      const included = !line.optional || includeOptional;
      const total = included && count !== null && line.qty !== null ? Math.round(count * line.qty * 1e6) / 1e6 : null;
      const row = { ...line, level: path.length, has_children: Boolean(included && line.product_ref && boms.has(line.product_ref)), parent_product: id, bom_id: bom.id, bom_version: bom.version, bom_kind: bom.kind, path: [...path, id, line.id].join("/"), per_product_qty: line.qty, total_qty: total, included, product_name: products.get(line.product_ref)?.name ?? null };
      rows.push(row);
      if (included && line.product_ref) walk(line.product_ref, total, [...path, id]);
    }
  };
  walk(productId, quantity ?? null, []);
  return rows;
}

export const usesSingleLicense = (p) => p?.metadata?.quantity_policy === "single_license" || (!p?.metadata?.quantity_policy && p?.unit === "套");
