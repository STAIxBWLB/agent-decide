import { constants } from "node:fs";
import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { UsageError } from "./contract.ts";

/**
 * Read a regular file of at most `max` bytes as UTF-8; anything else is a usage error naming the file.
 * The bound applies to the bytes actually read from one open handle, so a file that grows after the check cannot exceed it.
 */
export async function readTextBounded(path: string, max: number, what: string): Promise<string> {
  let handle;
  // O_NONBLOCK: opening a FIFO without a writer must not block before the regular-file check.
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { throw new UsageError(`${what}: cannot read ${path}; check that the file exists and is readable`); }
  try {
    if (!(await handle.stat()).isFile()) throw new UsageError(`${what}: ${path} is not a regular file`);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, max + 1 - size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > max) throw new UsageError(`${what}: ${path} is larger than the ${max}-byte limit`);
      chunks.push(buf.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await handle.close(); }
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

/** Read an HTTP request or response body up to `max` bytes; returns undefined when it is larger. */
export async function readBodyBounded(res: { body: ReadableStream<Uint8Array> | null }, max: number): Promise<string | undefined> {
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

/**
 * Append one line to a JSONL file (dir 0700, file 0600). A crash can leave a torn last line without "\n";
 * start a new line first so this record is not glued onto it and lost.
 */
export async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let torn = false;
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size > 0) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); torn = last[0] !== 0x0a; }
    } finally { await handle.close(); }
  } catch { /* no file yet */ }
  await appendFile(file, `${torn ? "\n" : ""}${line}\n`, { mode: 0o600 });
}
