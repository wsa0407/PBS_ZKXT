import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { INPUT_TYPES, CATEGORIES } from "../engine/extract.mjs";
import { fileToText, SUPPORTED } from "../engine/ingest.mjs";
import * as catalog from "./catalog.mjs";
import * as projectSolutions from "./project-solutions.mjs";
import { openDb, getDb, parse } from "./db.mjs";
import * as chat from "./chat.mjs";
import * as models from "./models.mjs";
import { badRequest, HttpError } from "./errors.mjs";
import { activeJob, cancelJob, failInterruptedJobs, getJob, llmCalls, startJob } from "./jobs.mjs";
import { agentChatTurn, agentGoal } from "./agent-chat.mjs";
import * as collaboration from "./collaboration-api.mjs";
import { events as collaborationEvents, recoverCollaboration } from "./collaboration-store.mjs";
import * as rag from "./rag.mjs";
import * as repo from "./repo.mjs";
import * as svc from "./services.mjs";
import * as scenarios from "./scenarios.mjs";
import { exportProject, parseProductSheet, productTemplate } from "./xlsx.mjs";

const webDir = fileURLToPath(new URL("../web/", import.meta.url));
const vendor = {
  "/vendor/vue.js": "vue/dist/vue.esm-browser.prod.js",
  "/vendor/element-plus.js": "element-plus/dist/index.full.min.mjs",
  "/vendor/element-plus.css": "element-plus/dist/index.css",
  "/vendor/element-plus-zh-cn.js": "element-plus/dist/locale/zh-cn.min.mjs",
};
const nodeModules = fileURLToPath(new URL("../node_modules/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_BODY = 30 * 1024 * 1024;

// ---------- tiny router ----------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, re, keys, handler });
};
const get = (p, h) => route("GET", p, h);
const post = (p, h) => route("POST", p, h);
const put = (p, h) => route("PUT", p, h);
const del = (p, h) => route("DELETE", p, h);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "上传内容超过 30MB");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("请求内容不是合法 JSON");
  }
}

class FileReply {
  constructor(buffer, name, type = XLSX) {
    Object.assign(this, { buffer, name, type });
  }
}

const job = (j) => ({ jobId: j.id });

async function fileText(body) {
  if (body.file?.base64) {
    const name = String(body.file.name ?? "upload");
    return { text: await fileToText(name, Buffer.from(body.file.base64, "base64")), fileName: name };
  }
  return { text: String(body.text ?? ""), fileName: null };
}

// ---------- meta ----------

get("/api/meta", () => {
  const { template, sizing, checklists } = catalog.runtimeConfig();
  return {
    model: models.selectedModel(),
    execution: "deepseek-harness",
    retrieval: rag.retrievalMode(),
    materialKinds: Object.entries(svc.MATERIAL_KINDS).map(([id, label]) => ({ id, label })),
    inputTypes: Object.keys(INPUT_TYPES),
    industries: checklists.industries,
    categories: CATEGORIES,
    fileTypes: SUPPORTED,
    groups: template.level1,
    rules: sizing.rules.map((r) => ({ id: r.id, name: r.name, unit: r.unit, expr: r.expr, product_ref: r.product_ref ?? null, addon: Boolean(r.addon) })),
    params: Object.entries(sizing.params).map(([name, p]) => ({ name, label: p.label, unit: p.unit })),
  };
});

get("/api/samples", () => {
  const dir = new URL("../seed/samples/", import.meta.url);
  return JSON.parse(readFileSync(new URL("index.json", dir), "utf8")).map((s) => ({ ...s, text: readFileSync(new URL(s.file, dir), "utf8") }));
});

get("/api/jobs/:id", ({ id }) => getJob(id) ?? Promise.reject(new HttpError(404, "任务不存在")));
post("/api/jobs/:id/cancel", ({ id }) => cancelJob(id));

// ---------- chat model ----------

get("/api/models", (_params, _body, query) => models.modelCatalog({ refresh: query.get("refresh") === "1" }));
put("/api/models/current", (_, body) => models.chooseModel(body.model));
del("/api/models/current", () => models.resetModel());

// ---------- products ----------

