import { stat } from "node:fs/promises";
import { UsageError } from "./contract.ts";

/** Read a regular file of at most `max` bytes as UTF-8; anything else is a usage error naming the file. */
export async function readTextBounded(path: string, max: number, what: string): Promise<string> {
  let info;
  try { info = await stat(path); } catch { throw new UsageError(`${what}: cannot read ${path}; check that the file exists and is readable`); }
  if (!info.isFile()) throw new UsageError(`${what}: ${path} is not a regular file`);
  if (info.size > max) throw new UsageError(`${what}: ${path} is ${info.size} bytes; the limit is ${max}`);
  return await Bun.file(path).text();
}

export async function readJsonBounded(path: string, max: number, what: string): Promise<unknown> {
  const text = await readTextBounded(path, max, what);
  try { return JSON.parse(text); } catch { throw new UsageError(`${what}: ${path} is not valid JSON`); }
}

/** Read stdin up to `max` bytes; more is a usage error rather than a silent truncation. */
export async function readStdinBounded(max: number, what: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength;
    if (size > max) throw new UsageError(`${what}: stdin exceeds ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read an HTTP body up to `max` bytes; returns undefined when it is larger. */
export async function readBodyBounded(res: Response, max: number): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
