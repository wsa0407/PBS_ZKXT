import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDuplicate } from "../engine/clarify.mjs";
import { unitMatches } from "../engine/requirements.mjs";
import { assignCodes, checkConflicts, createContext, enforceLeaves, normalizeLeaf } from "../engine/pbs.mjs";
import { segmentText } from "../engine/segment.mjs";
import { applySizing, missingRules, resolveParams } from "../engine/sizing.mjs";

const seed = (path) => JSON.parse(readFileSync(new URL(`../seed/${path}`, import.meta.url), "utf8"));
const products = seed("products.json");
const sizing = seed("config/sizing_rules.json");
const template = seed("config/pbs_template.json");
const history = seed("config/history_projects.json");
const sample = (file) => readFileSync(new URL(`../seed/samples/${file}`, import.meta.url), "utf8");

function makeCtx(requirements = [], segments = []) {
  return createContext({ requirements, segments, template, products, sizing, history });
}

function leaf(fields, ctx) {
  return normalizeLeaf({ parent: String(fields.code ?? "1.1").split(".")[0], req_ids: [], ...fields }, ctx);
}

test("tender: numbered clauses, ★ only counts at the start of a clause", () => {
  const doc = segmentText(sample("tender_police.md"));
  assert.equal(doc.numbered, true);
  assert.equal(doc.meta["行业"], "公安");
  const stars = doc.segments.filter((s) => s.star).map((s) => s.id);
  assert.deepEqual(stars, ["2.1.1", "2.2.1", "3.2.1", "3.3.1", "5.1.2"]);
  const reject = doc.segments.find((s) => s.id === "5.1.3");
  assert.equal(reject.star, false);
  assert.equal(reject.rejectRule, true);
});

test("minutes and oral text are split into S-segments", () => {
  const minutes = segmentText(sample("minutes_forest.md"));
  assert.equal(minutes.numbered, false);
  assert.ok(minutes.segments.length >= 12);
  assert.match(minutes.segments[0].id, /^S\d{3}$/);
  assert.ok(minutes.segments.some((s) => s.text.includes("-25℃")));
  assert.equal(minutes.meta["时间"]?.startsWith("2026"), true);

  const oral = segmentText(sample("oral_cityadmin.txt"));
  assert.ok(oral.segments.length >= 5);
  assert.ok(oral.segments.every((s) => s.text.length >= 8));
});

test("parameter unit check", () => {
  assert.ok(unitMatches(120, sizing.params.road_km, "约 120 公里"));
  assert.ok(unitMatches(-25, sizing.params.min_temp_c, "最低气温大约 -25℃"));
  assert.ok(unitMatches(8, sizing.params.pilots, "不少于 8 名飞手"));
  assert.ok(!unitMatches(2, sizing.params.pilots, "不少于 2 个公安低空类项目"));
});

test("dock count is derived from road length; coldest temperature wins", () => {
  const resolved = resolveParams(
    {
      road_km: [{ value: 120, req_id: "R001", seg_id: "2.1.1", quote: "约 120 公里" }],
      min_temp_c: [
        { value: -30, req_id: "R010", seg_id: "3.1.1", quote: "-30℃" },
        { value: -20, req_id: "R011", seg_id: "S003", quote: "-20℃" },
      ],
    },
    sizing,
  );
  assert.equal(resolved.dock_count.value, 10);
  assert.equal(resolved.dock_count.status, "按规则推算");
  assert.equal(resolved.min_temp_c.value, -30);
  assert.equal(resolved.interfaces.status, "原文未给出，使用默认值");

  const missing = missingRules("自动机场 智能识别", resolved, sizing, []).map((m) => m.rule.id);
  assert.ok(missing.includes("R07"), "temperature below -20 needs heating kits");
  assert.ok(!missing.includes("R03"), "10 docks fit in the standard licence");
});

test("add-on licence attached to the product line is split out; product stays 1 套", () => {
  const ctx = makeCtx();
  const leaves = [leaf({ code: "1.1", name: "VisionAI 识别引擎", source: "自有产品", product_ref: "P06", sizing_rule: "R04", matched_capabilities: ["交通事故识别"] }, ctx)];
  assignCodes(leaves);
  enforceLeaves(leaves, ctx);
  assignCodes(leaves);
  const base = leaves.find((l) => l.product_ref === "P06" && !l.sizing_rule);
  const addon = leaves.find((l) => l.sizing_rule === "R04");
  assert.equal(base.qty, 1);
  assert.equal(base.unit, "套");
  assert.ok(addon && addon !== base);
  assert.ok(ctx.issues.some((i) => i.message.includes("R04")));
});

test("an add-on licence alone brings in its base product", () => {
  const ctx = makeCtx();
  const leaves = [leaf({ code: "1.1", name: "SkyOps 扩容授权", source: "自有产品", product_ref: "P01", sizing_rule: "R03" }, ctx)];
  enforceLeaves(leaves, ctx);
  assert.ok(leaves.some((l) => l.product_ref === "P01" && !l.sizing_rule && l.qty === 1));
});

