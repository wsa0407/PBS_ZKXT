import { usesSingleLicense } from "./catalog.mjs";
import { NON_DELIVERABLE } from "./extract.mjs";
import { dice, normalize } from "./text.mjs";

export const SOURCES = ["自有产品", "外采", "自研", "服务"];

const NODE_FORMAT = `{"code":"1.1","parent":"1","name":"...","spec":"规格或范围说明","source":"自有产品","product_ref":"P01","matched_capabilities":["逐字复制的产品能力"],"blocked_by":null,"evidence_chunks":["K12"],"capability_ids":["C01"],"req_ids":["R003"],"sizing_rule":null,"qty":null,"qty_quote":"","unit":"","history_ref":["H1"],"basis":"..."}`;
const BLOCKED_FORMAT = `{"product_ref":"P02","limit":"逐字复制的产品限制"}`;
const CONFLICT_FORMAT = `{"product_ref":"P08","req_id":"R030","evidence":"逐字复制的产品限制或信创字段原文","reason":"..."}`;

const MATCH_RULES = `匹配产品（最重要）。**从场景中的具体要求（或已有业务能力）匹配产品能力，再确定产品**：
a. 先确定这一项服务于哪些“业务能力”（capability_ids，填能力编号如 C01）；再到产品目录里找能满足这些业务能力的“产品能力”；最后才确定产品。已经提供场景时，以场景活动及关联需求为依据，不要求另建业务能力，capability_ids可为空。场景中未明确的条件不可默认满足。
b. 业务能力能被产品目录中某个产品的能力满足时，source 必须采用产品目录的 delivery_source（自有产品、外采、自研或服务），product_ref 填产品 ID，matched_capabilities 逐字复制该产品“能力”中满足需求的条目。
c. 每个用到的目录产品只出一个叶子（产品本身），不要为同一产品的标准能力再拆“部署”“配置”“开发”叶子。
d. 产品“限制”中写明不具备、不包含、需定制的内容，不能算自有产品覆盖。要拆出外采或自研叶子，并在 blocked_by 中写明是哪个产品的哪条限制：${BLOCKED_FORMAT}。
e. 产品目录里没有相关产品时，按实际填外采、自研或服务，blocked_by 填 null。
f. 方案模板仅为参考，不是客户确认需求；备选组只选一个，组合产品已经包含的BOM组成项不得重复列入PBS报价。标为待研发或待验证的能力必须说明缺口，不可当作现成覆盖。
g. “检索到的产品资料”是从产品库和产品手册中按业务能力和需求检索出的片段，编号形如 K12。叶子的判断用到了哪些片段，就把编号填进 evidence_chunks；没用到就给空数组。`;

const SYSTEM = `你是资深解决方案架构师，负责把客户需求拆成可报价的产品清单（PBS），并为每一项匹配公司已有产品。

规则：
1. 一级分类只能用模板给出的 code。模板中标注“必须”的分类一定要有叶子。
2. 只输出二级叶子，code 形如 "1.1"，parent 为一级 code。每个叶子必须能单独报价，不要把多件事塞进一个叶子。
3. ${MATCH_RULES}
3a. 每个叶子的 capability_ids 必须来自“业务能力清单”，不得编造。服务、培训、运维等配套项如果不对应具体业务能力，capability_ids 给空数组，并在 basis 中说明配套原因。
4. source 只能取：${SOURCES.join("、")}。
5. req_ids 填该叶子满足的需求 ID。每条“必须”需求（背景、商务、资质、范围外类除外）都要被至少一个叶子覆盖。不要为“范围外”需求建叶子。
6. sizing_rule：可用测算规则中有对应该叶子的规则时填规则 ID，否则填 null。标注“附加授权”的规则要单独成为一个叶子，不能挂在产品本身的叶子上。同一个规则只能用一次。
7. 数量：不要自己估算。挂了测算规则的由规则计算，qty 填 null；原文明确写出数量的填 qty，并在 qty_quote 中逐字引用原文；其余 qty 填 null。
8. conflicts：逐个检查用到的自有产品是否违反硬约束类需求（环境、信创、安全、部署方式、资质许可等）。违反时列出 ${CONFLICT_FORMAT}，evidence 必须逐字复制自该产品的“限制”或“信创”字段。没有就给空数组。
9. history_ref 填参考了的历史项目 ID，没有就空数组。basis 用一句话说明为什么需要这个叶子。

只输出 JSON：
{"nodes":[${NODE_FORMAT}],"conflicts":[${CONFLICT_FORMAT}]}`;

