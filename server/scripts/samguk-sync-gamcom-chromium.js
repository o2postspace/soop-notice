#!/usr/bin/env node
"use strict";

const { runGamcomChromiumMonitor } = require("../lib/samguk-gamcom-chromium-monitor");

function usage() {
  return [
    "Usage: node scripts/samguk-sync-gamcom-chromium.js [--write]",
    "",
    "기본은 dry-run이며 --write일 때만 운영 Google Sheet에 batch 저장합니다.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { write: false, help: false };
  for (const argument of argv) {
    if (argument === "--write") options.write = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`알 수 없는 옵션입니다: ${argument}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const result = await runGamcomChromiumMonitor({
    write: options.write,
    chromiumPath: process.env.SAMGUK_GAMCOM_CHROMIUM_PATH,
    timeoutMs: process.env.SAMGUK_GAMCOM_CHROMIUM_TIMEOUT_MS,
    virtualTimeBudgetMs: process.env.SAMGUK_GAMCOM_VIRTUAL_TIME_BUDGET_MS,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: "gamcom_chromium_sync_failed",
      code: typeof error?.code === "string" ? error.code : "unknown",
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, usage };
