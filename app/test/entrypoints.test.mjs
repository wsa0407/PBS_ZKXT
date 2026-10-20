import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import { createServer } from "../server/index.mjs";
import { setAgentRuntimeFactory } from "../server/agent-runner.mjs";
import { pbsPreset } from "../../agents/pbs/preset.mjs";

afterEach(() => setAgentRuntimeFactory(null));

test("chat refuses executable legacy action batches and shared modules are served as modules", async () => {
  resetDb(); const id = repo.createProject({ name: "入口隔离" }).id;
  const code = svc.addRequirement(id, { text: "原始需求" });
  let modelCalls = 0;
  setAgentRuntimeFactory(async () => { modelCalls++; throw new Error("Unexpected runtime"); });
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const actions of [[{ type: "edit_requirement", code, text: "绕开审阅修改" }], [{ type: "analyze" }, { type: "generate_pbs" }]]) {
      const response = await fetch(`${base}/api/projects/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actions }) });
      assert.equal(response.status, 400);
    }
    assert.equal(modelCalls, 0); assert.equal(repo.getRequirement(id, code).text, "原始需求");
    for (const name of ["presentation.js", "understanding.js", "mentions.mjs", "chat-events.mjs"]) {
      const response = await fetch(`${base}/shared/${name}`);
      assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /javascript/);
    }
    assert.equal((await fetch(`${base}/shared/missing.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/shared/..%2Fserver%2Fdb.mjs`)).status, 404);
    const history = await (await fetch(`${base}/api/projects/${id}/chat`)).json();
    assert.equal(Object.hasOwn(history, "suggestions"), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("bounded analysis has no business skills while every specialist shares the same skills provider", () => {
  assert.equal(pbsPreset({ instructions: "分析任务" }).length, 1);
  const specialist = pbsPreset({ instructions: "专家任务", skillsDirectory: "/test/shared-skills" });
  const provider = specialist.find(p => p.id === "pbs-skills");
  assert.deepEqual(provider.config.customSkillDirs, ["/test/shared-skills"]);
  assert.equal(provider.config.includeDefaultRoots, false);
});