get("/api/catalog", () => catalog.readCatalog());
get("/api/catalog/export.json", () => new FileReply(Buffer.from(JSON.stringify(catalog.readCatalog()?.pack, null, 2)), "产品方案目录.json", "application/json; charset=utf-8"));
post("/api/catalog/preview", (_, body) => {
  try { const preview = catalog.previewImport(body.pack); delete preview.merged; return preview; } catch (e) { throw badRequest(e.message); }
});
post("/api/catalog/import", (_, body) => catalog.importCatalog(body));
put("/api/catalog/:kind/:id", ({ kind, id }, body) => catalog.saveEntry(kind, id, body.entry, body.fingerprint));
put("/api/projects/:id/solutions", ({ id }, body) => projectSolutions.saveProjectSolutions(id, body.designs, body.input_hash));
post("/api/projects/:id/bom/snapshot", ({ id }) => { svc.computeState(id); return projectSolutions.captureProjectBom(id); });
get("/api/products", () => repo.listProducts());
post("/api/products", (_, body) => svc.saveProduct(null, body));
put("/api/products/:id", ({ id }, body) => svc.saveProduct(id, body));
del("/api/products/:id", ({ id }) => {
  if (!svc.deleteProduct(id)) throw new HttpError(404, "产品不存在");
  return { ok: true };
});
get("/api/products/template.xlsx", async () => new FileReply(await productTemplate(repo.listProducts()), "产品清单模板.xlsx"));
post("/api/products/import", async (_, body) => {
  if (!body.base64) throw badRequest("缺少文件内容");
  return svc.importProducts(await parseProductSheet(Buffer.from(body.base64, "base64")));
});
post("/api/products/search", async (_, body) => {
  const q = String(body.query ?? "").trim();
  if (!q) throw badRequest("请输入要检索的需求");
  const [hits] = await rag.search([q], { topK: 10 });
  return { mode: rag.retrievalMode(), hits: hits.map((h) => ({ ...h, product: h.chunk.product_id ? repo.getProduct(h.chunk.product_id)?.name : null })) };
});

get("/api/docs", (_params, _body, query) => repo.listDocs(query.get("product") || null));
get("/api/docs/:id", ({ id }) => repo.getDoc(Number(id)) ?? Promise.reject(new HttpError(404, "手册不存在")));
post("/api/docs", async (_, body) => {
  const { text, fileName } = await fileText(body);
  if (text.trim().length < 50) throw badRequest("手册内容太短");
  const docId = repo.createDoc({ productId: body.productId || null, name: fileName ?? (String(body.name ?? "").trim() || "产品手册"), text: text.trim() });
  const j = startJob({ kind: "manual", steps: ["模型阅读手册", "整理能力与限制"], run: (ctx) => svc.parseManual(docId, ctx) });
  j.promise.then(() => {
    const doc = repo.getDoc(docId);
    if (doc?.status === "解析中") repo.updateDoc(docId, { status: "解析失败" });
  });
  return { docId, ...job(j) };
});
post("/api/docs/:id/confirm", ({ id }, body) => svc.confirmManual(Number(id), body));
del("/api/docs/:id", ({ id }) => (svc.deleteManual(Number(id)), { ok: true }));

// ---------- projects ----------

get("/api/projects", () => repo.listProjects());
post("/api/projects", (_, body) => {
  const name = String(body.name ?? "").trim();
  if (!name) throw badRequest("请填写项目名称");
  const project = repo.createProject({ name, customer: String(body.customer ?? "").trim(), industry: String(body.industry ?? "") });
  repo.logEvent(project.id, "项目", `创建项目「${name}」`);
  return project;
});
get("/api/projects/:id", ({ id }) => ({ ...svc.projectView(id), job: activeJob(id) }));
put("/api/projects/:id", ({ id }, body) => repo.updateProject(id, body));
del("/api/projects/:id", ({ id }) => (repo.deleteProject(id), { ok: true }));
get("/api/projects/:id/events", ({ id }) => ({ events: repo.listEvents(id), llm: llmCalls(id) }));
get("/api/projects/:id/agent-runs", ({ id }) => {
  repo.getProject(id);
  return getDb().prepare("SELECT id,session_id,goal,status,result,error,stats,created_at,finished_at FROM agent_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 30").all(id)
    .map((r) => ({ ...r, result: parse(r.result, null), stats: parse(r.stats, {}) }));
});
get("/api/projects/:id/export.xlsx", ({ id }) => {
  const view = svc.projectView(id);
  if (!view.items.length) throw badRequest("还没有 PBS，无法导出");
  return exportProject(view).then((buf) => new FileReply(buf, `${view.project.name}-PBS.xlsx`));
});

// materials
post("/api/projects/:id/materials", async ({ id }, body) => {
  repo.getProject(id);
  const { text, fileName } = await fileText(body);
  return { id: svc.addMaterial(id, { kind: body.kind, title: body.title, description: body.description, text, fileName }) };
});
get("/api/projects/:id/materials/:mid", ({ id, mid }) => repo.getMaterial(id, Number(mid)));
del("/api/projects/:id/materials/:mid", ({ id, mid }) => {
  svc.deleteMaterial(id, Number(mid));
  repo.logEvent(id, "材料", `删除材料 #${mid}`);
  return { ok: true };
});