const REPAIR_SYSTEM = `你是资深解决方案架构师。自动检查发现下面这些“必须”需求没有被任何 PBS 叶子承接。

对每条需求二选一：
1. 已有叶子能满足：在 links 中给出 {"req_id","code","reason"}。约束类需求（例如“不得……”“须部署于……”）通常由已有叶子的产品或部署方式满足，优先用 links。
2. 已有叶子都不能满足：在 new_nodes 中新增叶子，req_ids 写上该需求。字段格式与已有叶子一致；parent 只能取模板一级分类的 code；sizing_rule 填 null。
${MATCH_RULES}

只输出 JSON：
{"links":[{"req_id":"R037","code":"1.4","reason":"..."}],"new_nodes":[${NODE_FORMAT}]}`;

const REMATCH_SYSTEM = `你是资深解决方案架构师。用户要求重新判断 PBS 中的一项：它该用哪个自有产品，还是需要外采、自研或服务。

${MATCH_RULES}

规则：
- 保持这一项的范围不变（同样承接这些需求），只重新判断来源、匹配产品和依据。
- 用户给了说明时，优先按说明处理。
- 如果这一项应该由多个产品共同满足，选最主要的一个，并在 basis 中说明。

只输出 JSON：{"node":${NODE_FORMAT}}`;

// ---------- prompt context ----------

/** Retrieved chunks shown to the model, numbered K<chunk id>. */
export function contextText(chunks) {
  if (!chunks.length) return "（无）";
  return chunks
    .map((c) => `K${c.id} [${c.product_id ?? c.history_id ?? "-"}${c.doc_name ? ` · ${c.doc_name}` : ""}] ${c.text}`)
    .join("\n");
}

export function productText(p) {
  const list = (items) => (items.length ? items.map((x) => `\n    - ${x}`).join("") : " 无");
  return `${p.id} ${p.name}（单位：${p.unit}；delivery_source：${p.metadata?.delivery_source ?? "自有产品"}；供给状态：${p.metadata?.availability ?? "未核实"}；数据性质：${p.metadata?.data_kind ?? "旧版目录"}）${p.summary ? "：" + p.summary : ""}\n  能力：${list(p.capabilities)}\n  限制：${list(p.limits)}\n  信创：${p.xinchuang || "未说明"}\n  适配条件：${list(p.metadata?.compatibility ?? [])}\n  交付物：${list(p.metadata?.deliverables ?? [])}`;
}

function reqLine(r) {
  const flags = `${r.star ? "★" : ""}${r.triangle ? "▲" : ""}${r.inferred ? "（推断）" : ""}`;
  return `${r.id} [${r.category}][${r.priority}${flags}] ${r.text}`;
}

export function capabilityText(capabilities) {
  if (!capabilities?.length) return "（本项目还没有生成业务能力，按需求直接判断，capability_ids 给空数组）";
  return capabilities.map((c) => `${c.code} [${c.priority}] ${c.name}（活动：${c.activity}；关联需求：${c.req_ids.join("、")}）${c.description ? " " + c.description : ""}`).join("\n");
}

function templateText(template) {
  return template.level1.map((l) => `${l.code} ${l.name}${l.required ? "（必须）" : ""}：${l.hint}`).join("\n");
}

function rulesText(sizing) {
  return sizing.rules
    .map((r) => `${r.id} ${r.name}（单位：${r.unit}${r.product_ref ? `，对应产品 ${r.product_ref}` : ""}${r.addon ? "，附加授权" : ""}）`)
    .join("\n");
}

// ---------- deterministic enforcement ----------

function findText(claim, options) {
  const c = normalize(claim);
  if (!c) return null;
  return (
    options.find((o) => normalize(o) === c) ??
    options.find((o) => {
      const n = normalize(o);
      return Math.min(n.length, c.length) >= 4 && (n.includes(c) || c.includes(n));
    }) ??
    options.find((o) => dice(o, claim) >= 0.75) ??
    null
  );
}

