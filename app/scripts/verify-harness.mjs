// Explicit, real-model integration verification on synthetic materials.
import "../lib/bai_client.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDb, getDb } from "../server/db.mjs";
import * as repo from "../server/repo.mjs";
import * as svc from "../server/services.mjs";
import * as catalog from "../server/catalog.mjs";
import * as rag from "../server/rag.mjs";
import { localAgentAdapter } from "../server/agent-adapter.mjs";
import { TOOLS } from "../../agents/pbs/contracts/tools.mjs";
import { createHost } from "../../runtime/host.mjs";
import { serveTools } from "../../runtime/mcp.mjs";
import { persistedEvents } from "../../runtime/verification.mjs";

const directory = await mkdtemp(join(tmpdir(), "pbs-harness-business-"));
const dbPath = process.argv.find((v) => v.startsWith("--db="))?.slice(5) || join(directory, "business.db");
resetDb(dbPath);
catalog.installDefaultCatalog(); svc.rebuildIndex();
rag.setRetrievalMode({ kind: "keyword", model: null, reason: "合成验收使用关键词检索" });
const project = repo.createProject({ name: "Harness架构验收", customer: "合成测试", industry: "园区" });
const fixture = JSON.parse(await readFile(new URL("../../agents/pbs/evals/garden.json", import.meta.url), "utf8"));
svc.addMaterial(project.id, { kind: "tender", title: "园区巡查合成验收材料", text: fixture.material });
const adapter = localAgentAdapter(project.id);
const trace = []; let injected = false;
let host;
const repeated = new Map();
const mcp = await serveTools({ tools: TOOLS, execute: async (name, args) => {
  if (name === "submit_requirements" && !injected && args.requirements?.length) {
    injected = true;
    const altered = structuredClone(args);
    altered.requirements[0].quote = "故障注入：原文没有此引用";
    return adapter.execute(name, altered);
  }
  return adapter.execute(name, args);
}, onCall: (call) => {
  const messages = call.result?.data?.errors?.map((e) => e.message) ?? (call.result?.error ? [call.result.error.message] : []);
  const item = { name: call.name, ok: call.ok, errors: messages.length, ...(messages.length ? { messages } : {}) };
  trace.push(item); console.log(JSON.stringify(item));
  if (messages.length) {
    const key = JSON.stringify([call.name, messages]); const n = (repeated.get(key) ?? 0) + 1; repeated.set(key, n);
    if (n >= 5) host?.close().catch(() => {});
  }
} });
const timer = setTimeout(() => host?.close().catch(() => {}), 10 * 60 * 1000);
try {
  host = await createHost({ home: join(directory, "dsh"), ...mcp, model: "deepseek-v4.1-flash", baseURL: process.env.BAI_BASE_URL || "https://api.b.ai/v1", apiKey: process.env.BAI_API_KEY, maxTokens: 8000 });
  const result = await host.run("请基于当前合成验收材料完整提取原始需求，生成有依据的业务场景和澄清问题，再检索公司产品、组合PBS草稿，检查覆盖与引用并修复可处理的问题。不要确认任何业务成果。工具校验失败后应回查原文修复；已保存的项不重复提交。此次为小材料，应完整走完工具流程并调用finish_task。", { onNotification: (n) => {
    if (n.method === "session.event" && n.params.event.type === "assistant/message" && n.params.event.data?.usage) console.log(JSON.stringify({ usage: n.params.event.data.usage }));
    if (n.method === "session.event" && n.params.event.type === "tool/call") console.log(JSON.stringify({ official_tool: n.params.event.data.name }));
  } });
  const requirements = repo.listRequirements(project.id, { includeDeleted: false });
  const report = adapter.report();
  assert.ok(injected && trace.some((t) => t.name === "submit_requirements" && t.errors > 0));
  assert.ok(requirements.length >= 4 && requirements.every((r) => r.quote_verified));
  assert.ok(requirements.some((r) => r.text.includes("36")));
  assert.ok(getDb().prepare("SELECT count(*) n FROM scenarios WHERE project_id=?").get(project.id).n > 0);
  assert.ok(repo.listItems(project.id).length > 0);
  assert.ok(repo.listItems(project.id).some((i) => i.product_ref), "catalog products must retain their references for BOM expansion");
  const storedEvents = await persistedEvents(join(directory, "dsh"), result.sessionId);
  assert.ok(storedEvents.some((e) => e.type === "agent-preset/selected" && e.data.agentPreset === "pbs"), "the PBS preset must actually be bound, not only declared");
  assert.ok(result.events.some((e) => e.type === "system/message" && JSON.stringify(e.data.message).includes("PBS 需求分析 Agent")), "PBS instructions must be model-visible");
  assert.ok(result.events.some((e) => e.type === "tool/call" && e.data.name === "skill"), "business Skills must actually be loaded");
  assert.ok(adapter.finished, "the Agent must explicitly submit its completion report");
  assert.equal(repo.getProject(project.id).done, false);
  const outcome = { passed: true, project_id: project.id, db: dbPath, session_id: result.sessionId, requirements: requirements.length, pbs: repo.listItems(project.id).length, report, trace };
  await writeFile("/private/tmp/pbs-harness-business-result.json", JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify({ passed: true, project_id: project.id, requirements: requirements.length, pbs: repo.listItems(project.id).length, recovered_quote: true }));
} finally { clearTimeout(timer); await host?.close(); await mcp.close(); }
