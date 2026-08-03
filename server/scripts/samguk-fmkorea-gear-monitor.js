#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  SamgukFmkoreaMonitorError,
  loadAliasesByPlayerFile,
  runFmkoreaGearMonitor,
} = require("../lib/samguk-fmkorea-gear-monitor");

const DEFAULT_QUEUE_PATH = path.resolve(__dirname, "../data/samguk-observations.ndjson");

function usage() {
  return [
    "Usage: node scripts/samguk-fmkorea-gear-monitor.js [options]",
    "",
    "Options:",
    "  --queue PATH      기존 삼국지 관측 NDJSON queue",
    "  --state PATH      문서 cache와 마지막 실행시각 state JSON",
    "  --aliases PATH    {\"참가자명 또는 Pxxx\":[\"별칭\"]} JSON",
    "  --force           최소 5분 간격을 무시하고 1회 실행",
    "  --help            도움말 출력",
    "",
    "FMK 한 출처의 관측만 queue에 넣으며 단독으로 현재값을 승격하지 않습니다.",
  ].join("\n");
}

function parseArguments(argv) {
  const queueFromEnv = String(process.env.SAMGUK_OBSERVATION_QUEUE_PATH || "").trim();
  const options = {
    aliasesPath: String(process.env.SAMGUK_FMKOREA_ALIASES_PATH || "").trim() || null,
    force: false,
    queuePath: queueFromEnv ? path.resolve(queueFromEnv) : DEFAULT_QUEUE_PATH,
    statePath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--force") options.force = true;
    else if (["--queue", "--state", "--aliases"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 경로가 필요합니다.`);
      const resolved = path.resolve(value);
      if (argument === "--queue") options.queuePath = resolved;
      else if (argument === "--state") options.statePath = resolved;
      else options.aliasesPath = resolved;
      index += 1;
    } else throw new Error(`알 수 없는 옵션입니다: ${argument}`);
  }
  if (!options.statePath) {
    const stateFromEnv = String(process.env.SAMGUK_FMKOREA_STATE_PATH || "").trim();
    options.statePath = stateFromEnv
      ? path.resolve(stateFromEnv)
      : path.join(path.dirname(options.queuePath), "fmkorea-gear-monitor-state.json");
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runFmkoreaGearMonitor({
    queuePath: options.queuePath,
    statePath: options.statePath,
    aliasesByPlayer: loadAliasesByPlayerFile(options.aliasesPath),
    force: options.force,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    const code = error instanceof SamgukFmkoreaMonitorError ? error.code : "cli_error";
    process.stderr.write(`${JSON.stringify({ error: code, message: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, usage };