export function createContext({ requirements, segments, template, products, sizing, history, chunks = [], capabilities = [], scenarios = [] }) {
  return {
    scenarioById: new Map(scenarios.map((s) => [s.code, s])),
    capById: new Map(capabilities.map((c) => [c.code, c])),
    reqById: new Map(requirements.map((r) => [r.id, r])),
    segById: new Map(segments.map((s) => [s.id, s])),
    productById: new Map(products.map((p) => [p.id, p])),
    ruleById: new Map(sizing.rules.map((r) => [r.id, r])),
    historyIds: new Set(history.map((h) => h.id)),
    chunkById: new Map(chunks.map((c) => [Number(c.id), c])),
    level1: new Map(template.level1.map((l) => [l.code, l])),
    issues: [],
    issueKeys: new Set(),
  };
}

function note(ctx, type, message, refs = []) {
  const key = `${type}|${message}`;
  if (ctx.issueKeys.has(key)) return;
  ctx.issueKeys.add(key);
  ctx.issues.push({ type, message, refs });
}

const asList = (value) => (Array.isArray(value) ? value : []);

export function normalizeLeaf(raw, ctx) {
  const parent = String(raw.parent ?? String(raw.code ?? "").split(".")[0]);
  if (!ctx.level1.has(parent)) {
    note(ctx, "生成结果修正", `叶子「${raw.name}」的一级分类 ${parent} 不在模板中，已丢弃`);
    return null;
  }
  const reqIds = [...new Set(asList(raw.req_ids).map(String))];
  const unknown = reqIds.filter((id) => !ctx.reqById.has(id));
  if (unknown.length) note(ctx, "生成结果修正", `叶子「${raw.name}」引用了不存在的需求 ${unknown.join("、")}，已移除`);
  const source = SOURCES.includes(raw.source ?? raw.source_hint) ? raw.source ?? raw.source_hint : "服务";
  const capIds = [...new Set(asList(raw.capability_ids).map(String))];
  const badCaps = ctx.capById.size ? capIds.filter((id) => !ctx.capById.has(id)) : [];
  if (badCaps.length) note(ctx, "生成结果修正", `叶子「${raw.name}」引用了不存在的业务能力 ${badCaps.join("、")}，已移除`);
  return {
    id: raw.id ?? null,
    code: String(raw.code ?? ""),
    parent,
    name: String(raw.name ?? "未命名"),
    spec: String(raw.spec ?? ""),
    source,
    product_ref: raw.product_ref ? String(raw.product_ref) : null,
    matched_capabilities: asList(raw.matched_capabilities).map(String),
    blocked_by: raw.blocked_by && typeof raw.blocked_by === "object" ? { product_ref: String(raw.blocked_by.product_ref ?? ""), limit: String(raw.blocked_by.limit ?? "") } : null,
    evidence_chunks: asList(raw.evidence_chunks),
    capability_ids: ctx.capById.size ? capIds.filter((id) => ctx.capById.has(id)) : capIds,
    scenario_ids: [...(ctx.scenarioById?.values() ?? [])].filter((s) => s.links.some((l) => reqIds.includes(l.req_id))).map((s) => s.code),
    req_ids: reqIds.filter((id) => ctx.reqById.has(id)),
    sizing_rule: raw.sizing_rule ? String(raw.sizing_rule) : null,
    qty: raw.qty === null || raw.qty === undefined || raw.qty === "" ? null : Number(raw.qty),
    qty_quote: String(raw.qty_quote ?? ""),
    unit: String(raw.unit ?? ""),
    manual_qty: Boolean(raw.manual_qty),
    history_ref: asList(raw.history_ref).map(String).filter((id) => ctx.historyIds.has(id)),
    basis: String(raw.basis ?? ""),
    repairs: raw.repairs ?? [],
    origin: raw.origin ?? "model",
    edited: Boolean(raw.edited),
    confirmed: Boolean(raw.confirmed),
    stale: String(raw.stale ?? ""),
  };
}

// Evidence chunks must exist and belong to the product (or blocking product / past project) of this line.
function checkEvidence(leaf, ctx) {
  const owners = new Set([leaf.product_ref, leaf.blocked_by?.product_ref].filter(Boolean));
  const kept = [];
  for (const raw of leaf.evidence_chunks) {
    const id = Number(String(raw).replace(/^K/i, ""));
    const chunk = ctx.chunkById.get(id);
    if (!chunk) {
      if (ctx.chunkById.size) note(ctx, "匹配校验", `「${leaf.name}」引用的资料片段 ${raw} 不在本次检索结果中，已移除`, [leaf.code]);
      continue;
    }
    const ok = chunk.kind === "history" ? true : owners.has(chunk.product_id);
    if (!ok) {
      note(ctx, "匹配校验", `「${leaf.name}」引用的资料片段 K${id} 属于其他产品，已移除`, [leaf.code]);
      continue;
    }
    if (!kept.includes(id)) kept.push(id);
  }
  leaf.evidence_chunks = kept;
}

