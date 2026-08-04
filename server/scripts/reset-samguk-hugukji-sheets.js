#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_CUTOVER_AT,
  SEASON_ID,
  SamgukSeasonResetError,
  buildStaticPlan,
  createSheetsApiClient,
  executeSeasonReset,
  validateVerifiedGamcomSeed,
} = require("../lib/samguk-season-sheet-reset");

const EXECUTION_CONFIRMATION = `RESET-${SEASON_ID}`;
const MAX_SEED_BYTES = 2 * 1024 * 1024;

function usage() {
  return [
    "후국지 Google Sheets 전환 백업/초기화",
    "",
    "기본 동작은 네트워크를 사용하지 않는 plan-only입니다.",
    "",
    "  node scripts/reset-samguk-hugukji-sheets.js --plan",
    "  node scripts/reset-samguk-hugukji-sheets.js --plan \\",
    "    --gamcom-seed-json /path/season2-roster.json \\",
    "    --gamcom-territory-json /path/season2-castles.json",
    "",
    "실행은 아래 조건을 모두 명시한 경우에만 허용됩니다.",
    "",
    "  SAMGUK_HUGUKJI_RESET_EXECUTION_ALLOWED=1 \\",
    "  SAMGUK_GOOGLE_OAUTH_TOKEN_PATH=/private/token.json \\",
    "  SAMGUK_SHEET_ID=... SAMGUK_PUBLIC_SHEET_ID=... \\",
    `  node scripts/reset-samguk-hugukji-sheets.js --execute --writers-paused --confirm ${EXECUTION_CONFIRMATION}`,
    "",
    "옵션:",
    "  --plan                         plan-only 출력(기본값)",
    "  --execute                      백업 검증 후 원본 변경",
    "  --writers-paused               모든 writer/trigger 중지를 운영자가 확인했음을 표시",
    "  --confirm VALUE                정확한 실행 확인 문자열",
    "  --master-sheet-id ID           또는 SAMGUK_SHEET_ID",
    "  --public-sheet-id ID           또는 SAMGUK_PUBLIC_SHEET_ID",
    "  --token PATH                   또는 SAMGUK_GOOGLE_OAUTH_TOKEN_PATH",
    "  --cutover-at ISO               기본: " + DEFAULT_CUTOVER_AT,
    "  --gamcom-seed-json PATH        필수: 고정 hash로 검증된 season2 90명 roster seed",
    "  --gamcom-territory-json PATH   필수: 고정 hash로 검증된 season2 60개 territory seed",
    "  --help",
  ].join("\n");
}

function parseArguments(argv) {
  const result = { mode: "plan", writersPaused: false };
  const valueOptions = new Map([
    ["--confirm", "confirm"],
    ["--master-sheet-id", "masterSheetId"],
    ["--public-sheet-id", "publicSheetId"],
    ["--token", "tokenPath"],
    ["--cutover-at", "cutoverAt"],
    ["--gamcom-seed-json", "gamcomSeedPath"],
    ["--gamcom-territory-json", "gamcomTerritorySeedPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--plan" || argument === "--dry-run") result.mode = "plan";
    else if (argument === "--execute") result.mode = "execute";
    else if (argument === "--writers-paused") result.writersPaused = true;
    else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 값이 필요합니다.`);
      result[valueOptions.get(argument)] = value;
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
  }
  return result;
}

function readSeedJson(filePath, label) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const metadata = fs.lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_SEED_BYTES) {
    throw new Error(`${label}은 2MB 이하 일반 JSON 파일이어야 합니다.`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new Error(`${label} JSON을 읽지 못했습니다.`);
  }
  return value;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const masterSheetId = args.masterSheetId || process.env.SAMGUK_SHEET_ID || "<SAMGUK_SHEET_ID>";
  const publicSheetId = args.publicSheetId || process.env.SAMGUK_PUBLIC_SHEET_ID || "<SAMGUK_PUBLIC_SHEET_ID>";
  if (args.mode !== "execute") {
    const plan = buildStaticPlan(masterSheetId, publicSheetId);
    process.stdout.write(`${JSON.stringify({
      ...plan,
      requestedSeeds: {
        gamcomMemberJson: Boolean(args.gamcomSeedPath),
        gamcomTerritoryJson: Boolean(args.gamcomTerritorySeedPath),
      },
      oauthTokenRead: false,
    }, null, 2)}\n`);
    return;
  }

  if (process.env.SAMGUK_HUGUKJI_RESET_EXECUTION_ALLOWED !== "1") {
    throw new Error("SAMGUK_HUGUKJI_RESET_EXECUTION_ALLOWED=1이 필요합니다.");
  }
  if (!args.writersPaused) throw new Error("writer/trigger 중지 후 --writers-paused가 필요합니다.");
  if (args.confirm !== EXECUTION_CONFIRMATION) throw new Error(`--confirm ${EXECUTION_CONFIRMATION}가 필요합니다.`);
  const tokenPath = args.tokenPath || process.env.SAMGUK_GOOGLE_OAUTH_TOKEN_PATH || "";
  if (!tokenPath) throw new Error("OAuth token 절대 경로가 필요합니다.");
  if (!args.gamcomSeedPath || !args.gamcomTerritorySeedPath) {
    throw new Error("execute에는 --gamcom-seed-json과 --gamcom-territory-json이 모두 필요합니다.");
  }
  const cutoverAt = args.cutoverAt || DEFAULT_CUTOVER_AT;
  const gamcomMemberSeed = readSeedJson(args.gamcomSeedPath, "Gamcom roster seed");
  const gamcomTerritorySeed = readSeedJson(args.gamcomTerritorySeedPath, "Gamcom territory seed");
  validateVerifiedGamcomSeed(gamcomMemberSeed, "member", cutoverAt);
  validateVerifiedGamcomSeed(gamcomTerritorySeed, "territory", cutoverAt);
  const client = createSheetsApiClient(tokenPath);
  const result = await executeSeasonReset({
    client,
    masterSheetId,
    publicSheetId,
    cutoverAt,
    gamcomMemberSeed,
    gamcomTerritorySeed,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    const code = error instanceof SamgukSeasonResetError ? error.code : "reset_failed";
    const message = error instanceof SamgukSeasonResetError || error instanceof Error
      ? error.message
      : "후국지 Sheet 전환에 실패했습니다.";
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code,
      message,
      ...(error && typeof error === "object" && error.details ? { details: error.details } : {}),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { EXECUTION_CONFIRMATION, parseArguments, readSeedJson };
