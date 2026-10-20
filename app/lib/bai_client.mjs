import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

/** Loads the repository-root .env once; variables already set in the environment win. */
function loadDotenv() {
  try {
    const text = readFileSync(fileURLToPath(new URL("../../.env", import.meta.url)), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional when variables are already set
  }
}
loadDotenv();

function windowsSystemProxy() {
  if (process.platform !== "win32") return "";
  try {
    const enabled = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8" },
    );
    if (!/0x1\b/.test(enabled)) return "";
    const server = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
      { encoding: "utf8" },
    );
    const match = server.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!match) return "";
    return match[1].includes("://") ? match[1] : `http://${match[1]}`;
  } catch {
    return "";
  }
}

function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || windowsSystemProxy();
}

function config() {
  const apiKey = (process.env.BAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("BAI_API_KEY is not set");
  const baseUrl = (process.env.BAI_BASE_URL || "https://api.b.ai/v1").replace(/\/$/, "");
  return { apiKey, baseUrl };
}

async function requestOnce(url, { method, headers, body, proxy, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await sendRequest(url, { method, headers, body, proxy, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`B.AI 请求超时（${timeoutMs / 1000} 秒），请检查服务地址或网络连接`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sendRequest(url, { method, headers, body, proxy, signal }) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    const send = (socket) => {
      const req = https.request(
        {
          host: target.hostname,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          servername: target.hostname,
          socket,
          agent: socket ? false : undefined,
          signal,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            resolvePromise({
              status: response.statusCode || 0,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    };

    if (!proxy) {
      send(undefined);
      return;
    }

    const gateway = new URL(proxy);
    const connectReq = http.request({
      host: gateway.hostname,
      port: gateway.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:443`,
      signal,
    });
    connectReq.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${response.statusCode}`));
        return;
      }
      send(socket);
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

async function request(method, path, body, { timeoutMs = 120000 } = {}) {
  const { apiKey, baseUrl } = config();
  const payload = body ? JSON.stringify(body) : undefined;
  const response = await requestOnce(`${baseUrl}${path}`, {
    method,
    proxy: proxyUrl(),
    body: payload,
    timeoutMs,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`B.AI HTTP ${response.status}: ${response.text}`);
  }
  return JSON.parse(response.text);
}

export async function listModels({ timeoutMs = 8000 } = {}) {
  const payload = await request("GET", "/models", undefined, { timeoutMs });
  return payload.data.map((item) => item.id);
}

export async function chatCompletion({ messages, model, maxTokens = 16000, temperature, retries = 3 }) {
  const body = { model, messages, max_tokens: maxTokens };
  if (temperature !== undefined) body.temperature = temperature;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const payload = await request("POST", "/chat/completions", body);
      const choice = payload.choices?.[0];
      return {
        content: choice?.message?.content ?? "",
        finishReason: choice?.finish_reason,
        usage: payload.usage ?? {},
        model: payload.model ?? model,
      };
    } catch (error) {
      lastError = error;
      const status = Number(String(error.message).match(/HTTP (\d+)/)?.[1] ?? 0);
      if (status && status < 500 && status !== 429) throw error;
      await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function embeddings({ input, model }) {
  const payload = await request("POST", "/embeddings", { model, input });
  const rows = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== input.length || !rows.every((r) => Array.isArray(r.embedding))) {
    throw new Error("embeddings response does not match input");
  }
  return rows.map((r) => r.embedding);
}