function checkMatch(leaf, ctx) {
  // A blocker is not the product being delivered; custom gap work must have its own reference.
  if (leaf.product_ref && leaf.blocked_by?.product_ref === leaf.product_ref) leaf.product_ref = null;
  // All delivery sources can reference products and their BOMs.
  let product = leaf.product_ref ? ctx.productById.get(leaf.product_ref) : null;
  if (product?.metadata?.active === false && !leaf.edited && !leaf.reviewed) {
    note(ctx, "匹配校验", `「${product.name}」已归档，不能用于新的自动匹配`, [leaf.code]);
    leaf.product_ref = null; product = null;
  }
  if (leaf.product_ref && !product) {
    note(ctx, "匹配校验", `叶子「${leaf.name}」引用了不存在的产品 ${leaf.product_ref}，已移除`, [leaf.code]);
    leaf.product_ref = null;
  }
  if (leaf.source === "自有产品" && !leaf.product_ref) {
    note(ctx, "匹配校验", `叶子「${leaf.name}」标为自有产品，但没有对应到产品目录，请人工确认`, [leaf.code]);
  }
  // Requirements must not jump straight to a product: a product match needs a business capability behind it.
  if (ctx.capById.size && !ctx.scenarioById?.size && leaf.product_ref && !leaf.capability_ids.length && !leaf.edited && leaf.origin === "model") {
    leaf.unsupported = true;
    note(ctx, "匹配校验", `「${leaf.name}」匹配了产品 ${ctx.productById.get(leaf.product_ref)?.name ?? leaf.product_ref}，但没有任何业务能力支撑，需求不能直接匹配产品，请确认`, [leaf.code]);
  }

  if (product) {
    if (product.metadata?.delivery_source) leaf.source = product.metadata.delivery_source;
    if (product.metadata?.active === false) note(ctx, "匹配校验", `「${product.name}」已归档，请替换或人工复核`, [leaf.code]);
    if (product.metadata?.requires_validation) note(ctx, "匹配校验", `「${product.name}」${product.metadata.availability}，不能视为已交付能力`, [leaf.code]);
    const verified = [];
    for (const claim of leaf.matched_capabilities) {
      const hit = findText(claim, product.capabilities);
      if (hit) verified.push(hit);
      else note(ctx, "匹配校验", `「${leaf.name}」声称的能力「${claim}」不在产品 ${product.name} 的能力清单中，已移除`, [leaf.code]);
    }
    leaf.matched_capabilities = [...new Set(verified)];
  } else {
    leaf.matched_capabilities = [];
  }

  if (leaf.blocked_by) {
    const blocker = ctx.productById.get(leaf.blocked_by.product_ref);
    const hit = blocker ? findText(leaf.blocked_by.limit, blocker.limits) : null;
    if (hit) leaf.blocked_by = { product_ref: blocker.id, product_name: blocker.name, limit: hit };
    else {
      if (leaf.blocked_by.limit) {
        note(ctx, "匹配校验", `「${leaf.name}」引用的产品限制「${leaf.blocked_by.limit}」在产品目录中找不到，已移除`, [leaf.code]);
      }
      leaf.blocked_by = null;
    }
  }
}

function isBaseLeaf(leaf, ctx) {
  if (!leaf.product_ref) return false;
  const rule = leaf.sizing_rule ? ctx.ruleById.get(leaf.sizing_rule) : null;
  return !rule || !rule.addon;
}

function blankLeaf(fields) {
  return {
    id: null,
    code: "",
    spec: "",
    product_ref: null,
    matched_capabilities: [],
    blocked_by: null,
    evidence_chunks: [],
    capability_ids: [],
    req_ids: [],
    sizing_rule: null,
    qty: null,
    qty_quote: "",
    manual_qty: false,
    history_ref: [],
    repairs: [],
    edited: false,
    ...fields,
  };
}

function ruleLeaf(rule, ctx, basis, origin = "rule") {
  const product = rule.product_ref ? ctx.productById.get(rule.product_ref) : null;
  return blankLeaf({
    parent: rule.category && ctx.level1.has(rule.category) ? rule.category : "5",
    name: rule.name,
    spec: rule.note ?? "",
    source: rule.source ?? "服务",
    product_ref: product?.id ?? null,
    sizing_rule: rule.id,
    unit: rule.unit,
    basis,
    origin,
  });
}

