import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getDb, resetDb } from "../server/db.mjs";
import * as models from "../server/models.mjs";

const LISTING = ["gpt-5.4-mini", "claude-sonnet-4-6", "deepseek-v4.1-flash", "qwen3.8-flash", "text-embedding-3-small"];
afterEach(() => models.setModelSource(null));

test("groupOf puts models into readable families", () => {
  assert.equal(models.groupOf("gpt-5.4-mini"), "OpenAI");
  assert.equal(models.groupOf("o3-mini"), "OpenAI");
  assert.equal(models.groupOf("claude-sonnet-4-6"), "Anthropic");
  assert.equal(models.groupOf("gemini-2.5-pro"), "Google");
  assert.equal(models.groupOf("deepseek-v4.1-flash"), "DeepSeek");
  assert.equal(models.groupOf("qwen3.8-flash"), "通义千问");
  assert.equal(models.groupOf("glm-5.3-flash"), "智谱");
  assert.equal(models.groupOf("text-embedding-3-small"), "其他（非对话模型）");
  assert.equal(models.groupOf("some-new-model"), "其他对话模型");
});

test("selected model defaults to the env model and is persisted when chosen", async () => {
  resetDb(":memory:");
  models.setModelSource(async () => LISTING);
  process.env.APP_MODEL = "gpt-5.4-mini";
  assert.equal(models.selectedModel(), "gpt-5.4-mini");

  const r = await models.chooseModel("deepseek-v4.1-flash");
  assert.equal(r.current, "deepseek-v4.1-flash");
  assert.equal(r.unverified, false);
  assert.equal(models.selectedModel(), "deepseek-v4.1-flash");
  assert.equal(getDb().prepare("SELECT value FROM settings WHERE key = 'chat_model'").get().value, "deepseek-v4.1-flash");

  await assert.rejects(() => models.chooseModel("  "), /请选择模型/);

  models.resetModel();
  assert.equal(models.selectedModel(), "gpt-5.4-mini");
});

test("a model that is not in the gateway listing is rejected", async () => {
  resetDb(":memory:");
  models.setModelSource(async () => LISTING);
  await assert.rejects(() => models.chooseModel("my-private-model"), /列表里没有/);
  assert.equal(models.selectedModel(), process.env.APP_MODEL || "gpt-5.4-mini", "selection unchanged");
});

test("when the gateway listing is unreachable the choice is allowed but flagged unverified", async () => {
  resetDb(":memory:");
  models.setModelSource(async () => {
    throw new Error("network down");
  });
  const r = await models.chooseModel("my-private-model");
  assert.equal(r.unverified, true);
  const cat = await models.modelCatalog();
  assert.equal(cat.current, "my-private-model");
  assert.ok(cat.error);
  assert.ok(cat.groups.flatMap((g) => g.models).includes("my-private-model"), "current model stays selectable");
});

test("the catalog is grouped, sorted, and keeps embedding models in their own group", async () => {
  resetDb(":memory:");
  models.setModelSource(async () => LISTING);
  const cat = await models.modelCatalog({ refresh: true });
  assert.deepEqual(
    cat.groups.map((g) => g.label),
    ["OpenAI", "Anthropic", "DeepSeek", "通义千问", "其他（非对话模型）"],
  );
  assert.deepEqual(cat.groups.at(-1).models, ["text-embedding-3-small"]);
  assert.equal(cat.error, null);
});
