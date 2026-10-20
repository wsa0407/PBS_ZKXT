import { normalize } from "./text.mjs";
import { batchSegments } from "./segment.mjs";

export const CATEGORIES = ["功能", "性能", "环境", "安全", "信创", "集成", "实施", "服务", "商务", "资质", "背景", "范围外"];
// Not things a PBS item has to deliver.
export const NON_DELIVERABLE = new Set(["背景", "商务", "资质", "范围外"]);

export const INPUT_TYPES = {
  tender: { label: "招标文件", hint: "这是正式招标文件，条款措辞严谨。只抽取原文明确写出的要求，inferred 一律填 false。" },
  minutes: {
    label: "会议纪要",
    hint: "这是售前沟通会议纪要，客户诉求往往是口语化描述。可以把诉求转写成规范需求；如果是从现状、痛点中推导出的需求（原文没有直接提出），inferred 填 true。“待确认事项”里的内容按原文抽取，不要当作已确定的需求。",
  },
  oral: {
    label: "用户描述",
    hint: "这是销售转述的客户口头需求，信息零散。可以把诉求转写成规范需求；如果是推导出的需求（原文没有直接提出），inferred 填 true。客户明确说“这次先不做”“以后再说”的内容，category 填“范围外”。",
  },
};

function systemPrompt(params, inputType) {
  const dictionary = Object.entries(params)
    .map(([name, item]) => `- ${name}：${item.label}（单位：${(item.units ?? [item.unit]).join("/")}）`)
    .join("\n");
  return `你是解决方案售前的需求分析师。任务：把客户材料拆成“原子需求”，一条需求只说一件事。

材料类型：${INPUT_TYPES[inputType]?.label ?? "需求材料"}。${INPUT_TYPES[inputType]?.hint ?? ""}

规则：
1. 只依据给定片段，不得补充片段中没有的内容。
2. seg_id 填需求所在片段的编号。quote 必须是该片段中连续的一段原文，逐字复制，不改写，不加省略号。
3. text 是规范化的需求表述，要保留原文中的数字、范围和对象（例如“2 年免费运维”不能写成“提供免费运维”）。
4. category 只能取：${CATEGORIES.join("、")}。项目背景、现状描述填“背景”；明确不在本期范围的填“范围外”；与其他系统打通填“集成”；温度、防护、天气等填“环境”。
5. priority：原文用“须/必须/不得/不能/要求”或带 ★、▲ 的填“必须”；用“应/希望/需要”的填“重要”；其他填“一般”。
6. 片段中出现可用于测算规模的数字时填入 params，name 只能取下面参数字典中的值，value 为数字（零下温度为负数），quote 为数字及其单位所在的原文片段。没有就给空数组。
7. 每个有实际内容的片段至少产出一条需求。

参数字典：
${dictionary}

只输出 JSON，格式：
{"requirements":[{"seg_id":"2.1.1","text":"需求的规范表述","quote":"原文片段","category":"功能","priority":"必须","inferred":false,"params":[{"name":"road_km","value":120,"quote":"约 120 公里"}]}]}`;
}

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function unitMatches(value, spec, quote) {
  const text = normalize(quote);
  const units = (spec.units ?? [spec.unit]).map((u) => normalize(u));
  const forms = [String(value), String(Math.abs(value))];
  if (Number.isInteger(value) && value >= 0 && value <= 10) forms.push(CN_DIGITS[value], ...(value === 2 ? ["两"] : []));
  return forms.some((form) =>
    units.some((unit) => {
      const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`${form.replace("-", "\\-")}(个|名|余|多)?${escaped}`, "i").test(text);
    }),
  );
}

function checkParam(p, spec, segText) {
  if (!p.quote || !segText.includes(normalize(p.quote))) return "参数引用不在原文中";
  if (!unitMatches(Number(p.value), spec, p.quote)) return `原文中 ${p.value} 后面不是单位「${(spec.units ?? [spec.unit]).join("/")}」`;
  if (spec.keywords && !spec.keywords.some((k) => segText.includes(normalize(k)))) {
    return `原文中没有出现「${spec.keywords.join("/")}」，数字可能指别的东西`;
  }
  return "";
}