function baseLeaf(product, basis, ctx) {
  return blankLeaf({
    parent: [...ctx.level1.values()].find((l) => l.license)?.code ?? "1",
    name: product.name,
    spec: product.summary ?? "",
    source: product.metadata?.delivery_source ?? "自有产品",
    product_ref: product.id,
    unit: product.unit,
    basis,
    origin: "rule",
  });
}

function quoteSupportsQty(leaf, ctx, fullText) {
  if (!leaf.qty_quote || !Number.isFinite(leaf.qty)) return false;
  const quote = normalize(leaf.qty_quote);
  if (!quote.includes(String(leaf.qty))) return false;
  const sources = leaf.req_ids.map((id) => ctx.segById.get(ctx.reqById.get(id)?.seg_id)?.text ?? "");
  return [...sources, fullText].some((text) => normalize(text).includes(quote));
}

/**
 * Rules the model is told about but cannot be trusted to follow. Idempotent: safe to run
 * again after leaves are added by rules, by the coverage repair or by a rematch.
 * Lines a person has edited keep their structure; a manually set quantity is never overwritten.
 */
export function enforceLeaves(leaves, ctx, fullText = "") {
  for (const leaf of leaves) {
    checkMatch(leaf, ctx);
    if (!leaf.edited) checkEvidence(leaf, ctx);
    const linkedRule = ctx.ruleById.get(leaf.sizing_rule);
    if (linkedRule?.strict_product && linkedRule.product_ref !== leaf.product_ref) {
      note(ctx, "测算规则校验", `「${leaf.name}」的规则不属于所选产品，已移除`, [leaf.code]);
      leaf.sizing_rule = null;
    }
    if (leaf.sizing_rule && !ctx.ruleById.has(leaf.sizing_rule)) {
      note(ctx, "生成结果修正", `「${leaf.name}」引用了不存在的测算规则 ${leaf.sizing_rule}，已移除`, [leaf.code]);
      leaf.sizing_rule = null;
    }
  }

  // Add-on licences (expansion, per-channel) must be their own line, never the product line itself.
  const byProduct = new Map();
  for (const leaf of leaves.filter((l) => l.product_ref)) byProduct.set(leaf.product_ref, [...(byProduct.get(leaf.product_ref) ?? []), leaf]);
  for (const leaf of [...leaves]) {
    const rule = leaf.sizing_rule ? ctx.ruleById.get(leaf.sizing_rule) : null;
    if (leaf.edited || !rule?.addon || !leaf.product_ref) continue;
    const group = byProduct.get(leaf.product_ref) ?? [];
    if (group.some((other) => other !== leaf && isBaseLeaf(other, ctx))) continue;
    leaf.sizing_rule = null;
    const split = ruleLeaf(rule, ctx, `从「${leaf.name}」中拆出：附加授权单独计量，产品本身按 1 ${ctx.productById.get(leaf.product_ref)?.unit ?? "套"} 计`, "split");
    leaves.push(split);
    note(ctx, "生成结果修正", `测算规则 ${rule.id}（${rule.name}）原本挂在产品「${leaf.name}」上，会把产品数量算成授权数量，已拆成单独一项`, [leaf.code]);
  }

  // Every add-on licence needs the product it extends.
  for (const leaf of [...leaves]) {
    const rule = leaf.sizing_rule ? ctx.ruleById.get(leaf.sizing_rule) : null;
    if (!rule?.addon || !rule.product_ref) continue;
    const product = ctx.productById.get(rule.product_ref);
    if (!product || leaves.some((l) => l.product_ref === product.id && isBaseLeaf(l, ctx))) continue;
    leaves.push(baseLeaf(product, `「${leaf.name}」是 ${product.name} 的附加授权，需要同时提供产品本身`, ctx));
  }

  // One sizing rule, one line. Prefer an edited line, then the rule's own product, then the closest name.
  const byRule = new Map();
  for (const leaf of leaves.filter((l) => l.sizing_rule)) byRule.set(leaf.sizing_rule, [...(byRule.get(leaf.sizing_rule) ?? []), leaf]);
  for (const [ruleId, group] of byRule) {
    if (group.length < 2) continue;
    const rule = ctx.ruleById.get(ruleId);
    const keep =
      group.find((l) => l.edited) ??
      group.find((l) => rule.product_ref && l.product_ref === rule.product_ref && !rule.addon) ??
      [...group].sort((a, b) => dice(b.name, rule.name) - dice(a.name, rule.name))[0];
    for (const leaf of group) {
      if (leaf === keep || leaf.edited) continue;
      leaf.sizing_rule = null;
      note(ctx, "生成结果修正", `测算规则 ${ruleId} 同时挂在多个叶子上会重复计量，只保留在「${keep.name}」上，「${leaf.name}」已移除该规则`, [leaf.code, keep.code]);
    }
  }

  // Product lines whose quantity is governed by a rule (e.g. docks, drones) pick that rule up.
  const used = new Set(leaves.map((l) => l.sizing_rule).filter(Boolean));
  for (const leaf of leaves) {
    if (leaf.edited || leaf.sizing_rule || !leaf.product_ref) continue;
    const rule = [...ctx.ruleById.values()].find((r) => r.product_ref === leaf.product_ref && !r.addon && !used.has(r.id));
    if (rule) {
      leaf.sizing_rule = rule.id;
      used.add(rule.id);
    }
  }

  // Quantities: a person's number wins; then rules; product licences are 1; anything else needs a quote.
  for (const leaf of leaves) {
    if (leaf.manual_qty && Number.isFinite(leaf.qty)) {
      leaf.qtyBasis = "人工确认";
      continue;
    }
    leaf.manual_qty = false;
    if (leaf.sizing_rule) {
      leaf.qtyBasis = "测算规则";
      continue;
    }
    const product = leaf.product_ref ? ctx.productById.get(leaf.product_ref) : null;
    if (leaf.qty !== null && quoteSupportsQty(leaf, ctx, fullText)) {
      leaf.qtyBasis = "原文数量";
      continue;
    }
    if (product && usesSingleLicense(product)) {
      leaf.qty = 1;
      leaf.unit = product.unit;
      leaf.qtyBasis = "产品许可";
      continue;
    }
    if (leaf.qty !== null) {
      note(ctx, "数量校验", `「${leaf.name}」的数量 ${leaf.qty}${leaf.unit} 没有原文或规则依据，已改为待估`, [leaf.code]);
    }
    leaf.qty = null;
    leaf.qtyBasis = "待估";
    if (product && !leaf.unit) leaf.unit = product.unit;
  }
  return leaves;
}

