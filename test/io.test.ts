import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../src/contract.ts";
import { readTextBounded } from "../src/io.ts";
import { tempDir } from "./fakes.ts";

test("review r2: the bound is enforced on bytes read, and directories are refused", async () => {
  const dir = tempDir(), f = join(dir, "a.txt");
  writeFileSync(f, "x".repeat(10));
  expect(await readTextBounded(f, 10, "t")).toBe("x".repeat(10));
  await expect(readTextBounded(f, 9, "t")).rejects.toThrow(UsageError);
  await expect(readTextBounded(dir, 100, "t")).rejects.toThrow(UsageError);
  await expect(readTextBounded(join(dir, "missing"), 100, "t")).rejects.toThrow(UsageError);
  writeFileSync(f, "한글");
  expect(await readTextBounded(f, 6, "t")).toBe("한글");
});

test("review r4: a FIFO without a writer is refused instead of blocking", async () => {
  if (process.platform === "win32") return;
  const fifo = join(tempDir(), "pipe");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const result = await Promise.race([
    readTextBounded(fifo, 100, "t").then(() => "read", e => (e instanceof UsageError ? "usage" : "other")),
    Bun.sleep(1000).then(() => "blocked"),
  ]);
  expect(result).toBe("usage");
});