// requirements
post("/api/projects/:id/analyze", ({ id }, body) =>
  collaboration.submitCollaboration(id, { text: body.all ? "回查全部材料，保留人工成果" : "理解客户材料", actions: [{ type: "analyze" }] }),
);
post("/api/projects/:id/requirements", ({ id }, body) => ({ code: svc.addRequirement(id, body) }));
put("/api/projects/:id/requirements/:code", ({ id, code }, body) => (svc.editRequirement(id, code, body), { ok: true }));
post("/api/projects/:id/requirements/confirm", ({ id }, body) => (svc.confirmRequirements(id, body.codes ?? []), { ok: true }));
put("/api/projects/:id/params/:name", ({ id, name }, body) => (svc.setParam(id, name, body), { ok: true }));

// Scenario requirements: every mutation uses the same versioned service as chat.
post("/api/projects/:id/scenarios/generate", ({ id }) => collaboration.submitCollaboration(id, { text: "继续整理客户场景与待澄清事项", target: "understanding" }));
post("/api/projects/:id/scenarios", ({ id }, body) => scenarios.addScenario(id, body));
get("/api/projects/:id/scenarios/:code", ({ id, code }) => ({ scenario: scenarios.getScenario(id, code), revisions: scenarios.revisions(id, code) }));
put("/api/projects/:id/scenarios/:code", ({ id, code }, body) => scenarios.editScenario(id, code, body));
post("/api/projects/:id/scenarios/confirm", ({ id }, body) => ({ scenarios: scenarios.confirmScenarios(id, body) }));
post("/api/projects/:id/scenarios/merge", ({ id }, body) => scenarios.restructure(id, body));
post("/api/projects/:id/scenarios/:code/split", ({ id, code }, body) => scenarios.restructure(id, { ...body, originals: [{ code, revision: body.revision }] }));
put("/api/projects/:id/requirements/:code/disposition", ({ id, code }, body) => scenarios.editDisposition(id, code, body));

// business capabilities
post("/api/projects/:id/capabilities/generate", ({ id }) =>
  collaboration.submitCollaboration(id, { text: "根据客户场景归纳业务活动", target: "understanding" }),
);
post("/api/projects/:id/capabilities", ({ id }, body) => ({ code: svc.addCapability(id, body) }));
put("/api/projects/:id/capabilities/:code", ({ id, code }, body) => (svc.editCapability(id, code, body), { ok: true }));
post("/api/projects/:id/capabilities/confirm", ({ id }, body) => (svc.confirmCapabilities(id, body.codes ?? []), { ok: true }));

// questions
post("/api/projects/:id/questions", ({ id }, body) => (svc.addQuestion(id, body), { ok: true }));
put("/api/projects/:id/questions/:qid", ({ id, qid }, body) => (svc.editQuestion(id, Number(qid), body), { ok: true }));
del("/api/projects/:id/questions/:qid", ({ id, qid }) => (repo.deleteQuestion(id, Number(qid)), { ok: true }));
post("/api/projects/:id/questions/:qid/answer", ({ id, qid }, body) =>
  job(startJob({ projectId: id, kind: "answer", steps: ["模型分析答复的影响"], run: ({ llm, progress }) => (progress.step(0), svc.proposeAnswer(id, Number(qid), body, llm)) })),
);
post("/api/projects/:id/questions/:qid/apply", ({ id, qid }, body) => svc.applyAnswer(id, Number(qid), body.accepted ?? [], body.resolution_note ?? ""));

// chat (conversational control; every turn is a background job so model calls show progress)
get("/api/projects/:id/chat", ({ id }) => ({ messages: chat.chatHistory(id), suggestions: chat.suggestions(svc.projectView(id)), collaboration: collaboration.collaborationView(id), job: activeJob(id) }));
post("/api/projects/:id/chat", async ({ id }, body) => {
  repo.getProject(id);
  const attachment = body.file?.base64 ? { name: String(body.file.name ?? "upload"), text: (await fileText(body)).text } : null;
  if (!body.actions?.length || body.actions.some((a) => agentGoal(a))) return collaboration.submitCollaboration(id, { ...body, file: undefined, attachment });
  return job(
    startJob({
      projectId: id,
      kind: "chat",
      steps: ["理解你的意思"],
      run: (ctx) => agentChatTurn(id, { text: body.text, attachment, actions: body.actions, label: body.label }, ctx),
    }),
  );
});
get("/api/projects/:id/collaboration", ({ id }) => collaboration.collaborationView(id));
get("/api/projects/:id/collaboration/events", ({ id }, _, query) => ({ events: collaborationEvents(id, query.get("after")) }));
get("/api/projects/:id/collaboration/approval", ({ id }) => collaboration.approvalPreview(id));
post("/api/projects/:id/collaboration/confirm", ({ id }, body) => collaboration.confirmAndStart(id, body));
post("/api/projects/:id/collaboration/pause", ({ id }) => collaboration.pauseProject(id));
post("/api/projects/:id/collaboration/resume", ({ id }) => collaboration.resumeProject(id));
post("/api/projects/:id/chat/:mid/cards/:ci", ({ id, mid, ci }, body) => chat.resolveCard(id, Number(mid), Number(ci), body.decision === "accept" ? "accept" : "dismiss"));
del("/api/projects/:id/chat", ({ id }) => (repo.clearChat(id), { ok: true }));

