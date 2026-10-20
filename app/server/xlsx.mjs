// Excel import/export via exceljs.
import { exportReview, auditLevelLabel, questionStatusLabel, requirementStatusLabel, impactLabel } from "../web/presentation.js";
async function excel() {
  try {
    return (await import("exceljs")).default;
  } catch {
    throw new Error("Excel 功能需要依赖 exceljs，请先在 app 目录运行 npm install");
  }
}

export const PRODUCT_COLUMNS = [
  { header: "产品名称", key: "name", width: 26 },
  { header: "简介", key: "summary", width: 30 },
  { header: "能力（每行一条）", key: "capabilities", width: 40 },
  { header: "限制（每行一条）", key: "limits", width: 48 },
  { header: "信创适配", key: "xinchuang", width: 30 },
  { header: "单位", key: "unit", width: 8 },
];

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
  row.alignment = { vertical: "middle" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

const wrap = { wrapText: true, vertical: "top" };

export async function productTemplate(products) {
  const ExcelJS = await excel();
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("产品清单");
  sheet.columns = PRODUCT_COLUMNS;
  for (const p of products) {
    sheet.addRow({ ...p, capabilities: p.capabilities.join("\n"), limits: p.limits.join("\n") }).alignment = wrap;
  }
  styleHeader(sheet);
  const help = book.addWorksheet("填写说明");
  help.columns = [{ width: 100 }];
  [
    "1. 每行一个产品，产品名称必填；按产品名称匹配，已存在的产品会被更新，不存在的会新增。",
    "2. 能力：产品标准功能，每行一条（单元格内 Alt+Enter 换行，也可以用分号分隔）。系统会逐字引用这些条目作为匹配依据。",
    "3. 限制：产品能力边界与使用条件，每行一条。请记录不支持的功能、适配依赖和待验证内容，作为核对选型的依据。",
    "4. 信创适配：操作系统、数据库、芯片等适配情况。系统会用它检查信创类硬性要求。",
    "5. 单位：套、台、架等。软件许可填“套”。",
  ].forEach((line) => help.addRow([line]));
  return Buffer.from(await book.xlsx.writeBuffer());
}

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.text) return String(v.text);
    if (v.result !== undefined) return String(v.result);
  }
  return String(v);
}

export async function parseProductSheet(buffer) {
  const ExcelJS = await excel();
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(buffer);
  } catch {
    throw new Error("无法读取该 Excel 文件，请使用系统提供的模板（.xlsx）");
  }
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error("Excel 中没有工作表");
  const header = [];
  sheet.getRow(1).eachCell((cell, col) => {
    header[col] = cellText(cell).trim();
  });
  const keyOf = (title) => PRODUCT_COLUMNS.find((c) => title && (title === c.header || title.startsWith(c.header.replace(/（.*$/, ""))))?.key;
  const columns = header.map(keyOf);
  if (!columns.includes("name")) throw new Error("第一行需要包含“产品名称”列，请使用系统提供的模板");
  const rows = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const item = {};
    row.eachCell((cell, col) => {
      if (columns[col]) item[columns[col]] = cellText(cell);
    });
    if (Object.values(item).some((v) => String(v).trim())) rows.push(item);
  });
  return rows;
}