test("a sizing rule is kept on one line only", () => {
  const ctx = makeCtx();
  const leaves = [
    leaf({ code: "2.1", name: "自动机场 Dock-X", source: "自有产品", product_ref: "P02", sizing_rule: "R01" }, ctx),
    leaf({ code: "5.1", name: "机场部署", source: "服务", sizing_rule: "R01" }, ctx),
  ];
  enforceLeaves(leaves, ctx);
  assert.deepEqual(leaves.filter((l) => l.sizing_rule === "R01").map((l) => l.code), ["2.1"]);
});

test("hardware products pick up their quantity rule", () => {
  const ctx = makeCtx();
  const leaves = [leaf({ code: "2.1", name: "行业无人机", source: "自有产品", product_ref: "P03", qty: 12, unit: "架" }, ctx)];
  enforceLeaves(leaves, ctx);
  assert.equal(leaves[0].sizing_rule, "R02");
  applySizing(leaves, { dock_count: { name: "dock_count", label: "自动机场数量", value: 10, status: "按规则推算" } }, sizing);
  assert.equal(leaves[0].qty, 12);
  assert.equal(leaves[0].sizing.uncertain, true);
});

test("quantities without a rule or a quote become 待估", () => {
  const segments = [{ id: "4.1.2", text: "中标方应为采购人培训不少于 8 名飞手" }];
  const requirements = [{ id: "R001", seg_id: "4.1.2", text: "培训 8 名飞手", category: "服务", priority: "重要" }];
  const ctx = makeCtx(requirements, segments);
  const leaves = [
    leaf({ code: "4.1", name: "边界接入网闸", source: "外采", qty: 2, unit: "台" }, ctx),
    leaf({ code: "6.9", name: "飞手培训", source: "外采", qty: 8, unit: "人", qty_quote: "培训不少于 8 名飞手", req_ids: ["R001"] }, ctx),
  ];
  enforceLeaves(leaves, ctx);
  assert.equal(leaves[0].qty, null);
  assert.equal(leaves[0].qtyBasis, "待估");
  assert.equal(leaves[1].qty, 8);
  assert.equal(leaves[1].qtyBasis, "原文数量");
});

test("claimed capabilities and limits must exist in the catalogue", () => {
  const ctx = makeCtx();
  const leaves = [
    leaf({ code: "1.1", name: "VisionAI", source: "自有产品", product_ref: "P06", matched_capabilities: ["违停识别", "车牌识别取证"] }, ctx),
    leaf({ code: "3.1", name: "车牌识别取证定制", source: "自研", product_ref: "P06", blocked_by: { product_ref: "P06", limit: "飞行高度超过 60 米时车牌识别准确率明显下降，不支持车牌识别取证" } }, ctx),
    leaf({ code: "3.2", name: "PGIS 对接", source: "自研", blocked_by: { product_ref: "P08", limit: "支持所有 GIS 系统" } }, ctx),
  ];
  enforceLeaves(leaves, ctx);
  assert.deepEqual(leaves[0].matched_capabilities, ["违停识别"]);
  assert.equal(leaves[1].product_ref, null, "the blocking product is not the custom gap work product");
  assert.equal(leaves[1].blocked_by.product_name, "AI 视觉识别引擎 VisionAI");
  assert.equal(leaves[2].blocked_by, null);
  assert.ok(ctx.issues.some((i) => i.message.includes("车牌识别取证")));
});

test("constraint conflicts need evidence from the product record", () => {
  const requirements = [{ id: "R020", seg_id: "3.3.1", text: "数据库须采用国产化产品", category: "信创", priority: "必须", star: true }];
  const ctx = makeCtx(requirements);
  const leaves = [leaf({ code: "1.2", name: "CommandView", source: "自有产品", product_ref: "P08" }, ctx)];
  const conflicts = checkConflicts(
    [
      { product_ref: "P08", req_id: "R020", evidence: "数据库仅支持 MySQL", reason: "不满足国产数据库" },
      { product_ref: "P08", req_id: "R020", evidence: "不支持国产化", reason: "编造" },
      { product_ref: "P07", req_id: "R020", evidence: "已适配麒麟、统信操作系统", reason: "未使用的产品" },
    ],
    leaves,
    ctx,
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].evidence, "已适配麒麟操作系统；数据库仅支持 MySQL");
});

test("model questions that repeat existing ones are dropped", () => {
  const existing = [{ question: "材料没有直接给出「自动机场数量」，按经验规则推算为 10个，请确认实际数量。", topic: "自动机场数量" }];
  assert.ok(isDuplicate("自动机场数量具体是多少个？", existing));
  assert.ok(!isDuplicate("PGIS 地图服务的接口方式是什么？", existing));
});
