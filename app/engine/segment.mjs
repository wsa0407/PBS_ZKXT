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
  let continuation = null;
  const push = (id, body) => doc.segments.push({ id, chapter, section, text: body, ...mark(body) });

  for (const line of lines) {
    if (!line || line.startsWith(">")) continue;
    let m;
    if ((m = line.match(/^#\s+(.+)$/))) {
      continuation = null;
      doc.title ||= m[1].trim();
      continue;
    }
    if ((m = line.match(/^#{2,}\s+(.+)$/))) {
      continuation = null;
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
      if ((m = line.match(CLAUSE))) {
        push(m[1], m[2].trim());
        continuation = doc.segments.at(-1);
      } else if ((m = line.match(SECTION))) {
        section = m[2].trim();
        continuation = null;
      } else if (/^第.+[章节]/.test(line)) {
        chapter = line;
        continuation = null;
      } else if (continuation) {
        continuation.text += `\n${line}`;
        continuation.rejectRule ||= /无效投标|废标|否决投标/.test(line);
      } else {
        // Unnumbered introductions also carry requirements; keep their own stable segment.
        push(`S${String(++seq).padStart(3, "0")}`, line);
      }
      continue;
    }
    for (const sentence of sentences(line.replace(LIST_PREFIX, ""))) {
      seq += 1;
      push(`S${String(seq).padStart(3, "0")}`, sentence);
    }
  }
  return doc;
}

// Bound both segment count and input size for every document, including numbered tenders.
// Large source segments keep their original ID so quotes still trace to the unchanged source.
