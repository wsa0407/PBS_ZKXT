import { extname } from "node:path";

export const SUPPORTED = [".txt", ".md", ".docx", ".pdf"];

async function optional(name) {
  try {
    return await import(name);
  } catch {
    throw new Error(`解析该格式需要依赖 ${name}，请先在 app 目录运行 npm install`);
  }
}

async function pdfText(buffer) {
  // pdf-parse 1.x runs a self-test when its index is imported as ESM; load the library file directly.
  const mod = await import("pdf-parse/lib/pdf-parse.js").catch(() => optional("pdf-parse"));
  if (mod.PDFParse) {
    const parser = new mod.PDFParse({ data: new Uint8Array(buffer) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy?.();
    }
  }
  return (await mod.default(buffer)).text;
}

export async function fileToText(name, buffer) {
  const ext = extname(name).toLowerCase();
  if (ext === ".txt" || ext === ".md") return buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!SUPPORTED.includes(ext)) throw new Error(`不支持的文件格式 ${ext || "（无扩展名）"}，支持：${SUPPORTED.join("、")}`);
  let text;
  try {
    if (ext === ".docx") {
      const mammoth = (await optional("mammoth")).default;
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = await pdfText(buffer);
    }
  } catch (error) {
    if (/npm install/.test(error.message)) throw error;
    throw new Error(`文件「${name}」无法解析，可能已损坏或加密，请另存后重试，或直接粘贴文字`, { cause: error });
  }
  if (ext === ".pdf" && text.replace(/\s/g, "").length < 20) {
    throw new Error(`「${name}」中几乎没有可识别的文字，可能是扫描件。当前版本不支持 OCR，请粘贴文字内容`);
  }
  return text;
}
