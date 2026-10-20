const CLAUSE = /^(\d+(?:\.\d+){2,})\s+(.+)$/;
const SECTION = /^(\d+\.\d+)\s+(.+)$/;
const META = /^[-*]\s*([^：:\s]{2,6})[：:]\s*(.+)$/;
const LIST_PREFIX = /^(?:[-*•]\s*|\d+[.、．)]\s*|[（(]\d+[)）]\s*|[一二三四五六七八九十]+[、.．]\s*)/;

function mark(text) {
  const body = text.replace(LIST_PREFIX, "");
  return {
    star: /^\s*★/.test(body),
    triangle: /^\s*▲/.test(body),
    rejectRule: /无效投标|废标|否决投标/.test(body),
  };
}

function sentences(text) {
  const parts = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [text];
  const merged = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (merged.length && (part.length < 8 || merged.at(-1).length < 8)) merged[merged.length - 1] += part;
    else merged.push(part);
  }
  return merged;
}

/**
 * Split input into traceable segments. Tender-style numbered clauses (1.2.3) keep their numbers;
 * free text (minutes, oral descriptions) is split by paragraph / list item / sentence into S001…
 */
export function segmentText(raw) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((l) => l.trim());
  const doc = { title: "", meta: {}, chapters: [], segments: [], fullText: text, numbered: false };
  const clauseLines = lines.filter((l) => CLAUSE.test(l)).length;
  doc.numbered = clauseLines >= 3;

  let chapter = "";
  let section = "";
  let seq = 0;
  let seenHeading = false;
  const push = (id, body) => doc.segments.push({ id, chapter, section, text: body, ...mark(body) });

  for (const line of lines) {
    if (!line || line.startsWith(">")) continue;
    let m;
    if ((m = line.match(/^#\s+(.+)$/))) {
      doc.title ||= m[1].trim();
      continue;
    }
    if ((m = line.match(/^#{2,}\s+(.+)$/))) {
      chapter = m[1].trim();
      section = "";
      seenHeading = true;
      doc.chapters.push(chapter);
      continue;
    }
    if (!seenHeading && (m = line.match(META))) {
      doc.meta[m[1]] = m[2].trim();
      continue;
    }
    if (doc.numbered) {
      if ((m = line.match(CLAUSE))) push(m[1], m[2].trim());
      else if ((m = line.match(SECTION))) section = m[2].trim();
      else if (/^第.+[章节]/.test(line)) chapter = line;
      continue;
    }
    for (const sentence of sentences(line.replace(LIST_PREFIX, ""))) {
      seq += 1;
      push(`S${String(seq).padStart(3, "0")}`, sentence);
    }
  }
  return doc;
}

// Free text batches: keep chapters together, at most `size` segments per model call.
export function batchSegments(doc, size = 18) {
  const batches = [];
  let current = [];
  let chapter = null;
  for (const seg of doc.segments) {
    const split = doc.numbered ? seg.chapter !== chapter : current.length >= size;
    if (current.length && split) {
      batches.push(current);
      current = [];
    }
    chapter = seg.chapter;
    current.push(seg);
  }
  if (current.length) batches.push(current);
  return batches;
}
