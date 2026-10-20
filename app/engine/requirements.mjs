import { normalize } from "./text.mjs";

export const CATEGORIES = ["功能", "性能", "环境", "安全", "信创", "集成", "实施", "服务", "商务", "资质", "背景", "范围外"];
// Not things a PBS item has to deliver.
export const NON_DELIVERABLE = new Set(["背景", "商务", "资质", "范围外"]);

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function unitMatches(value, spec, quote) {
  const text = normalize(quote);
  const units = (spec.units ?? [spec.unit]).map((u) => normalize(u));
  const forms = [String(value), String(Math.abs(value))];
  if (Number.isInteger(value) && value >= 0 && value <= 10) forms.push(CN_DIGITS[value], ...(value === 2 ? ["两"] : []));
  return forms.some((form) =>
    units.some((unit) => {
      const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`${form.replace("-", "\\-")}(个|名|余|多)?${escaped}`, "i").test(text);
    }),
  );
}

export function checkParam(p, spec, segText) {
  if (!spec) return "参数名称不在当前测算参数表中";
  if (!Number.isFinite(Number(p.value))) return "参数值不是有效数字";
  if (!p.quote || !segText.includes(normalize(p.quote))) return "参数引用不在原文中";
  if (!unitMatches(Number(p.value), spec, p.quote)) return `原文中 ${p.value} 后面不是单位「${(spec.units ?? [spec.unit]).join("/")}」`;
  if (spec.keywords && !spec.keywords.some((k) => segText.includes(normalize(k)))) {
    return `原文中没有出现「${spec.keywords.join("/")}」，数字可能指别的东西`;
  }
  return "";
}

export function collectParams(requirements) {
  const values = {};
  for (const req of requirements) {
    if (req.category === "范围外") continue;
    for (const p of req.params) {
      (values[p.name] ??= []).push({ value: p.value, req_id: req.id, seg_id: req.seg_id, quote: p.quote });
    }
  }
  return values;
}
