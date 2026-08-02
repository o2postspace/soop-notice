const FALLBACK_PAYLOAD = require("../data/samguk-fallback.json");
const { calculateRosterPowerIndexes } = require("./samguk-power-index");

const DEFAULT_SHEET_ID = "1xC3leW9fFl4ytHI6i2UkQ8iViBFIwjLrug66lYmVckY";
const DEFAULT_TABS = Object.freeze({
  members: "현재현황",
  territories: "영토현황",
  rules: "게임정보",
  equipment: "장비현황",
});
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const EXPECTED_MEMBER_COUNT = 90;
const EXPECTED_TERRITORY_COUNT = 60;
const SOOP_ID_PATTERN = /^[A-Za-z0-9_]{1,30}$/;
const RULER_JOBS = new Set(["조조", "유비", "손권"]);
const EQUIPMENT_SLOTS = Object.freeze([
  ["weapon1", ["무기각인1", "무기 각인1"]],
  ["weapon2", ["무기각인2", "무기 각인2"]],
  ["weapon3", ["무기각인3", "무기 각인3"]],
  ["helmet1", ["두갑각인1", "두갑 각인1"]],
  ["helmet2", ["두갑각인2", "두갑 각인2"]],
  ["helmet3", ["두갑각인3", "두갑 각인3"]],
  ["armor1", ["흉갑각인1", "흉갑 각인1"]],
  ["armor2", ["흉갑각인2", "흉갑 각인2"]],
  ["armor3", ["흉갑각인3", "흉갑 각인3"]],
  ["shoes1", ["각갑각인1", "각갑 각인1"]],
  ["shoes2", ["각갑각인2", "각갑 각인2"]],
  ["shoes3", ["각갑각인3", "각갑 각인3"]],
]);

class SamgukSheetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukSheetError";
    this.code = code;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV text must be a string");

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new SamgukSheetError("invalid_csv", "CSV 따옴표가 닫히지 않았습니다.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  while (rows.length > 0 && rows[rows.length - 1].every(cell => String(cell).trim() === "")) {
    rows.pop();
  }
  return rows;
}

function makeColumnMap(headers, specification) {
  const normalized = headers.map(normalizeHeader);
  const columns = {};
  const missing = [];

  for (const [key, config] of Object.entries(specification)) {
    const aliases = config.aliases.map(normalizeHeader);
    const index = normalized.findIndex(header => aliases.includes(header));
    columns[key] = index;
    if (config.required && index < 0) missing.push(config.aliases[0]);
  }

  if (missing.length > 0) {
    throw new SamgukSheetError("schema_error", `필수 헤더가 없습니다: ${missing.join(", ")}`);
  }
  return columns;
}

function cell(row, index) {
  return index >= 0 ? String(row[index] ?? "").trim() : "";
}

function nullableNumber(value, label, rowNumber, warnings, maximum = Infinity) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-" || raw === "—" || /^#(?:N\/A|VALUE!|REF!|DIV\/0!)/i.test(raw)) {
    return null;
  }

  const parsed = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    warnings.push(`${rowNumber}행 ${label} 값 '${raw}'을(를) 제외했습니다.`);
    return null;
  }
  return parsed;
}

function normalizeNation(value, { allowUnclaimed = false } = {}) {
  const raw = String(value || "").trim();
  if (["위", "위나라", "魏"].includes(raw)) return "위";
  if (["촉", "촉나라", "蜀"].includes(raw)) return "촉";
  if (["오", "오나라", "吳"].includes(raw)) return "오";
  if (allowUnclaimed && ["", "미점령", "없음"].includes(raw)) return "미점령";
  if (allowUnclaimed && raw === "황무지") return "황무지";
  return null;
}

function normalizeTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const local = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (local) {
    const [, year, month, day, hour, minute, second = "00"] = local;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+09:00`;
    const timestamp = Date.parse(iso);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : raw;
}

function normalizeReviewStatus(value, fallback = "기준값") {
  const raw = String(value || "").trim();
  if (!raw || ["검수대기", "미확인", "pending"].includes(raw.toLowerCase())) return fallback;
  return raw;
}

function normalizeSingleSourceType(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (["fmkorea", "fmk", "fm코리아", "에펨코리아", "에펨"].includes(token)) return "fmkorea";
  if (["gamcom", "감컴", "삼국지지통실", "외부참고"].includes(token)) return "gamcom";
  if (["broadcast", "방송", "직접방송", "방송화면", "다시보기", "클립", "vod", "soop"].includes(token)) {
    return "broadcast";
  }
  if (["sheet", "googlesheet", "시트", "구글시트", "공개현황표", "관리자입력"].includes(token)) return "sheet";
  return null;
}

function normalizeSourceType(value) {
  const sources = new Set(String(value || "").split(/[,|+\/·]/).map(normalizeSingleSourceType).filter(Boolean));
  const canonical = ["sheet", "gamcom", "fmkorea", "broadcast"].filter(source => sources.has(source));
  return canonical.length > 0 ? canonical.join("+") : "sheet";
}

function normalizeSourceCount(value, rowNumber, warnings) {
  const raw = String(value ?? "").trim();
  if (!raw) return 1;
  const parsed = Number(raw.replace(/,/g, ""));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    warnings.push(`${rowNumber}행 교차검증수 값 '${raw}'을(를) 1로 처리했습니다.`);
    return 1;
  }
  return parsed;
}

function normalizeVerificationStatus(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (["broadcastverified", "방송교차검증", "방송검증", "직접방송확인"].includes(token)) {
    return "broadcast-verified";
  }
  if (["crossverified", "교차검증", "교차검증완료", "verified", "검증완료"].includes(token)) {
    return "cross-verified";
  }
  if (["conflict", "충돌", "불일치"].includes(token)) return "conflict";
  return "baseline";
}

function parseEngravingCell(value, slot, rowNumber, warnings) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return { slot, state: "unknown", name: null, value: null, unit: null };

  const token = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (["없음", "미장착", "빈칸", "empty", "none"].includes(token)) {
    return { slot, state: "empty", name: null, value: null, unit: null };
  }
  if (["해당없음", "미적용", "n/a", "na", "notapplicable", "-", "—"].includes(token)) {
    return { slot, state: "not_applicable", name: null, value: null, unit: null };
  }

  const numeric = /^(.*?)[\s:：]*([+-]?\d+(?:\.\d+)?)\s*(%|퍼센트)?$/.exec(raw);
  if (numeric) {
    const name = numeric[1].trim();
    const parsed = Number(numeric[2]);
    if (!name || !Number.isFinite(parsed) || parsed < 0) {
      warnings.push(`${rowNumber}행 ${slot} 각인 '${raw}'을(를) 제외했습니다.`);
      return { slot, state: "unknown", name: null, value: null, unit: null };
    }
    return {
      slot,
      state: "observed",
      name,
      value: parsed,
      unit: numeric[3] ? "%" : "value",
    };
  }

  if (raw.length > 80) {
    warnings.push(`${rowNumber}행 ${slot} 각인명이 너무 길어 제외했습니다.`);
    return { slot, state: "unknown", name: null, value: null, unit: null };
  }
  return { slot, state: "observed", name: raw, value: 1, unit: "presence" };
}

function parseEquipmentCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new SamgukSheetError("empty_sheet", "장비현황 시트가 비어 있습니다.");

  const specification = {
    name: { aliases: ["닉네임", "이름", "스트리머"], required: true },
    soopId: { aliases: ["SOOP_ID", "SOOP ID", "BJ_ID"], required: false },
    observedAt: { aliases: ["최종확인", "확인시각"], required: false },
    evidence: { aliases: ["최근근거", "근거", "근거(URL/타임코드)"], required: false },
    sourceType: { aliases: ["출처종류", "출처", "출처종류/출처"], required: false },
    sourceCount: { aliases: ["교차검증수"], required: false },
  };
  EQUIPMENT_SLOTS.forEach(([slot, aliases]) => {
    specification[slot] = { aliases, required: true };
  });
  const columns = makeColumnMap(rows[0], specification);
  const equipment = [];
  const warnings = [];
  const seenKeys = new Set();

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every(entry => String(entry).trim() === "")) continue;
    const rowNumber = index + 1;
    const name = cell(row, columns.name);
    const rawSoopId = cell(row, columns.soopId);
    const soopId = SOOP_ID_PATTERN.test(rawSoopId) ? rawSoopId : null;
    if (!name) {
      warnings.push(`${rowNumber}행 장비 참가자 닉네임이 없어 제외했습니다.`);
      continue;
    }
    if (rawSoopId && !soopId) warnings.push(`${rowNumber}행 SOOP_ID '${rawSoopId}'을(를) 닉네임 매칭으로 처리합니다.`);
    const key = soopId ? `id:${soopId}` : `name:${name}`;
    if (seenKeys.has(key)) {
      warnings.push(`${rowNumber}행 장비 참가자 '${name}'가 중복되어 제외했습니다.`);
      continue;
    }
    seenKeys.add(key);
    equipment.push({
      name,
      soopId,
      engravings: EQUIPMENT_SLOTS.map(([slot]) => (
        parseEngravingCell(cell(row, columns[slot]), slot, rowNumber, warnings)
      )),
      observedAt: normalizeTimestamp(cell(row, columns.observedAt)),
      evidence: cell(row, columns.evidence) || null,
      sourceType: normalizeSourceType(cell(row, columns.sourceType)),
      sourceCount: normalizeSourceCount(cell(row, columns.sourceCount), rowNumber, warnings),
    });
  }

  if (equipment.length === 0) throw new SamgukSheetError("empty_sheet", "유효한 장비 참가자가 없습니다.");
  return { equipment, warnings };
}

function mergeEquipmentData(members, equipment) {
  if (!Array.isArray(members) || !Array.isArray(equipment)) {
    throw new TypeError("members와 equipment는 배열이어야 합니다.");
  }
  const merged = members.map(member => ({ ...member }));
  const bySoopId = new Map(merged.filter(member => member.soopId).map((member, index) => [member.soopId, index]));
  const byName = new Map(merged.filter(member => member.name).map((member, index) => [member.name, index]));
  const warnings = [];
  const assigned = new Set();

  equipment.forEach(row => {
    const index = row.soopId
      ? bySoopId.get(row.soopId)
      : byName.get(row.name);
    if (index === undefined) {
      warnings.push(`장비현황 참가자 '${row.name}'을(를) 현재현황에서 찾지 못했습니다.`);
      return;
    }
    if (assigned.has(index)) {
      warnings.push(`장비현황 참가자 '${merged[index].name}'의 중복 행을 제외했습니다.`);
      return;
    }
    assigned.add(index);
    const ruler = RULER_JOBS.has(String(merged[index].job || "").normalize("NFKC").trim());
    merged[index] = {
      ...merged[index],
      engravings: row.engravings.map(engraving => {
        if (!ruler && String(engraving.slot || "").startsWith("helmet")) {
          return {
            ...engraving,
            state: "not_applicable",
            name: null,
            value: null,
            unit: null,
          };
        }
        return { ...engraving };
      }),
      equipmentObservedAt: row.observedAt,
      equipmentEvidence: row.evidence,
      equipmentSourceType: row.sourceType,
      equipmentSourceCount: row.sourceCount,
    };
  });
  return { members: merged, warnings };
}

function enrichMembersWithPowerIndex(members) {
  const normalizedMembers = members.map(member => ({
    ...member,
    maxHealth: member.maxHealth ?? null,
    attackPower: member.attackPower ?? null,
    basicAttackDamage: member.basicAttackDamage ?? null,
    basicAttackSampleCount: member.basicAttackSampleCount ?? null,
    basicAttackTarget: member.basicAttackTarget || null,
    combatConditions: member.combatConditions || null,
    engravings: Array.isArray(member.engravings) ? member.engravings : [],
    equipmentObservedAt: member.equipmentObservedAt || null,
    equipmentEvidence: member.equipmentEvidence || null,
    equipmentSourceType: member.equipmentSourceType || null,
    equipmentSourceCount: member.equipmentSourceCount ?? null,
  }));
  const indexes = calculateRosterPowerIndexes(normalizedMembers);
  const knownPowerValue = value => {
    if (typeof value === "number") return Number.isFinite(value);
    return value && typeof value === "object" && ["observed", "empty"].includes(value.state);
  };
  const populationSample = normalizedMembers.filter(member => (
    knownPowerValue(member.level)
    && ["strength", "agility", "vitality", "intelligence"].every(field => knownPowerValue(member[field]))
  )).length;
  const populationRequired = Math.min(
    normalizedMembers.length,
    Math.max(30, Math.ceil(normalizedMembers.length * 0.70)),
  );
  const fieldSamples = Object.freeze({
    level: normalizedMembers.filter(member => knownPowerValue(member.level)).length,
    strength: normalizedMembers.filter(member => knownPowerValue(member.strength)).length,
    agility: normalizedMembers.filter(member => knownPowerValue(member.agility)).length,
    vitality: normalizedMembers.filter(member => knownPowerValue(member.vitality)).length,
    intelligence: normalizedMembers.filter(member => knownPowerValue(member.intelligence)).length,
  });
  const powerPopulation = {
    sample: populationSample,
    required: populationRequired,
    coverage: Number((100 * populationSample / normalizedMembers.length).toFixed(4)),
    ready: populationSample >= populationRequired,
    fieldSamples,
  };
  return normalizedMembers.map((member, index) => {
    const power = indexes[index];
    const mainSourcesVerified = Number(member.sourceCount) >= 2
      && ["cross-verified", "broadcast-verified"].includes(member.verificationStatus)
      && Number.isFinite(Date.parse(member.observedAt || ""));
    const equipmentSourceKinds = new Set(String(member.equipmentSourceType || "")
      .split("+").map(value => value.trim()).filter(Boolean));
    const equipmentSourcesVerified = member.engravings.length > 0
      && Number(member.equipmentSourceCount) >= 2
      && equipmentSourceKinds.size >= 2
      && Number.isFinite(Date.parse(member.equipmentObservedAt || ""));
    const powerSourcesVerified = mainSourcesVerified && equipmentSourcesVerified;
    const powerVerified = powerSourcesVerified && powerPopulation.ready;
    const powerStatus = power.status === "confirmed" && powerVerified
      ? "confirmed"
      : power.rankable ? "provisional" : "insufficient";
    return {
      ...member,
      powerIndex: power.score,
      powerRankScore: power.lower,
      powerVersion: power.version,
      powerCoverage: power.coverage,
      powerStatus,
      powerRankable: power.rankable,
      powerSourcesVerified,
      powerPopulation: { ...powerPopulation },
      powerVerified,
      powerRange: { lower: power.lower, upper: power.upper },
      powerComponents: power.components,
    };
  });
}

function parseMembersCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new SamgukSheetError("empty_sheet", "현재현황 시트가 비어 있습니다.");

  const columns = makeColumnMap(rows[0], {
    nation: { aliases: ["국가"], required: true },
    crew: { aliases: ["세력/길드", "세력", "길드", "크루"], required: true },
    name: { aliases: ["닉네임", "이름", "스트리머"], required: true },
    soopId: { aliases: ["SOOP_ID", "SOOP ID", "BJ_ID"], required: true },
    job: { aliases: ["장수/직업", "장수", "직업"], required: true },
    level: { aliases: ["레벨", "Lv"], required: true },
    horse: { aliases: ["말"], required: true },
    horseLevel: { aliases: ["말강화", "말 강화"], required: true },
    weapon: { aliases: ["무기강화", "무기"], required: true },
    helmet: { aliases: ["두갑강화", "두갑"], required: true },
    armor: { aliases: ["흉갑강화", "흉갑"], required: true },
    shoes: { aliases: ["각갑강화", "각갑"], required: true },
    strength: { aliases: ["무력"], required: true },
    agility: { aliases: ["기민"], required: true },
    vitality: { aliases: ["기력"], required: true },
    intelligence: { aliases: ["지모"], required: true },
    powerScore: { aliases: ["무력점수", "powerScore"], required: false },
    maxHealth: { aliases: ["최대체력", "최대HP", "maxHealth"], required: false },
    attackPower: { aliases: ["공격력", "attackPower"], required: false },
    basicAttackDamage: { aliases: ["평타피해대표값", "평타피해", "basicAttackDamage"], required: false },
    basicAttackSampleCount: { aliases: ["평타표본수", "basicAttackSampleCount"], required: false },
    basicAttackTarget: { aliases: ["평타대상", "basicAttackTarget"], required: false },
    combatConditions: { aliases: ["전투조건", "combatConditions"], required: false },
    observedAt: { aliases: ["최종확인", "확인시각"], required: true },
    evidence: { aliases: ["최근근거", "근거", "근거(URL/타임코드)"], required: true },
    reviewStatus: { aliases: ["검수상태", "검증상태"], required: true },
    sourceType: { aliases: ["출처종류", "출처", "출처종류/출처"], required: false },
    sourceCount: { aliases: ["교차검증수"], required: false },
    verificationStatus: { aliases: ["검증상태"], required: false },
  });

  const members = [];
  const warnings = [];
  const seenIds = new Set();

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every(value => String(value).trim() === "")) continue;
    const rowNumber = index + 1;
    const name = cell(row, columns.name);
    const soopId = cell(row, columns.soopId);
    const nation = normalizeNation(cell(row, columns.nation));

    if (!name || !SOOP_ID_PATTERN.test(soopId) || !nation) {
      warnings.push(`${rowNumber}행 참가자 식별값이 올바르지 않아 제외했습니다.`);
      continue;
    }
    if (seenIds.has(soopId)) {
      warnings.push(`${rowNumber}행 SOOP_ID '${soopId}'가 중복되어 제외했습니다.`);
      continue;
    }
    seenIds.add(soopId);

    members.push({
      name,
      soopId,
      nation,
      crew: cell(row, columns.crew),
      job: cell(row, columns.job) || null,
      level: nullableNumber(cell(row, columns.level), "레벨", rowNumber, warnings),
      horse: cell(row, columns.horse) || null,
      horseLevel: nullableNumber(cell(row, columns.horseLevel), "말강화", rowNumber, warnings, 80),
      weapon: nullableNumber(cell(row, columns.weapon), "무기강화", rowNumber, warnings, 15),
      helmet: nullableNumber(cell(row, columns.helmet), "두갑강화", rowNumber, warnings, 15),
      armor: nullableNumber(cell(row, columns.armor), "흉갑강화", rowNumber, warnings, 15),
      shoes: nullableNumber(cell(row, columns.shoes), "각갑강화", rowNumber, warnings, 15),
      strength: nullableNumber(cell(row, columns.strength), "무력", rowNumber, warnings),
      agility: nullableNumber(cell(row, columns.agility), "기민", rowNumber, warnings),
      vitality: nullableNumber(cell(row, columns.vitality), "기력", rowNumber, warnings),
      intelligence: nullableNumber(cell(row, columns.intelligence), "지모", rowNumber, warnings),
      powerScore: nullableNumber(cell(row, columns.powerScore), "무력점수", rowNumber, warnings),
      maxHealth: nullableNumber(cell(row, columns.maxHealth), "최대체력", rowNumber, warnings, 1_000_000),
      attackPower: nullableNumber(cell(row, columns.attackPower), "공격력", rowNumber, warnings, 1_000_000),
      basicAttackDamage: nullableNumber(
        cell(row, columns.basicAttackDamage), "평타피해대표값", rowNumber, warnings, 1_000_000,
      ),
      basicAttackSampleCount: nullableNumber(
        cell(row, columns.basicAttackSampleCount), "평타표본수", rowNumber, warnings, 10_000,
      ),
      basicAttackTarget: cell(row, columns.basicAttackTarget) || null,
      combatConditions: cell(row, columns.combatConditions) || null,
      sourceType: normalizeSourceType(cell(row, columns.sourceType)),
      sourceCount: normalizeSourceCount(cell(row, columns.sourceCount), rowNumber, warnings),
      verificationStatus: normalizeVerificationStatus(cell(row, columns.verificationStatus)),
      reviewStatus: normalizeReviewStatus(cell(row, columns.reviewStatus)),
      observedAt: normalizeTimestamp(cell(row, columns.observedAt)),
      evidence: cell(row, columns.evidence) || null,
    });
  }

  if (members.length === 0) throw new SamgukSheetError("empty_sheet", "유효한 참가자가 없습니다.");
  if (members.length !== 90) warnings.push(`현재현황 참가자가 ${members.length}/90명입니다.`);
  return { members, warnings };
}

function parseBoolean(value) {
  return ["1", "true", "y", "yes", "예", "수도", "o", "○"].includes(String(value || "").trim().toLowerCase());
}

function normalizeFacility(value, rowNumber, warnings) {
  const raw = String(value || "").trim() || "없음";
  if (["없음", "병영", "성채", "장원"].includes(raw)) return raw;
  warnings.push(`${rowNumber}행 거점유형 '${raw}'을(를) '없음'으로 처리했습니다.`);
  return "없음";
}

function parseTerritoriesCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new SamgukSheetError("empty_sheet", "영토현황 시트가 비어 있습니다.");

  const columns = makeColumnMap(rows[0], {
    id: { aliases: ["영토ID", "territory_id", "castleKey"], required: true },
    number: { aliases: ["번호", "영토번호"], required: true },
    x: { aliases: ["X", "좌표X"], required: true },
    y: { aliases: ["Y", "좌표Y"], required: true },
    owner: { aliases: ["소유국", "소유", "owner"], required: true },
    capital: { aliases: ["수도", "capital"], required: true },
    facility: { aliases: ["거점유형", "시설", "facility"], required: true },
    level: { aliases: ["레벨", "영토레벨"], required: true },
    observedAt: { aliases: ["최종확인", "확인시각"], required: true },
    evidence: { aliases: ["근거", "최근근거"], required: true },
    reviewStatus: { aliases: ["검수상태", "검증상태"], required: true },
    sourceType: { aliases: ["출처종류", "출처", "출처종류/출처"], required: false },
    sourceCount: { aliases: ["교차검증수"], required: false },
    verificationStatus: { aliases: ["검증상태"], required: false },
  });

  const territories = [];
  const warnings = [];
  const seenIds = new Set();
  const seenNumbers = new Set();

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every(value => String(value).trim() === "")) continue;
    const rowNumber = index + 1;
    const id = cell(row, columns.id);
    const number = nullableNumber(cell(row, columns.number), "번호", rowNumber, warnings);
    const owner = normalizeNation(cell(row, columns.owner), { allowUnclaimed: true });

    if (!id || number === null || number < 1 || number > 60 || !Number.isInteger(number) || !owner) {
      warnings.push(`${rowNumber}행 영토 식별값이 올바르지 않아 제외했습니다.`);
      continue;
    }
    if (seenIds.has(id) || seenNumbers.has(number)) {
      warnings.push(`${rowNumber}행 영토 ID 또는 번호가 중복되어 제외했습니다.`);
      continue;
    }
    seenIds.add(id);
    seenNumbers.add(number);

    territories.push({
      id,
      number,
      x: nullableNumber(cell(row, columns.x), "X", rowNumber, warnings),
      y: nullableNumber(cell(row, columns.y), "Y", rowNumber, warnings),
      owner,
      capital: parseBoolean(cell(row, columns.capital)),
      facility: normalizeFacility(cell(row, columns.facility), rowNumber, warnings),
      level: nullableNumber(cell(row, columns.level), "레벨", rowNumber, warnings),
      sourceType: normalizeSourceType(cell(row, columns.sourceType)),
      sourceCount: normalizeSourceCount(cell(row, columns.sourceCount), rowNumber, warnings),
      verificationStatus: normalizeVerificationStatus(cell(row, columns.verificationStatus)),
      reviewStatus: normalizeReviewStatus(cell(row, columns.reviewStatus)),
      observedAt: normalizeTimestamp(cell(row, columns.observedAt)),
      evidence: cell(row, columns.evidence) || null,
    });
  }

  if (territories.length === 0) throw new SamgukSheetError("empty_sheet", "유효한 영토가 없습니다.");
  territories.sort((left, right) => left.number - right.number);
  if (territories.length !== 60) warnings.push(`영토현황이 ${territories.length}/60개입니다.`);
  return { territories, warnings };
}

function parseRulesCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new SamgukSheetError("empty_sheet", "게임정보 시트가 비어 있습니다.");

  const columns = makeColumnMap(rows[0], {
    category: { aliases: ["분류", "카테고리"], required: true },
    title: { aliases: ["항목", "제목"], required: true },
    description: { aliases: ["내용", "설명"], required: true },
    sourceUrl: { aliases: ["근거", "출처", "출처URL"], required: true },
    sourceDate: { aliases: ["기준일", "출처일", "작성일"], required: false },
    reviewStatus: { aliases: ["검수상태"], required: true },
  });

  const rules = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every(value => String(value).trim() === "")) continue;
    const title = cell(row, columns.title);
    const description = cell(row, columns.description);
    if (!title || !description) continue;
    rules.push({
      category: cell(row, columns.category) || "기타",
      title,
      description,
      sourceUrl: cell(row, columns.sourceUrl) || null,
      sourceDate: normalizeTimestamp(cell(row, columns.sourceDate)),
      reviewStatus: normalizeReviewStatus(cell(row, columns.reviewStatus), "참고"),
    });
  }
  if (rules.length === 0) throw new SamgukSheetError("empty_sheet", "유효한 게임정보가 없습니다.");
  return { rules, warnings: [] };
}

function validateSheetId(sheetId) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(sheetId)) {
    throw new SamgukSheetError("config_error", "Google Sheet ID가 올바르지 않습니다.");
  }
}

function buildSheetUrl(sheetId) {
  validateSheetId(sheetId);
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

function buildCsvUrl(sheetId, sheetName) {
  validateSheetId(sheetId);
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set("tqx", "out:csv");
  url.searchParams.set("sheet", sheetName);
  url.searchParams.set("headers", "1");
  return url.toString();
}

async function readTextLimited(response, maxBytes) {
  const declaredLength = Number.parseInt(response.headers?.get?.("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SamgukSheetError("response_too_large", "Google Sheet 응답이 크기 제한을 초과했습니다.");
  }

  let text;
  if (typeof response.arrayBuffer === "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new SamgukSheetError("response_too_large", "Google Sheet 응답이 크기 제한을 초과했습니다.");
    }
    text = new TextDecoder("utf-8").decode(buffer);
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new SamgukSheetError("response_too_large", "Google Sheet 응답이 크기 제한을 초과했습니다.");
    }
  }

  const trimmed = text.trimStart().toLowerCase();
  if (!text.trim() || trimmed.startsWith("<!doctype") || trimmed.startsWith("<html")) {
    throw new SamgukSheetError("invalid_response", "Google Sheet가 CSV 대신 로그인 또는 오류 페이지를 반환했습니다.");
  }
  return text;
}

async function fetchCsv({ fetchImpl, sheetId, sheetName, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildCsvUrl(sheetId, sheetName), {
      headers: {
        Accept: "text/csv,text/plain;q=0.9",
        "User-Agent": "SOOPNOTICE-Samguk/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SamgukSheetError("upstream_http", `Google Sheet HTTP ${response.status}`);
    }
    return await readTextLimited(response, maxBytes);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new SamgukSheetError("upstream_timeout", "Google Sheet 조회 시간이 초과되었습니다.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function newestObservedAt(members, territories, fallback) {
  const values = [
    ...members.map(member => member.observedAt),
    ...members.map(member => member.equipmentObservedAt),
    ...territories.map(territory => territory.observedAt),
  ];
  let newest = null;
  for (const value of values) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp) && (newest === null || timestamp > newest)) newest = timestamp;
  }
  return newest === null ? fallback : new Date(newest).toISOString();
}

function fallbackWarning(error, lastGood) {
  const prefix = lastGood
    ? "Google Sheet 갱신에 실패해 마지막 정상 자료를 표시합니다."
    : "Google Sheet를 읽지 못해 초기 기준값 스냅샷을 표시합니다.";
  if (error?.code === "upstream_http" && /HTTP (?:401|403)/.test(error.message)) {
    return `${prefix} 시트의 링크 공개 보기 권한을 확인하세요.`;
  }
  if (error?.code === "upstream_timeout") return `${prefix} 조회 시간이 초과되었습니다.`;
  if (error?.code === "schema_error") return `${prefix} 시트 헤더 구성을 확인하세요.`;
  if (error?.code === "incomplete_sheet") return `${prefix} ${error.message}`;
  return prefix;
}

function createSamgukSheetService(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const now = options.now || Date.now;
  const sheetId = options.sheetId || process.env.SAMGUK_SHEET_ID || DEFAULT_SHEET_ID;
  const tabs = {
    members: options.tabs?.members || process.env.SAMGUK_STATUS_SHEET || DEFAULT_TABS.members,
    territories: options.tabs?.territories || process.env.SAMGUK_TERRITORY_SHEET || DEFAULT_TABS.territories,
    rules: options.tabs?.rules || process.env.SAMGUK_RULES_SHEET || DEFAULT_TABS.rules,
    equipment: options.tabs?.equipment || process.env.SAMGUK_EQUIPMENT_SHEET || DEFAULT_TABS.equipment,
  };
  const equipmentSheetId = options.equipmentSheetId
    || process.env.SAMGUK_EQUIPMENT_SHEET_ID
    || sheetId;
  const timeoutMs = positiveInt(options.timeoutMs ?? process.env.SAMGUK_SHEET_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInt(options.maxBytes ?? process.env.SAMGUK_SHEET_MAX_BYTES, DEFAULT_MAX_BYTES);
  const expectedMemberCount = positiveInt(options.expectedMemberCount, EXPECTED_MEMBER_COUNT);
  const expectedTerritoryCount = positiveInt(options.expectedTerritoryCount, EXPECTED_TERRITORY_COUNT);
  const sheetUrl = buildSheetUrl(sheetId);
  const fallbackPayload = clone(options.fallbackPayload || FALLBACK_PAYLOAD);
  let lastGood = null;

  async function load() {
    try {
      const [memberCsv, territoryCsv, ruleCsv, equipmentOutcome] = await Promise.all([
        fetchCsv({ fetchImpl, sheetId, sheetName: tabs.members, timeoutMs, maxBytes }),
        fetchCsv({ fetchImpl, sheetId, sheetName: tabs.territories, timeoutMs, maxBytes }),
        fetchCsv({ fetchImpl, sheetId, sheetName: tabs.rules, timeoutMs, maxBytes }),
        fetchCsv({
          fetchImpl,
          sheetId: equipmentSheetId,
          sheetName: tabs.equipment,
          timeoutMs,
          maxBytes,
        }).then(text => ({ text })).catch(error => ({ error })),
      ]);
      const memberResult = parseMembersCsv(memberCsv);
      const territoryResult = parseTerritoriesCsv(territoryCsv);
      const ruleResult = parseRulesCsv(ruleCsv);
      if (memberResult.members.length !== expectedMemberCount) {
        throw new SamgukSheetError(
          "incomplete_sheet",
          `현재현황 참가자가 ${memberResult.members.length}/${expectedMemberCount}명입니다.`,
        );
      }
      if (territoryResult.territories.length !== expectedTerritoryCount) {
        throw new SamgukSheetError(
          "incomplete_sheet",
          `영토현황이 ${territoryResult.territories.length}/${expectedTerritoryCount}개입니다.`,
        );
      }
      let mergedMembers = memberResult.members;
      const equipmentWarnings = [];
      if (equipmentOutcome.error) {
        equipmentWarnings.push("장비현황을 읽지 못해 각인 파워를 미관측으로 처리했습니다.");
      } else {
        try {
          const equipmentResult = parseEquipmentCsv(equipmentOutcome.text);
          const merged = mergeEquipmentData(mergedMembers, equipmentResult.equipment);
          mergedMembers = merged.members;
          equipmentWarnings.push(...equipmentResult.warnings, ...merged.warnings);
        } catch (_) {
          equipmentWarnings.push("장비현황 구조를 읽지 못해 각인 파워를 미관측으로 처리했습니다.");
        }
      }
      const poweredMembers = enrichMembersWithPowerIndex(mergedMembers);
      const readAt = new Date(now()).toISOString();
      const payload = {
        source: "google-sheet",
        updatedAt: newestObservedAt(poweredMembers, territoryResult.territories, readAt),
        stale: false,
        sheetUrl,
        members: poweredMembers,
        territories: territoryResult.territories,
        rules: ruleResult.rules,
        warnings: unique([
          ...memberResult.warnings,
          ...territoryResult.warnings,
          ...ruleResult.warnings,
          ...equipmentWarnings,
        ]),
      };
      lastGood = clone(payload);
      return payload;
    } catch (error) {
      if (lastGood) {
        const stalePayload = clone(lastGood);
        stalePayload.source = "google-sheet-last-good";
        stalePayload.stale = true;
        stalePayload.warnings = unique([...stalePayload.warnings, fallbackWarning(error, true)]);
        return stalePayload;
      }

      fallbackPayload.source = "fallback-seed";
      fallbackPayload.stale = true;
      fallbackPayload.sheetUrl = sheetUrl;
      fallbackPayload.members = enrichMembersWithPowerIndex(fallbackPayload.members);
      fallbackPayload.warnings = unique([
        ...(fallbackPayload.warnings || []),
        fallbackWarning(error, false),
      ]);
      return clone(fallbackPayload);
    }
  }

  return {
    load,
    getLastGood: () => clone(lastGood),
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_SHEET_ID,
  DEFAULT_TABS,
  DEFAULT_TIMEOUT_MS,
  SamgukSheetError,
  buildCsvUrl,
  buildSheetUrl,
  createSamgukSheetService,
  enrichMembersWithPowerIndex,
  normalizeTimestamp,
  mergeEquipmentData,
  parseCsv,
  parseEquipmentCsv,
  parseMembersCsv,
  parseRulesCsv,
  parseTerritoriesCsv,
  readTextLimited,
};
