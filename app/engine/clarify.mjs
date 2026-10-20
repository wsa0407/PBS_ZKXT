import { dice } from "./text.mjs";

export const IMPACTS = ["影响废标风险", "影响报价", "影响方案"];

export function isDuplicate(question, existing) {
  return existing.some((q) => dice(q.question, question) >= 0.45 || (q.topic && question.includes(q.topic)));
}
