import { expect, test } from "bun:test";
import { PACKAGE } from "../src/index.ts";
import pkg from "../package.json";

test("package name matches the export", () => {
  expect(PACKAGE).toBe(pkg.name);
  // Runtime dependencies: exact-pinned first-party @staix/* packages only (AGENTS.md, scripts/check-boundary.ts).
  expect((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}).toEqual({ "@staix/cli-output": "0.1.3" });
});
