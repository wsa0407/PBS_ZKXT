import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@vue/compiler-dom";

const webDir = fileURLToPath(new URL("../web/", import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "vendor") return [];
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
  });
}

let failures = 0;
for (const file of walk(webDir)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/template:\s*`([\s\S]*?)`/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    const errors = [];
    compile(match[1], { onError: (error) => errors.push(error), onWarn: () => {} });
    for (const error of errors) {
      failures += 1;
      const at = error.loc ? line + error.loc.start.line - 1 : line;
      console.log(`${relative(webDir, file)}:${at}  ${error.message}`);
    }
  }
}
console.log(failures ? `${failures} template error(s)` : "all templates compile");
process.exit(failures ? 1 : 0);
