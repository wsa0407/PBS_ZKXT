// Pure business presentation shared by the workspace and Excel export.
// Persisted enums remain compatible with existing projects.
export const REVIEW_LABELS = { 必审: "重点核对", 抽检: "建议复查", 批量确认: "常规核对" };
export const REVIEW_HELP = {
  必审: "包含重点标记、引用待核对或检查发现的问题，建议逐条核对。",
  抽检: "包含推断、数量参数或必须要求等内容，建议复查原文与理解。",
  批量确认: "当前规则未发现重点核对项；仍需人工审阅，不代表已确认正确。",
};
export const reviewLabel = (value) => REVIEW_LABELS[value] ?? value;
export const questionStatusLabel = (value) => ({ 已答复: "答复待采纳", 已应用: "已处理", 已忽略: "暂不处理" })[value] ?? value;
export const auditLevelLabel = (value) => ({ 阻断: "优先处理", 警告: "需要核对", 提示: "核对提示" })[value] ?? value;
export const requirementStatusLabel = (value) => ({ 已确认: "描述已确认", 待确认: "描述待审阅" })[value] ?? value;
export const originLabel = (value) => ({ Agent分析: "助手分析", 系统: "助手整理" })[value] ?? value;
export const impactLabel = (value) => value === "影响废标风险" ? "影响投标响应" : value;

export function projectStage(project) {
  if (project.done) return { label: "本轮已完成", type: "success" };
  if (project.pbs_items) return { label: "PBS 编制", type: "primary" };
  if (project.requirements) return { label: "需求理解", type: "warning" };
  if (project.materials) return { label: "待理解材料", type: "warning" };
  return { label: "待添加材料", type: "info" };
}

/** A navigation button must resolve to existing data or a relevant workspace. */
export function findingTarget(view, finding) {
  for (const ref of finding.refs ?? []) {
    const item = view.items.find(i => i.code === ref || `pbs:${i.id}` === ref);
    if (item) return { tab: "pbs", focus: item.id, label: "查看 PBS 项" };
    if (view.requirements.some(r => r.code === ref)) return { tab: "requirements", focus: ref, label: "查看需求" };
    if (view.scenarios?.some(s => s.code === ref)) return { tab: "scenarios", focus: ref, label: "查看场景" };
    const question = view.questions?.find(q => `Q${q.id}` === ref);
    if (question) return { tab: "questions", focus: question.id, label: "查看问题记录" };
    if ([...(view.segments ?? []), ...(view.sourceSnapshots ?? [])].some(s => s.uid === ref)) return { tab: "materials", focus: ref, label: "查看原文" };
  }
  if (/条款|片段/.test(finding.type)) return { tab: "materials", label: "核对材料" };
  if (/参数/.test(finding.type)) return { tab: "requirements", label: "核对测算参数" };
  if (/PBS|漏项/.test(finding.type)) return { tab: "pbs", label: "核对 PBS" };
  return null;
}

/** A review checklist, not a claim of compliance or customer acceptance. */
export function exportReview(view) {
  const s = view.steps;
  const uncertain = view.items.filter((i) => i.qty !== null && i.qty !== undefined && !i.manual_qty && i.sizing?.uncertain).length;
  const quotesPending = view.requirements.filter((r) => r.status !== "已删除" && r.seg_uid && !r.quote_verified).length;
  const checks = [
    { key: "materials", label: "材料处理", count: s.materials.pending, tab: "materials", text: `${s.materials.pending} 份材料仍有原文待处理` },
    { key: "requirements", label: "需求描述", count: s.requirements.pending, tab: "requirements", text: `${s.requirements.confirmed} / ${s.requirements.total} 条描述已确认，${s.requirements.pending} 条待审阅` },
    { key: "quotes", label: "需求原文引用", count: quotesPending, tab: "requirements", text: quotesPending ? `${quotesPending} 条需求的原文引用待核对` : "已关联原文的需求引用可定位；人工来源说明和引用是否支持需求仍需审阅" },
    { key: "scenarios", label: "场景与要求归类", count: s.scenarios.pending + s.scenarios.unmapped.length, tab: "scenarios", text: `${s.scenarios.pending} 个场景待确认或复核，${s.scenarios.unmapped.length} 条需求待归类` },
    { key: "questions", label: "澄清处理", count: s.questions.open + s.questions.answered, tab: "questions", text: `${s.questions.open} 项待处理，${s.questions.answered} 项客户答复待采纳` },
    { key: "coverage", label: "需求与 PBS 对应", count: s.pbs.uncovered, tab: "pbs", text: s.pbs.uncovered ? `${s.pbs.uncovered} 条必须需求尚未关联 PBS 项` : "每条必须需求均已关联 PBS 项，是否满足要求仍需核对选型依据" },
    { key: "pbs", label: "PBS 项审阅", count: view.items.filter((i) => !i.confirmed || i.stale).length, tab: "pbs", text: `${s.pbs.items - s.pbs.confirmed} 项待确认，${s.pbs.stale} 项因依据变化待复核（可能重叠）` },
    { key: "quantity", label: "数量与测算依据", count: s.pbs.pendingQty + uncertain, tab: "pbs", text: `${s.pbs.pendingQty} 项未确定数量，${uncertain} 项已有计算值但测算依据待确认` },
  ];
  if (view.catalog?.snapshot_stale) checks.push({ key: "snapshot", label: "方案与 BOM 版本", count: 1, tab: "pbs", text: "已保存版本与当前目录或项目不同，请核对后重新保存；Excel 将使用已保存版本" });
  const findings = view.audit.filter((a) => a.level !== "提示").length;
  return { checks, draft: !view.items.length || checks.some((c) => c.count > 0) || findings > 0 };
}
