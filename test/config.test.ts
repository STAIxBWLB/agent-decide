import { expect, test } from "bun:test";
import { parseConfig, parseProvider, selectProvider } from "../src/config.ts";
import { UsageError } from "../src/contract.ts";

const ok = { kind: "systemone", endpoint: "https://decider.example/", model: "kev-4b-2026-10", onPrem: false };

test("AC9: a pinned https provider parses with defaults and a trimmed endpoint", () => {
  expect(parseProvider("kev", ok)).toEqual({ name: "kev", kind: "systemone", endpoint: "https://decider.example", model: "kev-4b-2026-10", onPrem: false, timeoutMs: 4000, maxStateChars: 8000 });
});

test("AC9: moving aliases are refused", () => {
  for (const model of ["latest", "jev-latest", "", " "]) expect(() => parseProvider("p", { ...ok, model })).toThrow(UsageError);
});

test("AC9: plain http only for loopback or on-prem providers", () => {
  expect(() => parseProvider("p", { ...ok, endpoint: "http://decider.example" })).toThrow(UsageError);
  expect(parseProvider("p", { ...ok, endpoint: "http://127.0.0.1:8000" }).endpoint).toBe("http://127.0.0.1:8000");
  expect(parseProvider("p", { ...ok, endpoint: "http://10.0.0.5:8000", onPrem: true }).onPrem).toBe(true);
});

test("credentials in URLs, relative key files, unknown fields and bad defaults are refused", () => {
  expect(() => parseProvider("p", { ...ok, endpoint: "https://u:p@decider.example" })).toThrow(UsageError);
  expect(() => parseProvider("p", { ...ok, keyFile: "key.txt" })).toThrow(UsageError);
  expect(() => parseProvider("p", { ...ok, apiKey: "x" })).toThrow(UsageError);
  expect(() => parseProvider("p", { ...ok, onPrem: "yes" })).toThrow(UsageError);
  expect(() => parseConfig({ providers: { a: ok }, default: "b" })).toThrow(UsageError);
  expect(parseConfig({ providers: { a: ok }, default: "a" }).default).toBe("a");
});

test("review F6: prototype names never resolve to a provider", () => {
  const c = parseConfig({ providers: { a: ok } });
  for (const name of ["constructor", "toString", "hasOwnProperty"]) expect(() => selectProvider(c, name)).toThrow(UsageError);
  expect(() => parseConfig({ providers: { a: ok }, default: "constructor" })).toThrow(UsageError);
});