export async function extractRequirements({ doc, params, inputType, llm, onBatch }) {
  const system = systemPrompt(params, inputType);
  const batches = batchSegments(doc);
  let done = 0;
  const outputs = new Array(batches.length);
  let next = 0;
  let failure;
  const validate = (data) => {
    if (!Array.isArray(data.requirements)) throw new Error("requirements 必须为数组");
  };
  const extractBatch = async (segments) => {
    try {
      const head = segments[0].chapter ? `章节：${segments[0].chapter}\n` : "";
      const user = `${head}片段：\n${segments.map((s) => `[${s.id}] ${s.text}`).join("\n")}`;
      const data = await llm.json({ step: "extract", system, user, maxTokens: 6000, validate });
      validate(data);
      return data.requirements;
    } catch (error) {
      if (error.code !== "LLM_OUTPUT_LIMIT") throw error;
      let halves;
      if (segments.length > 1) {
        const mid = Math.ceil(segments.length / 2);
        halves = [segments.slice(0, mid), segments.slice(mid)];
      } else if (segments[0].text.length > 256) {
        halves = batchSegments({ segments }, 1, Math.ceil(segments[0].text.length / 2));
      } else throw error;
      const first = await extractBatch(halves[0]);
      const rest = [];
      for (const half of halves.slice(1)) rest.push(...await extractBatch(half));
      return [...first, ...rest];
    }
  };
  // Stop scheduling after a failure and drain in-flight calls before reporting it to the job.
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (!failure && next < batches.length) {
      const index = next++;
      try {
        outputs[index] = await extractBatch(batches[index]);
        done += 1;
        onBatch?.(done, batches.length);
      } catch (error) {
        failure ??= error;
      }
    }
  }));
  if (failure) throw failure;

  const segById = new Map(doc.segments.map((s) => [s.id, s]));
  const requirements = [];
  for (const item of outputs.flat()) {
    const seg = segById.get(String(item.seg_id ?? item.clause_id ?? ""));
    if (!seg || !item.text) continue;
    const segText = normalize(seg.text);
    const quoteVerified = Boolean(item.quote) && segText.includes(normalize(item.quote));
    const found = [];
    const rejectedParams = [];
    for (const p of item.params ?? []) {
      const spec = params[p.name];
      const value = Number(p.value);
      if (!spec || !Number.isFinite(value)) continue;
      const entry = { name: p.name, label: spec.label, value, quote: p.quote };
      const reason = checkParam(p, spec, segText);
      if (reason) rejectedParams.push({ ...entry, reason });
      else found.push(entry);
    }
    const marked = seg.star || seg.triangle;
    const category = CATEGORIES.includes(item.category) ? item.category : "功能";
    requirements.push({
      seg_id: seg.id,
      chapter: seg.chapter,
      text: String(item.text),
      quote: item.quote ?? "",
      quoteVerified,
      category,
      priority: marked ? "必须" : ["必须", "重要", "一般"].includes(item.priority) ? item.priority : "一般",
      inferred: inputType !== "tender" && Boolean(item.inferred),
      star: seg.star,
      triangle: seg.triangle,
      params: found,
      rejectedParams,
    });
  }

  const order = new Map(doc.segments.map((s, i) => [s.id, i]));
  requirements.sort((a, b) => order.get(a.seg_id) - order.get(b.seg_id));
  requirements.forEach((req, index) => {
    req.id = `R${String(index + 1).padStart(3, "0")}`;
  });

  const covered = new Set(requirements.map((r) => r.seg_id));
  const missedSegments = doc.segments.filter((s) => !covered.has(s.id) && s.text.length > 6).map((s) => s.id);
  return { requirements, missedSegments };
}

export function collectParams(requirements) {
  const values = {};
  for (const req of requirements) {
    if (req.category === "范围外") continue;
    for (const p of req.params) {
      (values[p.name] ??= []).push({ value: p.value, req_id: req.id, seg_id: req.seg_id, quote: p.quote });
    }
  }
  return values;
}
