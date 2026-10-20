import { NON_DELIVERABLE } from "./extract.mjs";
import { findUncovered } from "./pbs.mjs";
import { CONFIRMED, missingRules } from "./sizing.mjs";

export function runAudit({ doc, requirements, missedSegments, leaves, template, resolved, sizing, issues, repairs, conflicts }) {
  const findings = [];
  const add = (level, type, message, refs = []) => findings.push({ level, type, message, refs });

  for (const c of conflicts) {
    const req = requirements.find((r) => r.id === c.req_id);
    const hard = req?.star || req?.triangle || req?.priority === "必须";
    add(hard ? "阻断" : "警告", "约束冲突", `${c.product_name} 不满足 ${c.req_id}「${req?.text ?? ""}」：产品资料写明「${c.evidence}」。${c.reason}`, [c.req_id, ...leaves.filter((l) => l.product_ref === c.product_ref).map((l) => l.code)]);
  }

  for (const req of findUncovered(requirements, leaves)) {
    add(req.star || req.triangle ? "阻断" : "警告", "必须需求未覆盖", `${req.id}「${req.text}」没有任何 PBS 项承接`, [req.id]);
  }

  const present = new Set(leaves.map((l) => l.parent));
  for (const group of template.level1.filter((l) => l.required)) {
    if (!present.has(group.code)) add("警告", "模板必备分类缺失", `一级分类「${group.code} ${group.name}」没有任何项`);
  }

  for (const param of Object.values(resolved)) {
    if (CONFIRMED.has(param.status) || param.status === "缺失") continue;
    const used = leaves.some((l) => l.sizing?.inputs?.some((i) => i.name === param.name));
    if (!used) continue;
    const detail = param.status === "按规则推算" ? `按 ${param.derivedFrom} 推算为 ${param.value}（${param.note}）` : `当前取值 ${param.value}`;
    add("警告", "测算参数待确认", `「${param.label}」${param.status}：${detail}`, param.candidates.map((c) => c.req_id));
  }

  for (const leaf of leaves) {
    if (leaf.sizing?.error) add("警告", "测算缺参数", `「${leaf.code} ${leaf.name}」${leaf.sizing.error}，数量待估`, [leaf.code]);
  }

  for (const { rule, reason } of missingRules(doc.fullText, resolved, sizing, leaves)) {
    add("警告", "疑似漏项", `${reason}，但 PBS 中没有使用测算规则 ${rule.id}（${rule.name}）的项`);
  }

  for (const id of missedSegments) add("提示", "片段未抽取", `原文片段 ${id} 没有抽取出任何需求，请人工检查`);

  for (const req of requirements.filter((r) => !r.quoteVerified)) {
    add("提示", "原文引用未通过校验", `${req.id} 的引用在原文片段 ${req.seg_id} 中找不到，可能是模型改写`, [req.id]);
  }

  for (const req of requirements) {
    for (const p of req.rejectedParams) {
      add("提示", "参数被规则拦截", `模型从 ${req.seg_id} 抽取「${p.label}=${p.value}」（引用：${p.quote ?? "无"}），${p.reason}，未用于测算`, [req.id]);
    }
  }

  for (const r of repairs) add("提示", "自动补漏", `${r.target} 在初稿中遗漏，已${r.action}「${r.code}」：${r.reason}`, r.refs);
  for (const issue of issues) add("提示", issue.type, issue.message, issue.refs);

  for (const leaf of leaves.filter((l) => l.qty === null && !l.sizing?.error)) {
    add("提示", "数量待估", `「${leaf.code} ${leaf.name}」没有规则或原文数量，需要人工估算`, [leaf.code]);
  }

  const stars = requirements.filter((r) => r.star);
  const starSegs = doc.segments.filter((s) => s.star);
  for (const seg of starSegs.filter((s) => !stars.some((r) => r.seg_id === s.id))) {
    add("阻断", "★ 条款未抽取", `★ 条款 ${seg.id}「${seg.text.slice(0, 40)}」没有抽取出需求，请人工补充`);
  }
  if (starSegs.length) {
    add("提示", "废标条款", `共 ${starSegs.length} 条 ★ 条款，任一未响应即无效投标，已全部列入必审`, stars.map((r) => r.id));
  }

  const order = { 阻断: 0, 警告: 1, 提示: 2 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

export function assignReviewTiers({ requirements, leaves, findings }) {
  const flagged = new Set(findings.filter((f) => f.level !== "提示").flatMap((f) => f.refs));
  for (const req of requirements) {
    if (req.star || req.triangle || !req.quoteVerified || flagged.has(req.id)) req.review = "必审";
    else if (req.inferred || req.priority === "必须" || req.params.length || req.rejectedParams.length) req.review = "抽检";
    else req.review = "批量确认";
    if (NON_DELIVERABLE.has(req.category) && req.review === "抽检" && !req.star) req.review = "批量确认";
  }
  for (const leaf of leaves) {
    const costly = leaf.source === "外采" || leaf.source === "自研";
    if (flagged.has(leaf.code) || leaf.sizing?.uncertain || leaf.basis_level === "模型推断" || (costly && leaf.qty === null)) leaf.review = "必审";
    else if (leaf.repairs.length || leaf.basis_level !== "原文明确" || leaf.qty === null || !leaf.match) leaf.review = "抽检";
    else leaf.review = "批量确认";
  }
}