/** view: the project view from services.projectView. */
export async function exportProject(view) {
  const ExcelJS = await excel();
  const book = new ExcelJS.Workbook();
  const groupName = new Map(view.groups.map((g) => [g.code, g.name]));
  const reqByCode = new Map(view.requirements.map((q) => [q.code, q]));
  const segByUid = new Map([...(view.sourceSnapshots ?? []), ...view.segments].map((s) => [s.uid, s]));

  const review = exportReview(view);
  const check = book.addWorksheet("导出前检查");
  check.columns = [{ header: "核对事项", key: "label", width: 24 }, { header: "当前情况", key: "text", width: 100 }];
  check.addRow({ label: "导出版本", text: review.draft ? "当前草稿，仍有待核对内容" : "当前 PBS 版本" });
  check.addRow({ label: "本轮整理状态", text: view.project.done ? "本轮已完成（人工标记）" : "整理中" });
  for (const c of review.checks) check.addRow({ label: `${c.count ? "待核对" : "已列示"} · ${c.label}`, text: c.text }).alignment = wrap;
  check.addRow({ label: "核对口径", text: "需求对应关系、引用文字可定位和本轮完成标记，均不代表产品满足全部要求或客户已验收。具体问题见审核结果。" }).alignment = wrap;
  if (view.catalog) check.addRow({ label: "方案与 BOM 取值版本", text: view.catalog.snapshot ? "使用已保存版本；与当前项目或目录的差异请核对版本提示。" : "尚未保存版本，使用当前目录与 PBS 计算的预览。" }).alignment = wrap;
  styleHeader(check);

  const pbs = book.addWorksheet("PBS 清单");
  pbs.columns = [
    { header: "编码", key: "code", width: 7 },
    { header: "一级分类", key: "group", width: 16 },
    { header: "名称", key: "name", width: 30 },
    { header: "规格说明", key: "spec", width: 36 },
    { header: "来源", key: "source", width: 9 },
    { header: "匹配产品", key: "product", width: 24 },
    { header: "匹配依据", key: "match", width: 40 },
    { header: "数量", key: "qty", width: 8 },
    { header: "单位", key: "unit", width: 6 },
    { header: "数量依据", key: "qtyBasis", width: 36 },
    { header: "关联需求", key: "reqs", width: 40 },
    { header: "关联场景", key: "scenes", width: 24 },
    { header: "依据等级", key: "basis", width: 10 },
    { header: "状态", key: "state", width: 10 },
  ];
  for (const l of view.items) {
    const m = l.match;
    const match = !m ? "" : m.type === "限制拆出" ? `${m.product_name} 限制：${m.limit}` : m.capabilities.length ? `能力：${m.capabilities.join("；")}` : "产品项";
    const qtyBasis = l.manual_qty
      ? "人工确认"
      : l.sizing?.rule_id
        ? l.sizing.error ?? `${l.sizing.rule_id} ${l.sizing.expr}（${l.sizing.inputs.map((i) => `${i.label}=${i.value}`).join("，")}）`
        : l.qty_basis === "原文数量"
          ? `原文：${l.qty_quote}`
          : l.qty_basis;
    pbs.addRow({
      code: l.code,
      group: groupName.get(l.parent),
      name: l.name,
      spec: l.spec,
      source: l.source,
      product: l.product_ref ? `${l.product_ref} ${m?.product_name ?? ""}` : "",
      match,
      qty: l.qty ?? "待确认",
      unit: l.unit,
      qtyBasis: qtyBasis === "待估" ? "数量依据待确认" : qtyBasis,
      reqs: l.req_ids.map((id) => `${id} ${reqByCode.get(id)?.text ?? ""}`).join("\n"),
      scenes: (l.scenario_ids ?? []).join("、"),
      basis: l.basis_level,
      state: l.stale ? "待复核" : l.confirmed ? "已确认" : "待确认",
    }).alignment = wrap;
  }
  styleHeader(pbs);

  const reqs = book.addWorksheet("需求对应表");
  reqs.columns = [
    { header: "需求编号", key: "code", width: 9 },
    { header: "来源", key: "seg", width: 22 },
    { header: "需求", key: "text", width: 44 },
    { header: "原文引用", key: "quote", width: 44 },
    { header: "类别", key: "category", width: 8 },
    { header: "优先级", key: "priority", width: 8 },
    { header: "标记", key: "flags", width: 10 },
    { header: "描述审阅状态", key: "status", width: 16 },
    { header: "承接 PBS", key: "leaves", width: 30 },
  ];
  for (const q of view.requirements.filter((r) => r.status !== "已删除")) {
    const seg = segByUid.get(q.seg_uid);
    reqs.addRow({
      code: q.code,
      seg: seg ? `材料${seg.material_no} ${seg.seg_id}` : q.source_note || q.origin,
      text: q.text,
      quote: q.quote,
      category: q.category,
      priority: q.priority,
      flags: [q.star && "★", q.triangle && "▲", q.inferred && "推断", q.origin !== "系统" && q.origin].filter(Boolean).join(" "),
      status: requirementStatusLabel(q.status),
      leaves: view.items
        .filter((l) => l.req_ids.includes(q.code))
        .map((l) => `${l.code} ${l.name}`)
        .join("\n"),
    }).alignment = wrap;
  }
  styleHeader(reqs);

  const scenes = book.addWorksheet("场景需求");
  scenes.columns = [
    { header: "场景编号", key: "code", width: 12 }, { header: "名称", key: "name", width: 30 },
    { header: "目标", key: "goal", width: 40 }, { header: "角色", key: "actors", width: 25 },
    { header: "条件", key: "context", width: 35 }, { header: "触发", key: "trigger", width: 30 },
    { header: "活动", key: "activities", width: 50 }, { header: "结果", key: "outcomes", width: 40 },
    { header: "范围与依赖", key: "boundaries", width: 40 }, { header: "推断", key: "assumptions", width: 40 },
    { header: "具体要求", key: "requirements", width: 45 }, { header: "字段原文依据", key: "evidence", width: 70 },
    { header: "未解决问题", key: "questions", width: 50 }, { header: "状态", key: "status", width: 12 }, { header: "版本", key: "revision", width: 8 },
  ];
  for (const s of view.scenarios ?? []) {
    scenes.addRow({ ...s, status: requirementStatusLabel(s.status), actors: s.actors.join("；"), outcomes: s.outcomes.join("；"), boundaries: s.boundaries.join("；"),
      activities: s.activities.map((a) => a.text + " [" + a.req_ids.join("、") + "]").join("\n"),
      assumptions: s.assumptions.map((a) => a.text + "（" + a.reason + "）").join("\n"),
      requirements: s.links.map((l) => l.req_id + " " + l.role + " " + (reqByCode.get(l.req_id)?.text ?? "")).join("\n"),
      evidence: s.evidence.map((e) => e.field_path + " · " + (e.material_title || "澄清Q" + e.question_id) + " · " + e.quote).join("\n"),
      questions: view.questions.filter((q) => q.scenario_ids?.includes(s.code) && ["待处理", "待答复", "已答复"].includes(q.status)).map((q) => q.question).join("\n"),
    }).alignment = wrap;
  }
  styleHeader(scenes);
  const destinations = book.addWorksheet("需求处理去向");
  destinations.columns = [{ header: "需求编号", key: "req_id", width: 12 }, { header: "内容", key: "text", width: 50 }, { header: "处理去向", key: "kinds", width: 25 }, { header: "关联场景", key: "scenarios", width: 24 }, { header: "约束适用范围", key: "scope", width: 25 }, { header: "说明", key: "note", width: 45 }];
  for (const d of view.dispositions ?? []) destinations.addRow({ ...d, text: reqByCode.get(d.req_id)?.text, kinds: d.kinds.join("、"), scenarios: d.linked_scenarios.join("、"), scope: d.scenario_ids.join("、") || (d.kinds.includes("跨场景约束") ? "整个项目" : "") }).alignment = wrap;
  styleHeader(destinations);
  const qs = book.addWorksheet("澄清问题");
  qs.columns = [
    { header: "问题", key: "question", width: 60 },
    { header: "关联场景", key: "scenario_refs", width: 24 },
    { header: "影响", key: "impact", width: 12 },
    { header: "处理状态", key: "status", width: 16 },
    { header: "负责人", key: "assignee", width: 10 },
    { header: "客户答复", key: "answer", width: 40 },
    { header: "答复来源", key: "answer_source", width: 10 },
    { header: "待确认建议", key: "suggested_answer", width: 30 },
  ];
  view.questions.filter((q) => q.status !== "已忽略").forEach((q) => (qs.addRow({ ...q, impact: impactLabel(q.impact), status: questionStatusLabel(q.status), scenario_refs: (q.scenario_ids ?? []).join("、") }).alignment = wrap));
  styleHeader(qs);

  const params = book.addWorksheet("测算参数");
  params.columns = [
    { header: "参数", key: "label", width: 20 },
    { header: "取值", key: "value", width: 10 },
    { header: "单位", key: "unit", width: 8 },
    { header: "来源", key: "status", width: 24 },
  ];
  view.params.filter((p) => p.value !== null).forEach((p) => params.addRow(p));
  styleHeader(params);

  const risks = book.addWorksheet("审核结果");
  risks.columns = [
    { header: "级别", key: "level", width: 8 },
    { header: "检查项", key: "type", width: 16 },
    { header: "说明", key: "message", width: 100 },
  ];
  view.audit.forEach((f) => (risks.addRow({ ...f, level: auditLevelLabel(f.level) }).alignment = wrap));
  styleHeader(risks);

  if (view.catalog) {
    const snapshot = view.catalog.snapshot ?? view.catalog.preview;
    const status = view.catalog.snapshot ? view.catalog.snapshot_stale ? "已保存版本待复核" : "已保存版本" : "当前预览（未保存版本）";
    const solutions = book.addWorksheet("解决方案产品关系");
    solutions.columns = [
      { header: "方案编号", key: "id", width: 18 }, { header: "项目方案", key: "name", width: 32 },
      { header: "客户场景", key: "scenes", width: 22 }, { header: "原始需求", key: "reqs", width: 22 },
      { header: "产品组合（PBS项）", key: "products", width: 46 }, { header: "选型与差距说明", key: "notes", width: 60 },
      { header: "目录版本", key: "version", width: 20 }, { header: "快照状态", key: "status", width: 30 },
    ];
    for (const s of snapshot.solutions) solutions.addRow({ id: s.id, name: s.name, scenes: s.scenario_ids.join("、"), reqs: s.req_ids.join("、"), products: s.products.map((p) => `${p.code} ${p.name}`).join("\n"), notes: s.design_notes, version: `${snapshot.catalog_version} / 修订${snapshot.catalog_revision}`, status }).alignment = wrap;
    if (snapshot.unassigned.length) solutions.addRow({ name: "未关联方案的PBS项", products: snapshot.products.filter((p) => snapshot.unassigned.includes(p.id)).map((p) => `${p.code} ${p.name}`).join("\n"), status }).alignment = wrap;
    styleHeader(solutions);
    const bom = book.addWorksheet("产品BOM组成");
    bom.columns = [
      { header: "PBS项", key: "item", width: 32 }, { header: "产品数量", key: "qty", width: 12 },
      { header: "BOM版本", key: "version", width: 30 }, { header: "组成路径", key: "path", width: 60 },
      { header: "组成项", key: "name", width: 36 }, { header: "层级口径", key: "node_type", width: 28 }, { header: "单产品用量", key: "per", width: 14 },
      { header: "展开用量", key: "total", width: 14 }, { header: "单位", key: "unit", width: 8 },
      { header: "来源", key: "source", width: 10 }, { header: "选配条件", key: "condition", width: 40 },
      { header: "数据性质与状态", key: "status", width: 48 },
    ];
    // Unique PBS list, not the per-solution copies, prevents counting shared products twice.
    for (const p of snapshot.products) {
      if (!p.bom.length) bom.addRow({ item: `${p.code} ${p.name}`, qty: p.qty ?? "待确认", status: `${status}；${p.warnings.join("；") || "未维护BOM"}` }).alignment = wrap;
      for (const row of p.bom) bom.addRow({ item: `${p.code} ${p.name}`, qty: p.qty ?? "待确认", version: `${row.bom_id}@${row.bom_version}`, path: row.path, name: row.name, node_type: row.has_children ? "组成组（不与子项累计）" : row.included ? "明细" : "可选未纳入", per: row.per_product_qty ?? "待确认", total: row.included ? row.total_qty ?? "待确认" : "未选配", unit: row.unit, source: row.source, condition: row.condition, status: `${row.bom_kind}；${status}` }).alignment = wrap;
    }
    bom.addRow({ name: snapshot.note, status: snapshot.warnings.join("；") }).alignment = wrap;
    styleHeader(bom);
  }

  return Buffer.from(await book.xlsx.writeBuffer());
}
