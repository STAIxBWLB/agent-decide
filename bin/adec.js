#!/usr/bin/env -S bun --smol
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 2)))) {
  console.error("adec: Bun >=1.4.2 is required. Install Bun: https://bun.sh");
  process.exit(1);
}
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