function nextCode(leaves, parent) {
  const used = leaves.filter((l) => l.parent === parent).map((l) => Number(String(l.code).split(".")[1]) || 0);
  return `${parent}.${Math.max(0, ...used) + 1}`;
}

// Keep model codes when they are valid and unique; give everything else the next free code.
export function assignCodes(leaves) {
  const seen = new Set();
  for (const leaf of leaves) {
    const valid = new RegExp(`^${leaf.parent}\\.\\d+$`).test(leaf.code) && !seen.has(leaf.code);
    if (!valid) leaf.code = "";
    else seen.add(leaf.code);
  }
  for (const leaf of leaves) if (!leaf.code) leaf.code = nextCode(leaves, leaf.parent);
  leaves.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return leaves;
}

export function checkConflicts(raw, leaves, ctx) {
  const used = new Set(leaves.filter((l) => l.product_ref).map((l) => l.product_ref));
  const conflicts = [];
  for (const c of raw ?? []) {
    const product = ctx.productById.get(String(c.product_ref));
    const req = ctx.reqById.get(String(c.req_id));
    if (!product || !req || !used.has(product.id)) continue;
    const evidence = findText(c.evidence, [...product.limits, product.xinchuang].filter(Boolean));
    if (!evidence) {
      note(ctx, "匹配校验", `模型认为 ${product.name} 不满足 ${req.id}，但给出的依据「${c.evidence}」不在产品资料中，已忽略`, [req.id]);
      continue;
    }
    if (conflicts.some((x) => x.product_ref === product.id && x.req_id === req.id)) continue;
    conflicts.push({ product_ref: product.id, product_name: product.name, req_id: req.id, evidence, reason: String(c.reason ?? "") });
  }
  return conflicts;
}

// ---------- model steps ----------

function historyText(similar) {
  return similar
    .filter((p) => p.selected)
    .map((p) => `${p.id} ${p.name}（${p.industry}，${p.year}，${p.amount_wan} 万）\n${p.pbs.map((i) => `  - [${i.category}] ${i.name} ${i.qty}${i.unit}（${i.source}）`).join("\n")}\n  经验：${p.lessons}`)
    .join("\n");
}

