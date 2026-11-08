import { expect, test } from "bun:test";
import { PACKAGE } from "../src/index.ts";
import pkg from "../package.json";

test("package name matches the export", () => {
  expect(PACKAGE).toBe(pkg.name);
  expect(Object.keys((pkg as { dependencies?: object }).dependencies ?? {})).toHaveLength(0);
});
