// Verification-only reader for the pinned dsh v4 store. The SDK run result
// starts at its inbox receipt and excludes earlier preset-selection events.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export async function persistedEvents(home, sessionId) {
  const root = join(home, "sessions");
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    let bytes;
    try { bytes = await readFile(join(root, directory.name, sessionId, "session.v4.jsonl.zstd")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const chunks = [];
    // Each append is a separate zstd frame; decode every frame, not just the header.
    for (let offset = 0; offset < bytes.length;) {
      const frame = zstdDecompressSync(bytes.subarray(offset), { info: true });
      if (!frame.engine.bytesWritten) throw new Error("Invalid dsh session frame");
      chunks.push(frame.buffer); offset += frame.engine.bytesWritten;
    }
    return Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  throw new Error(`Persisted session not found: ${sessionId}`);
}
