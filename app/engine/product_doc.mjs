import { normalize } from "./text.mjs";

const SYSTEM = `你是产品资料整理专员。阅读一份产品手册或彩页，整理成产品库条目，供售前做需求匹配。

规则：
1. 只依据手册内容，不得补充手册没写的能力。
2. capabilities：产品的标准功能，每条一句话、只说一件事，尽量保留手册里的数字和型号。
3. limits：手册中写明的不包含、不支持、需选配、需定制、需外购、环境或使用条件限制。售前最需要这些信息判断外采或自研，请尽量找全。
4. xinchuang：操作系统、数据库、芯片等国产化适配情况，原文怎么写就怎么写；没有写就填空字符串。
5. 每条 capability 和 limit 都要给出 quote：手册中支撑它的一段连续原文，逐字复制。
6. unit：软件填“套”，硬件按手册填“台”“架”等。

只输出 JSON：
{"name":"产品名称","summary":"一句话简介","unit":"套","xinchuang":"...","capabilities":[{"text":"...","quote":"..."}],"limits":[{"text":"...","quote":"..."}]}`;

/** Returns a draft for human confirmation; items whose quote cannot be found in the manual are flagged, not dropped. */
export async function draftProductFromManual({ name, text, llm }) {
  const data = await llm.json({
    step: "product_doc",
    system: SYSTEM,
    user: `文件名：${name}\n\n手册内容：\n${text.slice(0, 24000)}`,
    maxTokens: 4000,
  });
  const body = normalize(text);
  const items = (list) =>
    (Array.isArray(list) ? list : [])
      .map((x) => (typeof x === "string" ? { text: x, quote: "" } : x))
      .filter((x) => x?.text)
      .map((x) => ({ text: String(x.text).trim(), quote: String(x.quote ?? ""), verified: Boolean(x.quote) && body.includes(normalize(x.quote)) }));
  return {
    name: String(data.name ?? "").trim(),
    summary: String(data.summary ?? "").trim(),
    unit: String(data.unit ?? "").trim() || "套",
    xinchuang: String(data.xinchuang ?? "").trim(),
    capabilities: items(data.capabilities),
    limits: items(data.limits),
    truncated: text.length > 24000,
  };
}