/**
 * candidates: products to show in full (chosen by retrieval); chunks: retrieved product/manual
 * passages (numbered K<id>); kept: lines a person edited, which the model must not duplicate.
 */
export async function generatePbs({ doc, requirements, template, candidates, chunks = [], similar, sizing, kept = [], capabilities = [], scenarioContext = null, llm }) {
  const reqList = requirements.filter((r) => !NON_DELIVERABLE.has(r.category)).map(reqLine).join("\n");
  const keptText = kept.length
    ? `\n\n已由人工确认的项（保留不变，不要重复输出，但可以在 req_ids 覆盖检查时视为已承接）：\n${kept.map((l) => `- ${l.code} ${l.name}（${l.source}${l.product_ref ? " " + l.product_ref : ""}）承接 ${l.req_ids.join("、") || "无"}`).join("\n")}`
    : "";

  const user = `场景性需求、适用约束及未解决事项：
${scenarioContext ? JSON.stringify(scenarioContext) : "尚未建立场景，生成兼容草稿并保留复核"}
场景中的业务活动是产品能力匹配的需求依据，不必另建独立业务能力。按场景具体要求匹配真实产品能力；未明确的条件保持待确认，禁止默认满足、默认接口开放或生成未知数量。范围外、背景和商务资质不能转成采购项。已知约束和服务仍需响应。

项目：${doc.title || "（未命名）"}

PBS 模板一级分类：
${templateText(template)}

产品目录（按需求检索出的候选产品）：
${candidates.map(productText).join("\n")}

检索到的产品资料：
${contextText(chunks)}

相似历史项目：
${historyText(similar) || "（无）"}

可用测算规则：
${rulesText(sizing)}

业务能力清单（先确定服务于哪些能力，再匹配产品能力和产品）：
${capabilityText(capabilities)}

需求清单（用于追溯原文，每个叶子仍需填写承接的需求）：
${reqList}${keptText}`;

  const data = await llm.json({ step: "pbs", system: SYSTEM, user, maxTokens: 12000 });
  return { nodes: data.nodes ?? [], conflicts: data.conflicts ?? [] };
}

export async function repairCoverage({ leaves, uncovered, template, candidates, chunks = [], capabilities = [], scenarioContext = null, llm, ctx }) {
  const scenarioNote = scenarioContext ? `场景、约束与待确认事项：${JSON.stringify(scenarioContext)}\n未知内容不得默认满足。` : "";
  const leafList = leaves
    .map((l) => `${l.code} ${l.name}（${l.source}${l.product_ref ? " " + l.product_ref : ""}）${l.spec ? "：" + l.spec : ""}`)
    .join("\n");
  const user = `${scenarioNote}
PBS 模板一级分类：
${templateText(template)}

已有叶子：
${leafList}

产品目录：
${candidates.map(productText).join("\n")}

检索到的产品资料：
${contextText(chunks)}

业务能力清单：
${capabilityText(capabilities)}

未被承接的需求：
${uncovered.map(reqLine).join("\n")}`;
  const data = await llm.json({ step: "repair", system: REPAIR_SYSTEM, user, maxTokens: 5000 });

  const repairs = [];
  const byCode = new Map(leaves.map((l) => [l.code, l]));
  const target = new Set(uncovered.map((r) => r.id));
  for (const link of data.links ?? []) {
    const leaf = byCode.get(String(link.code));
    if (!leaf || !target.has(link.req_id)) continue;
    if (leaf.edited || leaf.confirmed || leaf.reviewed) {
      note(ctx, "人工关联待复核", `${link.req_id} 建议关联人工处理过的 ${leaf.code}，请人工核对后关联`, [link.req_id, leaf.code]);
      continue;
    }
    if (!leaf.req_ids.includes(link.req_id)) leaf.req_ids.push(link.req_id);
    leaf.repairs.push(link.req_id);
    repairs.push({ target: link.req_id, code: leaf.code, action: "关联到已有项", reason: String(link.reason ?? ""), refs: [link.req_id, leaf.code] });
  }
  for (const raw of data.new_nodes ?? []) {
    const leaf = normalizeLeaf({ ...raw, code: "", sizing_rule: null, origin: "repair" }, ctx);
    if (!leaf) continue;
    leaf.repairs = leaf.req_ids.filter((id) => target.has(id));
    leaf.code = nextCode(leaves, leaf.parent);
    leaves.push(leaf);
    repairs.push({ target: leaf.repairs.join("、"), code: leaf.code, action: "新增项", reason: leaf.basis, refs: [...leaf.req_ids, leaf.code] });
  }
  return repairs;
}

