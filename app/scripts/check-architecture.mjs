import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../../agents/pbs/contracts/tools.mjs";
import { COLLABORATION_TOOLS } from "../../agents/pbs/contracts/collaboration.mjs";
import { ROLES } from "../../agents/pbs/roles.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => ["node_modules", ".state"].includes(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const files = ["app/engine", "app/lib", "app/server", "app/shared", "app/web", "agents", "runtime"].flatMap(dir => walk(join(root, dir))).filter(f => [".mjs", ".js"].includes(extname(f)));
const label = f => relative(root, f).split(sep).join("/");
const graph = new Map();
for (const file of files) {
  const name = label(file), deps = [];
  for (const m of readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
    if (m[1].includes("${")) continue;
    const target = resolve(dirname(file), m[1]), ref = label(target);
    assert.ok(existsSync(target), `${name}: missing import ${m[1]}`);
    if (name.startsWith("agents/")) assert.ok(ref.startsWith("agents/"), `${name}: Agent package must not import host code`);
    if (name.startsWith("app/shared/")) assert.ok(ref.startsWith("app/shared/"), `${name}: shared semantics must stay platform-independent`);
    if (name.startsWith("app/engine/")) assert.ok(ref.startsWith("app/engine/"), `${name}: domain rules must not import infrastructure`);
    if (name.startsWith("app/server/")) assert.ok(!ref.startsWith("app/web/"), `${name}: server must not import UI modules`);
    if (name.startsWith("app/web/")) assert.ok(ref.startsWith("app/web/") || ref.startsWith("app/shared/"), `${name}: browser must not import server modules`);
    if (name.startsWith("runtime/") && !name.startsWith("runtime/scripts/")) assert.ok(!ref.startsWith("app/"), `${name}: runtime must not import local business services`);
    deps.push(target);
  }
  graph.set(file, deps);
}
const visited = new Set();
function visit(file, stack = []) {
  assert.ok(!stack.includes(file), `Circular imports: ${[...stack, file].map(label).join(" → ")}`);
  if (visited.has(file)) return;
  for (const dep of graph.get(file) ?? []) visit(dep, [...stack, file]);
  visited.add(file);
}
files.forEach(f => visit(f));
const all = [...TOOLS, ...COLLABORATION_TOOLS];
assert.equal(new Set(all.map(t => t.name)).size, all.length, "Tool names must be unique");
for (const [id, role] of Object.entries(ROLES)) {
  assert.ok(existsSync(join(root, "agents/pbs", role.instructions)), `${id}: role instructions missing`);
  for (const tool of role.writes) assert.ok(TOOLS.some(t => t.name === tool && !t.annotations.readOnlyHint), `${id}: unknown write tool ${tool}`);
  for (const target of role.consult) assert.ok(target !== id && ROLES[target], `${id}: invalid consultation target`);
}
const skills = readdirSync(join(root, "agents/pbs/skills"));
const names = new Set();
for (const skill of skills) {
  const text = readFileSync(join(root, "agents/pbs/skills", skill, "SKILL.md"), "utf8");
  const name = text.match(/^name:\s*(.+)$/m)?.[1];
  assert.ok(text.startsWith("---\n") && name === skill && /^description:\s*\S/m.test(text), `${skill}: invalid Skill metadata`);
  assert.ok(!names.has(name)); names.add(name);
}
console.log(`Architecture checks passed: ${files.length} modules, ${all.length} tools, ${names.size} shared skills; no circular imports.`);