// PBS
post("/api/projects/:id/pbs/generate", ({ id }) =>
  collaboration.submitCollaboration(id, { text: "编制PBS草稿", actions: [{ type: "generate_pbs" }] }),
);
post("/api/projects/:id/pbs", ({ id }, body) => ({ id: svc.saveItem(id, null, body) }));
put("/api/projects/:id/pbs/:iid", ({ id, iid }, body) => ({ id: svc.saveItem(id, Number(iid), body) }));
del("/api/projects/:id/pbs/:iid", ({ id, iid }) => (svc.deleteItem(id, Number(iid)), { ok: true }));
post("/api/projects/:id/pbs/confirm", ({ id }, body) => (svc.confirmItems(id, body.ids ?? []), { ok: true }));
post("/api/projects/:id/pbs/:iid/rematch", ({ id, iid }, body) =>
  job(startJob({ projectId: id, kind: "rematch", steps: ["检索并重新匹配"], run: ({ llm, progress }) => (progress.step(0), svc.rematchItem(id, Number(iid), { instruction: body.instruction, llm })) })),
);
post("/api/projects/:id/pbs/:iid/accept", ({ id, iid }, body) => (svc.acceptRematch(id, Number(iid), body.suggestion ?? {}), { ok: true }));

// ---------- server ----------

function send(res, status, body) {
  if (body instanceof FileReply) {
    res.writeHead(200, { "Content-Type": body.type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(body.name)}` });
    return res.end(body.buffer);
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body ?? null));
}

function serveFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": file.startsWith(nodeModules) ? "max-age=86400" : "no-cache" });
  createReadStream(file).pipe(res);
  return true;
}

function serveStatic(res, pathname) {
  if (vendor[pathname]) {
    if (serveFile(res, join(nodeModules, vendor[pathname]))) return;
    return send(res, 500, { error: "前端依赖缺失，请在 app 目录运行 npm install" });
  }
  const file = normalize(join(webDir, pathname));
  if (file.startsWith(webDir.endsWith(sep) ? webDir : webDir + sep) && serveFile(res, file)) return;
  // SPA fallback
  serveFile(res, join(webDir, "index.html"));
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (!pathname.startsWith("/api/")) return serveStatic(res, pathname);
      const stream = pathname.match(/^\/api\/projects\/([^/]+)\/collaboration\/stream$/);
      if (req.method === "GET" && stream) {
        repo.getProject(stream[1]);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        let cursor = Number(req.headers["last-event-id"] || url.searchParams.get("after")) || 0;
        const flush = () => {
          for (const e of collaborationEvents(stream[1], cursor)) { res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); cursor = e.seq; }
        };
        flush();
        const timer = setInterval(flush, 800);
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
        res.on("close", () => { clearInterval(timer); clearInterval(heartbeat); });
        return;
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
        return send(res, 200, await r.handler(params, body, url.searchParams));
      }
      send(res, 404, { error: "接口不存在" });
    } catch (error) {
      const status = error.status ?? (/无法解析|不支持的文件|没有可识别|模板|产品名称/.test(error.message) ? 400 : 500);
      if (status >= 500) console.error(error);
      if (!res.headersSent) send(res, status, { error: error.message });
    }
  });
}

export async function boot({ port = Number(process.env.PORT || 8765), host = process.env.HOST || "127.0.0.1" } = {}) {
  openDb();
  catalog.installDefaultCatalog();
  failInterruptedJobs();
  recoverCollaboration();
  svc.rebuildIndex();
  svc.seedManuals();
  const mode = await rag.probeEmbeddings();
  const server = createServer();
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`PBS 智能拆解：http://${host}:${port}/`);
  console.log(`  模型 ${models.selectedModel()} · 检索 ${mode.kind === "hybrid" ? `混合检索（BM25 + 向量 ${mode.model}）` : `仅关键词检索（BM25）—— ${mode.reason}`}`);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) boot();