/** Re-decide source / product for one line. Returns a normalised leaf; the caller enforces and saves it. */
export async function rematchLeaf({ leaf, requirements, template, candidates, chunks = [], capabilities = [], sizing, instruction = "", llm, ctx }) {
  const reqs = leaf.req_ids.map((id) => requirements.find((r) => r.id === id)).filter(Boolean);
  const user = `当前场景需求：${JSON.stringify([...(ctx.scenarioById?.values() ?? [])])}
PBS 模板一级分类：
${templateText(template)}

当前这一项：${leaf.code} ${leaf.name}（${leaf.source}${leaf.product_ref ? " " + leaf.product_ref : ""}）${leaf.spec ? "：" + leaf.spec : ""}
这一项当前服务的业务能力：
${capabilityText(capabilities.filter((c) => leaf.capability_ids?.includes(c.code)))}
全部业务能力：
${capabilityText(capabilities)}
承接的需求：
${reqs.map(reqLine).join("\n") || "（无）"}
${instruction ? `\n用户说明：${instruction}\n` : ""}
产品目录（检索出的候选产品）：
${candidates.map(productText).join("\n")}

检索到的产品资料：
${contextText(chunks)}

可用测算规则：
${rulesText(sizing)}`;
  const data = await llm.json({ step: "rematch", system: REMATCH_SYSTEM, user, maxTokens: 2500 });
  const raw = data.node ?? data;
  return normalizeLeaf({ ...raw, id: leaf.id, code: leaf.code, parent: raw.parent ?? leaf.parent, req_ids: raw.req_ids?.length ? raw.req_ids : leaf.req_ids, origin: "rematch" }, ctx);
}

export function addRuleLeaves({ leaves, missing, ctx }) {
  const repairs = [];
  for (const { rule, reason } of missing) {
    // A product line already exists for this rule's product: attach the rule instead of adding a line.
    const owner = !rule.addon && rule.product_ref ? leaves.find((l) => l.product_ref === rule.product_ref && !l.sizing_rule && !l.edited) : null;
    if (owner) {
      owner.sizing_rule = rule.id;
      continue;
    }
    const leaf = ruleLeaf(rule, ctx, `${reason}，按测算规则 ${rule.id} 补充`);
    leaf.code = nextCode(leaves, leaf.parent);
    leaf.repairs = [rule.id];
    leaves.push(leaf);
    repairs.push({ target: `${rule.id}（${rule.name}）`, code: leaf.code, action: "按规则新增项", reason, refs: [leaf.code] });
  }
  return repairs;
}

export function findUncovered(requirements, leaves) {
  const covered = new Set(leaves.flatMap((l) => l.req_ids));
  return requirements.filter((r) => r.priority === "必须" && !NON_DELIVERABLE.has(r.category) && !covered.has(r.id));
}

// Why does this line exist?
export function basisLevel(leaf, reqById) {
  const reqs = leaf.req_ids.map((id) => reqById.get(id)).filter(Boolean);
  if (leaf.edited) return "人工确认";
  if (reqs.some((r) => r.quoteVerified && !r.inferred)) return "原文明确";
  if (reqs.some((r) => r.origin === "澄清答复" || r.origin === "人工")) return "人工补充";
  if (reqs.some((r) => r.inferred)) return "推断需求";
  if (leaf.origin === "rule" || leaf.origin === "split") return "规则补充";
  if (leaf.history_ref.length) return "历史案例";
  return "模型推断";
}

// How was the source decided?
export function matchOf(leaf, productById) {
  if (leaf.product_ref && leaf.matched_capabilities.length) {
    return { type: "能力匹配", product_ref: leaf.product_ref, product_name: productById.get(leaf.product_ref)?.name, capabilities: leaf.matched_capabilities };
  }
  if (leaf.product_ref) return { type: "产品项", product_ref: leaf.product_ref, product_name: productById.get(leaf.product_ref)?.name, capabilities: [] };
  if (leaf.blocked_by) return { type: "限制拆出", ...leaf.blocked_by };
  return null;
}
