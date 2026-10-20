import "../../app/lib/bai_client.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../host.mjs";
import { serveTools } from "../mcp.mjs";
import { persistedEvents } from "../verification.mjs";

const calls = [];
const mcp = await serveTools({ tools: [{ name: "read_mock_section", description: "Read a synthetic document section; a moved-section error supplies its new id.", inputSchema: { type: "object", properties: { section_id: { type: "string" } }, required: ["section_id"], additionalProperties: false } }], execute: async (_name, args) => {
  calls.push(args.section_id);
  return args.section_id === "seg-2" ? { ok: true, source: "seg-2", text: "验收后提供36个月维护服务。" } : { ok: false, error: { code: "SECTION_MOVED", current_section_id: "seg-2" } };
} });
const home = await mkdtemp(join(tmpdir(), "pbs-dsh-smoke-"));
let host;
try {
  host = await createHost({ home, ...mcp, model: "deepseek-v4.1-flash", baseURL: process.env.BAI_BASE_URL || "https://api.b.ai/v1", apiKey: process.env.BAI_API_KEY, maxTokens: 3000 });
  const result = await host.run("合成工具兼容测试。请调用read_mock_section读取seg-1。若工具返回片段移动，读取新编号后用中文报告维护期限与来源编号。这次不需要PBS业务Skill。不要编造原文。", { onNotification: (n) => { if (n.method === "agent.status") process.stderr.write(`status ${JSON.stringify(n.params)}\n`); } });
  const recovered = calls.includes("seg-1") && calls.includes("seg-2") && result.finalResponse.includes("36");
  const storedEvents = await persistedEvents(home, result.sessionId);
  if (!storedEvents.some((e) => e.type === "agent-preset/selected" && e.data.agentPreset === "pbs")) throw new Error("PBS preset was not bound");
  if (!result.events.some((e) => e.type === "system/message" && JSON.stringify(e.data.message).includes("PBS 需求分析 Agent"))) throw new Error("PBS instructions were not model-visible");
  console.log(JSON.stringify({ runtime: "official-dsh", calls, recovered, events: result.events.length, sessionId: result.sessionId }));
  if (!recovered) throw new Error("Tool recovery was not observed");
  await host.close();
  host = await createHost({ home, ...mcp, model: "deepseek-v4.1-flash", baseURL: process.env.BAI_BASE_URL || "https://api.b.ai/v1", apiKey: process.env.BAI_API_KEY, maxTokens: 1000 });
  const session = await host.resumeSession(result.sessionId);
  const resumed = await session.run("只根据刚才已经读取的原文，回答维护期限。此次不要调用任何工具。");
  if (!resumed.finalResponse.includes("36")) throw new Error("Session restoration did not retain the result");
  console.log(JSON.stringify({ restored: true, sessionId: resumed.sessionId }));
} finally {
  await host?.close();
  await mcp.close();
}
