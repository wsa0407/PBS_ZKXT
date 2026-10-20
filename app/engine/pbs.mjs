import { usesSingleLicense, DELIVERY_SOURCES as SOURCES } from "./catalog.mjs";
import { NON_DELIVERABLE } from "./requirements.mjs";
import { dice, normalize } from "./text.mjs";

const NODE_FORMAT = `{"code":"1.1","parent":"1","name":"...","spec":"规格或范围说明","source":"自有产品","product_ref":"P01","matched_capabilities":["逐字复制的产品能力"],"blocked_by":null,"evidence_chunks":["K12"],"capability_ids":["C01"],"req_ids":["R003"],"sizing_rule":null,"qty":null,"qty_quote":"","unit":"","history_ref":["H1"],"basis":"..."}`;
const BLOCKED_FORMAT = `{"product_ref":"P02","limit":"逐字复制的产品限制"}`;

const MATCH_RULES = `匹配产品（最重要）。**从场景中的具体要求（或已有业务能力）匹配产品能力，再确定产品**：
a. 先确定这一项服务于哪些“业务能力”（capability_ids，填能力编号如 C01）；再到产品目录里找能满足这些业务能力的“产品能力”；最后才确定产品。已经提供场景时，以场景活动及关联需求为依据，不要求另建业务能力，capability_ids可为空。场景中未明确的条件不可默认满足。
b. 业务能力能被产品目录中某个产品的能力满足时，source 必须采用产品目录的 delivery_source（自有产品、外采、自研或服务），product_ref 填产品 ID，matched_capabilities 逐字复制该产品“能力”中满足需求的条目。
c. 每个用到的目录产品只出一个叶子（产品本身），不要为同一产品的标准能力再拆“部署”“配置”“开发”叶子。
d. 产品“限制”中写明不具备、不包含、需定制的内容，不能算自有产品覆盖。要拆出外采或自研叶子，并在 blocked_by 中写明是哪个产品的哪条限制：${BLOCKED_FORMAT}。
e. 产品目录里没有相关产品时，按实际填外采、自研或服务，blocked_by 填 null。
f. 解决方案由当前客户项目按场景和需求自由组合产品，不存在产品库中的预设方案或固定组合。已提供的项目方案只是本项目草稿，不能扩展为其他客户的需求。组合产品已经包含的BOM组成项不得重复列入PBS报价。标为待研发或待验证的能力必须说明缺口，不可当作现成覆盖。
g. “检索到的产品资料”是从产品库和产品手册中按业务能力和需求检索出的片段，编号形如 K12。叶子的判断用到了哪些片段，就把编号填进 evidence_chunks；没用到就给空数组。`;

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
  return normalizeLeaf({ ...raw, id: leaf.id, code: leaf.code, parent: raw.parent ?? leaf.parent, req_ids: leaf.req_ids, origin: "rematch" }, ctx);
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
