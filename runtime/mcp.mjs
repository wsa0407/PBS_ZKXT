import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Stateless Streamable HTTP MCP transport. Domain execution stays in the supplied adapter.
export async function serveTools({ tools, execute, instructions = "PBS business tools; project identity is bound by the host.", onCall = () => {} }) {
  const token = randomBytes(32).toString("hex");
  let closed = false;
  const inflight = new Set();
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
    if (closed || auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(403, { error: "Forbidden" });
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    let rpc;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("request too large"); chunks.push(chunk); }
      rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new Error("invalid request");
    } catch { return reply(400, { error: "Invalid JSON-RPC request" }); }
    if (rpc.id === undefined) return reply(202);
    const result = (value) => reply(200, { jsonrpc: "2.0", id: rpc.id, result: value });
    if (rpc.method === "initialize") return result({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "pbs-tools", version: "1.0.0" }, instructions });
    if (rpc.method === "ping") return result({});
    if (rpc.method === "tools/list") return result({ tools });
    if (rpc.method !== "tools/call") return reply(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown method" } });
    const started = Date.now();
    const work = Promise.resolve().then(() => { if (closed) throw new Error("Run closed"); return execute(rpc.params?.name, rpc.params?.arguments ?? {}); });
    inflight.add(work);
    try {
      const data = await work;
      onCall({ name: rpc.params?.name, ok: data?.ok !== false, ms: Date.now() - started, result: data });
      result({ content: [{ type: "text", text: JSON.stringify(data) }], isError: data?.ok === false });
    } catch (error) {
      onCall({ name: rpc.params?.name, ok: false, ms: Date.now() - started });
      result({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "TOOL_ERROR", message: error.message } }) }], isError: true });
    } finally { inflight.delete(work); }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  return { token, endpoint: `http://127.0.0.1:${server.address().port}/mcp`, async close() {
    closed = true;
    server.closeIdleConnections();
    await new Promise((yes) => server.close(yes));
    await Promise.allSettled([...inflight]);
  } };
}
