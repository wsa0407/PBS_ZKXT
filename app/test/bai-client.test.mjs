import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { afterEach, mock, test } from "node:test";
import { listModels } from "../lib/bai_client.mjs";

const proxyNames = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const original = Object.fromEntries([...proxyNames, "BAI_API_KEY"].map((key) => [key, process.env[key]]));
afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setupGateway({ proxy = false, respond } = {}) {
  process.env.BAI_API_KEY = "test-key";
  for (const key of proxyNames) delete process.env[key];
  if (proxy) process.env.HTTPS_PROXY = "http://proxy.invalid:8080";
  let signal;
  mock.method(proxy ? http : https, "request", (options, callback) => {
    signal = options.signal;
    const req = new EventEmitter();
    let body = "";
    req.write = (chunk) => { body += chunk; };
    req.end = () => {
      signal.addEventListener("abort", () => req.emit("error", new Error("aborted")), { once: true });
      if (respond) queueMicrotask(() => respond(callback, body, options));
    };
    return req;
  });
  return () => signal;
}

test("model listing times out during connection establishment", async () => {
  const signal = setupGateway();
  await assert.rejects(() => listModels({ timeoutMs: 20 }), /B.AI 请求超时/);
  assert.equal(signal().aborted, true);
});

test("the deadline also bounds a stalled proxy CONNECT", async () => {
  const signal = setupGateway({ proxy: true });
  await assert.rejects(() => listModels({ timeoutMs: 20 }), /B.AI 请求超时/);
  assert.equal(signal().aborted, true);
});

test("the deadline continues through a stalled response body", async () => {
  setupGateway({ respond: (callback) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    callback(response);
    response.emit("data", Buffer.from('{"data":['));
  } });
  await assert.rejects(() => listModels({ timeoutMs: 20 }), /B.AI 请求超时/);
});

test("successful listings preserve gateway IDs and release the deadline", async () => {
  const signal = setupGateway({ respond: (callback) => {
    const response = new EventEmitter();
    response.statusCode = 200;
    callback(response);
    response.emit("data", Buffer.from(JSON.stringify({ data: [{ id: "test-chat-model" }] })));
    response.emit("end");
  } });
  assert.deepEqual(await listModels({ timeoutMs: 20 }), ["test-chat-model"]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(signal().aborted, false);
});
