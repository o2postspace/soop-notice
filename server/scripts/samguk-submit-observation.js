#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_CONSENSUS_WINDOW_MS,
  DEFAULT_QUEUE_MAX_BYTES,
  SamgukObservationError,
  acceptSheetBaseline,
  appendObservationQueue,
  resolveLatestAccepted,
} = require("../lib/samguk-observations");

const DEFAULT_INPUT_MAX_BYTES = 1024 * 1024;
const DEFAULT_QUEUE_PATH = path.resolve(__dirname, "../data/samguk-observations.ndjson");

function usage() {
  return [
    "Usage: node scripts/samguk-submit-observation.js [options] [input.json|-]",
    "",
    "Options:",
    "  --queue PATH       append-only NDJSON queue 경로",
    "  --baseline-sheet   입력한 sheet 관측값을 초기 baseline으로 즉시 채택",
    "  --window-ms N      교차검증 관측시간 window (기본 24시간)",
    "  --help             도움말 출력",
    "",
    "입력은 관측 JSON 객체, 객체 배열 또는 {\"observations\": [...]} 형식입니다.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    baselineSheet: false,
    inputPath: "-",
    queuePath: DEFAULT_QUEUE_PATH,
    windowMs: DEFAULT_CONSENSUS_WINDOW_MS,
  };
  let inputSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--baseline-sheet") {
      options.baselineSheet = true;
    } else if (argument === "--queue") {
      if (!argv[index + 1]) throw new Error("--queue 경로가 필요합니다.");
      options.queuePath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--window-ms") {
      if (!argv[index + 1]) throw new Error("--window-ms 값이 필요합니다.");
      options.windowMs = Number(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    } else {
      if (inputSeen) throw new Error("입력 파일은 하나만 지정할 수 있습니다.");
      options.inputPath = argument;
      inputSeen = true;
    }
  }
  return options;
}

async function readStdinLimited(maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`입력은 ${maxBytes}바이트를 넘을 수 없습니다.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readFileLimited(filePath, maxBytes) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("입력은 일반 JSON 파일이어야 합니다.");
  if (stat.size > maxBytes) throw new Error(`입력은 ${maxBytes}바이트를 넘을 수 없습니다.`);
  return fs.readFileSync(resolved, "utf8");
}

function observationsFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("입력 JSON 형식이 올바르지 않습니다.");
  }
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.observations)) {
    const keys = Object.keys(parsed);
    if (keys.length !== 1) throw new Error("observations wrapper에는 다른 필드를 넣을 수 없습니다.");
    parsed = parsed.observations;
  }
  const observations = Array.isArray(parsed) ? parsed : [parsed];
  if (observations.length === 0) throw new Error("입력 관측값이 없습니다.");
  return observations;
}

function relevantConsensus(consensus, observations) {
  const targets = new Set(observations.map(item => `${item.playerId}\u0000${item.field}`));
  return consensus.filter(item => targets.has(`${item.playerId}\u0000${item.field}`));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const source = options.inputPath === "-"
    ? await readStdinLimited(DEFAULT_INPUT_MAX_BYTES)
    : readFileLimited(options.inputPath, DEFAULT_INPUT_MAX_BYTES);
  const observations = observationsFromJson(source);
  if (options.baselineSheet) observations.forEach(acceptSheetBaseline);
  const result = appendObservationQueue(options.queuePath, observations, {
    maxBytes: DEFAULT_QUEUE_MAX_BYTES,
  });
  const baselines = options.baselineSheet ? [...result.inserted, ...result.duplicates] : [];
  const latest = resolveLatestAccepted(result.all, {
    baselines,
    windowMs: options.windowMs,
  });
  const output = {
    queue: options.queuePath,
    submitted: observations.length,
    inserted: result.inserted.length,
    duplicates: result.duplicates.length,
    observations: result.inserted,
    accepted: relevantConsensus(latest, [...result.inserted, ...result.duplicates]),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    const code = error instanceof SamgukObservationError ? error.code : "cli_error";
    process.stderr.write(`${JSON.stringify({ error: code, message: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_INPUT_MAX_BYTES,
  DEFAULT_QUEUE_PATH,
  main,
  observationsFromJson,
  parseArguments,
};
