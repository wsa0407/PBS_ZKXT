export function normalize(text) {
  return String(text ?? "")
    .replace(/[★▲]/g, "")
    .replace(/[\s“”"'‘’「」]/g, "")
    .replace(/，/g, ",")
    .replace(/；/g, ";")
    .replace(/：/g, ":")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .toLowerCase();
}

export function bigrams(text) {
  const clean = normalize(text).replace(/[,.;:()、。！？!?/|-]/g, "");
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
  return set;
}

export function dice(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit += 1;
  return (2 * hit) / (x.size + y.size);
}
