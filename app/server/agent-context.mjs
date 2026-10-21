/** Model-facing scope index only. The immutable approval and write guards stay intact. */
export function confirmationIndex(approval) {
  if (!approval) return null;
  const s = approval.snapshot;
  const reqIds = new Set(s.requirements.map(r => r.code));
  return { ...approval, snapshot: {
    projection: "scope_index",
    read_details: "此处只列人工确认范围，不是完整需求。用 list_requirements、list_scenarios 分页读取详情，只处理下列编号；原文用 read_evidence 回查。澄清状态用 run_report，已保存成果用 list_pbs。",
    requirements: s.requirements.map(({ code, revision, category, priority }) => ({ code, revision, category, priority })),
    scenarios: s.scenarios.map(({ code, revision, name, links }) => ({ code, revision, name, links: links.map(({ req_id, role }) => ({ req_id, role })) })),
    // These scope facts have no separate paginated reader; never discard them as "history".
    dispositions: (s.dispositions ?? []).filter(d => reqIds.has(d.req_id)).map(({ req_id, kinds, scenario_ids, note }) => ({ req_id, kinds, scenario_ids, ...(note ? { note } : {}) })),
    answers: s.answers, overrides: s.overrides,
    excluded: s.excluded, sources: s.sources, approved_by: s.approved_by, approved_at: s.approved_at,
  } };
}
