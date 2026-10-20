// Shared by the composer and server: mentions address people, never choose their work.
export const EXPERTS = [
  { id: "materials", label: "材料拆解专家", aliases: ["材料专家", "材料拆解", "材料", "materials"] },
  { id: "understanding", label: "需求理解专家", aliases: ["需求专家", "需求理解", "需求", "understanding"] },
  { id: "pbs", label: "PBS专家", aliases: ["PBS编制", "PBS", "pbs"] },
];
const aliases = EXPERTS.flatMap(e => [e.label, ...e.aliases].map(name => ({ name, id: e.id }))).sort((a, b) => b.name.length - a.name.length);
export function parseMentions(text = "") {
  const targets = [], unknown = [];
  let content = String(text).replace(/(^|[\s，。；、:：])[@＠]([^\s@＠，。；、:：!?！？]+)/g, (full, prefix, word) => {
    const match = aliases.find(a => a.name.toLowerCase() === word.toLowerCase());
    if (!match) { unknown.push(word); return full; }
    if (!targets.includes(match.id)) targets.push(match.id);
    return prefix;
  }).trim();
  return { targets, content, unknown };
}
export function mentionQuery(text, caret = text.length) {
  const match = text.slice(0, caret).match(/(?:^|[\s，。；、:：])[@＠]([^\s@＠，。；、:：!?！？]*)$/);
  if (!match) return null;
  const query = match[1].toLowerCase();
  return { start: caret - query.length - 1, end: caret, options: EXPERTS.filter(e => [e.label, ...e.aliases].some(n => n.toLowerCase().includes(query))) };
}
