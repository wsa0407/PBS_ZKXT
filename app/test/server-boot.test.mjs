import assert from "node:assert/strict";
import { test } from "node:test";
import { boot, createServer } from "../server/index.mjs";
import { getDb, resetDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import { createCollaboration } from "../server/collaboration.mjs";
import * as store from "../server/collaboration-store.mjs";

test("a duplicate server launch cannot reset live work, and startup requests wait for readiness", async () => {
  resetDb();
  const project = repo.createProject({ name: "启动保护" });
  const task = createCollaboration(project.id, { role: "materials", goal: "合成任务" });
  const activation = store.nextActivation(task.id);
  store.updateTask(task.id, { status: "running" });
  getDb().prepare("UPDATE collaboration_activations SET state='running' WHERE id=?").run(activation.id);
  getDb().prepare("INSERT INTO jobs(id,project_id,kind,status,steps,created_at) VALUES ('live-job',?,'collaboration','处理中','[]','test')").run(project.id);
  getDb().prepare("INSERT INTO agent_runs(id,project_id,goal,status,created_at) VALUES ('live-run',?,'合成任务','running','test')").run(project.id);
  const server = createServer({ ready: () => false });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(response.status, 503);
    await response.text();
    await assert.rejects(() => boot({ port, host: "127.0.0.1" }), { code: "EADDRINUSE" });
    assert.equal(store.task(task.id).status, "running");
    assert.equal(getDb().prepare("SELECT state FROM collaboration_activations WHERE id=?").get(activation.id).state, "running");
    assert.equal(getDb().prepare("SELECT status FROM jobs WHERE id='live-job'").get().status, "处理中");
    assert.equal(getDb().prepare("SELECT status FROM agent_runs WHERE id='live-run'").get().status, "running");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
