const HELPERS = { ceil: Math.ceil, floor: Math.floor, round: Math.round, max: Math.max, min: Math.min, abs: Math.abs };

export function evaluate(expr, scope) {
  if (!/^[\w\s+\-*/().,<>=!&|?:]+$/.test(expr)) throw new Error(`unsupported expression ${expr}`);
  for (const id of expr.match(/[A-Za-z_]\w*/g) ?? []) {
    if (!(id in HELPERS) && !(id in scope)) throw new Error(`unknown identifier ${id}`);
  }
  const names = [...Object.keys(HELPERS), ...Object.keys(scope)];
  return new Function(...names, `"use strict"; return (${expr});`)(...Object.values(HELPERS), ...Object.values(scope));
}

const scopeOf = (resolved) =>
  Object.fromEntries(Object.values(resolved).filter((p) => p.value !== null).map((p) => [p.name, p.value]));

export const CONFIRMED = new Set(["原文明确", "客户确认", "人工设定"]);
const OVERRIDE_STATUS = { 客户答复: "客户确认", 人工: "人工设定" };

/**
 * values: { name: [{ value, req_id, seg_id, quote }] } collected from requirements.
 * overrides: { name: { value, source: "客户答复" | "人工", note, question_id } } — always win over the text.
 */
export function resolveParams(values, sizing, overrides = {}) {
  const resolved = {};
  for (const [name, spec] of Object.entries(sizing.params)) {
    const label = spec.label ?? name;
    const candidates = values[name] ?? [];
    const distinct = [...new Set(candidates.map((c) => c.value))];
    const fallback = sizing.rules.find((r) => r.defaults?.[name] !== undefined)?.defaults[name];
    const override = overrides[name];
    if (override && Number.isFinite(override.value)) {
      resolved[name] = {
        name,
        label,
        unit: spec.unit,
        value: override.value,
        status: OVERRIDE_STATUS[override.source] ?? "人工设定",
        note: override.note ?? "",
        question_id: override.question_id ?? null,
        candidates,
      };
    } else if (distinct.length === 1) {
      resolved[name] = { name, label, unit: spec.unit, value: distinct[0], status: "原文明确", candidates };
    } else if (distinct.length > 1) {
      const pickMin = spec.pick === "min";
      resolved[name] = {
        name,
        label,
        unit: spec.unit,
        value: pickMin ? Math.min(...distinct) : Math.max(...distinct),
        status: pickMin ? "多处取值不一致，暂取最严值" : "多处取值不一致，暂取大值",
        candidates,
      };
    } else if (fallback !== undefined) {
      resolved[name] = { name, label, unit: spec.unit, value: fallback, status: "原文未给出，使用默认值", candidates };
    } else {
      resolved[name] = { name, label, unit: spec.unit, value: null, status: "缺失", candidates };
    }
  }

  // Derived parameters (e.g. dock count from road length) only fill gaps, never override the text.
  for (const [name, spec] of Object.entries(sizing.params)) {
    if (resolved[name].value !== null || !spec.derive) continue;
    const scope = scopeOf(resolved);
    for (const d of spec.derive) {
      try {
        const value = evaluate(d.expr, scope);
        if (!Number.isFinite(value)) continue;
        resolved[name] = { ...resolved[name], value, status: "按规则推算", derivedFrom: d.expr, note: d.note };
        break;
      } catch {
        // inputs of this derivation are missing; try the next one
      }
    }
  }
  return resolved;
}

export function missingRules(text, resolved, sizing, leaves) {
  const used = new Set(leaves.map((l) => l.sizing_rule).filter(Boolean));
  return triggeredRules(text, resolved, sizing).filter(({ rule }) => !used.has(rule.id));
}

// Rules the project needs: mentioned in the text, or switched on by a parameter condition.
export function triggeredRules(text, resolved, sizing) {
  const scope = scopeOf(resolved);
  const out = [];
  for (const rule of sizing.rules) {
    const keyword = rule.required_when?.find((k) => text.includes(k));
    if (keyword) {
      out.push({ rule, reason: `需求中提到「${keyword}」` });
      continue;
    }
    if (rule.required_if) {
      try {
        if (evaluate(rule.required_if, scope)) out.push({ rule, reason: `测算参数满足 ${rule.required_if}` });
      } catch {
        // condition references a parameter that was not resolved
      }
    }
  }
  return out;
}

export function applySizing(leaves, resolved, sizing) {
  const ruleById = new Map(sizing.rules.map((r) => [r.id, r]));
  for (const leaf of leaves) {
    if (!leaf.sizing_rule) continue;
    const rule = ruleById.get(leaf.sizing_rule);
    if (!rule) {
      leaf.sizing = { error: `测算规则 ${leaf.sizing_rule} 不存在` };
      continue;
    }
    const inputs = rule.inputs.map((name) => resolved[name] ?? { name, label: name, value: null, status: "缺失" });
    const missing = inputs.filter((i) => i.value === null);
    if (missing.length) {
      leaf.qty = null;
      leaf.unit = rule.unit;
      leaf.sizing = { rule_id: rule.id, rule_name: rule.name, expr: rule.expr, note: rule.note, inputs: [], error: `缺少参数：${missing.map((m) => m.label).join("、")}` };
      continue;
    }
    const scope = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
    const result = Math.round(evaluate(rule.expr, scope) * 100) / 100;
    leaf.qty = result;
    leaf.unit = rule.unit;
    leaf.sizing = {
      rule_id: rule.id,
      rule_name: rule.name,
      expr: rule.expr,
      note: rule.note,
      inputs: inputs.map(({ name, label, value, status, unit, derivedFrom }) => ({ name, label, value, status, unit, derivedFrom })),
      result,
      uncertain: inputs.some((i) => !CONFIRMED.has(i.status)),
    };
  }
  return leaves;
}
