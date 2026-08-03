"use strict";

const POWER_INDEX_VERSION = "v1.5";
const POWER_WEIGHTS = Object.freeze({
  stats: 30,
  gear: 35,
  engravings: 20,
  horse: 15,
});
const GEAR_INTERNAL_WEIGHTS = Object.freeze({
  general: Object.freeze({ weapon: 0.60, armor: 0.30, shoes: 0.10 }),
  // 군주 두갑은 일반 장비의 흉갑 가중치를 나눠 갖지 않고 추가 장비 보너스로 더한다.
  ruler: Object.freeze({ weapon: 0.60, helmet: 0.15, armor: 0.30, shoes: 0.10 }),
});
const FIELD_STATES = Object.freeze({
  OBSERVED: "observed",
  EMPTY: "empty",
  UNKNOWN: "unknown",
  NOT_APPLICABLE: "not_applicable",
});
const POWER_STATUSES = Object.freeze({
  CONFIRMED: "confirmed",
  PROVISIONAL: "provisional",
  INSUFFICIENT: "insufficient",
});
const RULER_JOBS = new Set(["조조", "유비", "손권"]);
const STAT_FIELDS = Object.freeze(["strength", "agility", "vitality", "intelligence"]);
const STATS_INTERNAL_WEIGHTS = Object.freeze({ level: 0.40, abilities: 0.60 });
// 기량은 참가자 분포에 따라 점수가 흔들리지 않도록 네 수치의 실제 합계를
// 고정 기준으로 선형 환산한다. 현재 공개 범위(최고 506)에 성장 여유를 둔다.
const ABILITY_TOTAL_CAP = 600;
const GEAR_MAX_LEVEL = 15;
const HORSE_MAX_LEVEL = 80;
// 공개 자료로 확인된 말 강화 허용 범위는 유지한다. 적토마 희귀도는 별도
// 기본점수로만 반영해 다른 말의 강화 효율을 근거 없이 바꾸지 않는다.
const HORSE_SCORING_LEVEL_CAP = HORSE_MAX_LEVEL;
const RED_HARE_BASE_BONUS = 35;
const HORSE_GRADE_BONUSES = Object.freeze({
  "담운마": 0,
  "금표마": 8.75,
  "백룡마": 17.5,
  "현풍마": 26.25,
  "적토마": RED_HARE_BASE_BONUS,
});
const HORSE_NAME_ALIASES = new Map([
  ["담운마", "담운마"],
  ["금표마", "금표마"],
  ["백룡마", "백룡마"],
  ["현풍마", "현풍마"],
  ["적토마", "적토마"],
  ["적토", "적토마"],
  ["赤兔馬", "적토마"],
  ["赤兎馬", "적토마"],
]);
const ENGRAVING_PRIOR_N = 10;
const GENERAL_ENGRAVING_SLOTS = 9;
const RULER_ENGRAVING_SLOTS = 12;
const EPSILON = 1e-9;

function fail(message, Type = TypeError) {
  throw new Type(message);
}

function round(value) {
  return Number(value.toFixed(4));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeJob(value) {
  return String(value || "").normalize("NFKC").trim();
}

function normalizeHorseName(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") fail("horse는 문자열이어야 합니다.");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length > 80) fail("horse 문자열은 80자 이하여야 합니다.", RangeError);
  const alias = normalized.replace(/[\s._\-·ㆍ]+/g, "");
  return HORSE_NAME_ALIASES.get(alias) || normalized;
}

function isRuler(member) {
  return RULER_JOBS.has(normalizeJob(member?.job));
}

function numericValue(value, label, maximum = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    fail(`${label} 값은 0 이상 ${maximum === Infinity ? "유한값" : maximum} 이하여야 합니다.`, RangeError);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeField(input, label, maximum = Infinity) {
  if (input === null || input === undefined || input === "") {
    return Object.freeze({ state: FIELD_STATES.UNKNOWN, value: null });
  }
  if (typeof input === "number") {
    return Object.freeze({ state: FIELD_STATES.OBSERVED, value: numericValue(input, label, maximum) });
  }
  if (!isRecord(input)) fail(`${label}은 숫자 또는 state 객체여야 합니다.`);

  const state = input.state;
  if (!Object.values(FIELD_STATES).includes(state)) fail(`${label}.state가 올바르지 않습니다.`);
  if (state === FIELD_STATES.OBSERVED) {
    return Object.freeze({
      state,
      value: numericValue(input.value, label, maximum),
    });
  }
  if (state === FIELD_STATES.EMPTY) {
    return Object.freeze({ state, value: 0 });
  }
  return Object.freeze({ state, value: null });
}

function isKnown(field) {
  return field.state === FIELD_STATES.OBSERVED || field.state === FIELD_STATES.EMPTY;
}

function requiredField(input, label, maximum = Infinity) {
  const field = normalizeField(input, label, maximum);
  if (field.state === FIELD_STATES.NOT_APPLICABLE) {
    fail(`${label}은 적용 대상 필드입니다.`);
  }
  return field;
}

function normalizeEngraving(input, index) {
  const label = `engravings[${index}]`;
  if (!isRecord(input)) fail(`${label}은 객체여야 합니다.`);
  if (!Object.values(FIELD_STATES).includes(input.state)) fail(`${label}.state가 올바르지 않습니다.`);

  if (input.state === FIELD_STATES.OBSERVED) {
    if (typeof input.name !== "string") fail(`${label}.name이 필요합니다.`);
    const name = input.name.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!name || name.length > 80) fail(`${label}.name이 올바르지 않습니다.`);
    const unit = typeof input.unit === "string" && input.unit.trim()
      ? input.unit.normalize("NFKC").trim().toLowerCase()
      : "value";
    if (unit.length > 24) fail(`${label}.unit이 올바르지 않습니다.`);
    const comparisonUnit = unit === "presence" ? "presence" : "numeric";
    return Object.freeze({
      state: input.state,
      name,
      unit,
      key: `${name.toLowerCase()}::${comparisonUnit}`,
      value: numericValue(input.value, `${label}.value`),
    });
  }
  return Object.freeze({ state: input.state, name: null, key: null, value: null });
}

function normalizeEngravings(member, ruler) {
  const raw = member?.engravings;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) fail("engravings는 배열이어야 합니다.");
  const normalized = (raw || []).map(normalizeEngraving);
  const applicable = normalized.filter(item => item.state !== FIELD_STATES.NOT_APPLICABLE);
  const eligibleSlots = ruler ? RULER_ENGRAVING_SLOTS : GENERAL_ENGRAVING_SLOTS;
  if (applicable.length > eligibleSlots) {
    fail(`적용 가능한 각인 슬롯은 최대 ${eligibleSlots}개입니다.`, RangeError);
  }
  while (applicable.length < eligibleSlots) {
    applicable.push(Object.freeze({
      state: FIELD_STATES.UNKNOWN,
      name: null,
      key: null,
      value: null,
    }));
  }
  return Object.freeze(applicable);
}

function normalizeMember(member) {
  if (!isRecord(member)) fail("member는 객체여야 합니다.");
  const ruler = isRuler(member);
  const stats = Object.freeze(Object.fromEntries(STAT_FIELDS.map(field => [
    field,
    requiredField(member[field], field),
  ])));
  const gear = Object.freeze({
    weapon: requiredField(member.weapon, "weapon", GEAR_MAX_LEVEL),
    helmet: ruler
      ? requiredField(member.helmet, "helmet", GEAR_MAX_LEVEL)
      : Object.freeze({ state: FIELD_STATES.NOT_APPLICABLE, value: null }),
    armor: requiredField(member.armor, "armor", GEAR_MAX_LEVEL),
    shoes: requiredField(member.shoes, "shoes", GEAR_MAX_LEVEL),
  });
  return Object.freeze({
    ruler,
    level: requiredField(member.level, "level"),
    stats,
    gear,
    horse: normalizeHorseName(member.horse),
    horseLevel: requiredField(member.horseLevel, "horseLevel", HORSE_MAX_LEVEL),
    engravings: normalizeEngravings(member, ruler),
  });
}

function percentileRank(value, values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.length === 1) return 50;
  let below = 0;
  let equal = 0;
  for (const candidate of values) {
    if (candidate < value) below += 1;
    else if (candidate === value) equal += 1;
  }
  if (equal === 0) fail("백분위 기준값이 로스터 분포에 없습니다.");
  const midrank = below + (equal - 1) / 2;
  return 100 * midrank / (values.length - 1);
}

function completeStatTotal(member) {
  const fields = STAT_FIELDS.map(field => member.stats[field]);
  if (!fields.every(isKnown)) return null;
  return fields.reduce((sum, field) => sum + field.value, 0);
}

function createPowerIndexContextFromNormalized(members) {
  const levels = members.filter(member => isKnown(member.level)).map(member => member.level.value);
  const statTotals = members.map(completeStatTotal).filter(value => value !== null);
  const statValues = Object.fromEntries(STAT_FIELDS.map(field => [
    field,
    members.filter(member => isKnown(member.stats[field])).map(member => member.stats[field].value),
  ]));
  const engravingValues = {};
  for (const member of members) {
    for (const engraving of member.engravings) {
      if (engraving.state !== FIELD_STATES.OBSERVED) continue;
      if (!engravingValues[engraving.key]) engravingValues[engraving.key] = [];
      engravingValues[engraving.key].push(engraving.value);
    }
  }
  for (const key of Object.keys(engravingValues)) Object.freeze(engravingValues[key]);
  for (const field of STAT_FIELDS) Object.freeze(statValues[field]);
  return Object.freeze({
    levels: Object.freeze(levels),
    statTotals: Object.freeze(statTotals),
    statValues: Object.freeze(statValues),
    engravingValues: Object.freeze(engravingValues),
  });
}

function createPowerIndexContext(roster) {
  if (!Array.isArray(roster) || roster.length === 0) fail("roster는 한 명 이상의 배열이어야 합니다.");
  return createPowerIndexContextFromNormalized(roster.map(normalizeMember));
}

function makeComponent(weight, lower, upper, coverage, details = {}) {
  const normalizedLower = Math.max(0, Math.min(100, lower));
  const normalizedUpper = Math.max(normalizedLower, Math.min(100, upper));
  const normalizedCoverage = Math.max(0, Math.min(100, coverage));
  return Object.freeze({
    weight,
    score: round((normalizedLower + normalizedUpper) / 2),
    lower: round(normalizedLower),
    upper: round(normalizedUpper),
    coverage: round(normalizedCoverage),
    ...details,
  });
}

function calculateStats(member, context) {
  const levelKnown = isKnown(member.level);
  const levelPercentile = levelKnown ? percentileRank(member.level.value, context.levels) : null;
  const completeTotal = completeStatTotal(member);
  const knownStats = STAT_FIELDS.filter(field => isKnown(member.stats[field]));
  const knownTotal = knownStats.reduce((sum, field) => sum + member.stats[field].value, 0);
  const abilitiesKnown = completeTotal !== null;
  const abilityLower = 100 * Math.min(knownTotal, ABILITY_TOTAL_CAP) / ABILITY_TOTAL_CAP;
  const abilityUpper = abilitiesKnown
    ? abilityLower
    : 100;
  const levelLower = levelKnown ? levelPercentile : 0;
  const levelUpper = levelKnown ? levelPercentile : 100;
  const abilityWeight = STATS_INTERNAL_WEIGHTS.abilities / STAT_FIELDS.length;
  const statPercentiles = {};
  let lower = STATS_INTERNAL_WEIGHTS.level * levelLower
    + STATS_INTERNAL_WEIGHTS.abilities * abilityLower;
  let upper = STATS_INTERNAL_WEIGHTS.level * levelUpper
    + STATS_INTERNAL_WEIGHTS.abilities * abilityUpper;
  let coverageWeight = levelKnown ? STATS_INTERNAL_WEIGHTS.level : 0;
  for (const field of STAT_FIELDS) {
    const known = isKnown(member.stats[field]);
    const percentile = known ? percentileRank(member.stats[field].value, context.statValues[field]) : null;
    statPercentiles[field] = known ? round(percentile) : null;
    if (known) coverageWeight += abilityWeight;
  }
  const coverage = 100 * coverageWeight;
  return makeComponent(POWER_WEIGHTS.stats, lower, upper, coverage, {
    level: levelKnown ? round(member.level.value) : null,
    levelPercentile: levelKnown ? round(levelPercentile) : null,
    abilityTotal: round(knownTotal),
    abilityComplete: abilitiesKnown,
    abilityScore: round(abilityLower),
    abilityCap: ABILITY_TOTAL_CAP,
    abilityPercentile: null,
    statPercentiles: Object.freeze(statPercentiles),
  });
}

function normalizedLevel(field, maximum) {
  if (!isKnown(field)) return Object.freeze({ lower: 0, upper: 100, coverage: 0 });
  const score = 100 * Math.min(field.value, maximum) / maximum;
  return Object.freeze({ lower: score, upper: score, coverage: 100 });
}

function weightedParts(parts) {
  return parts.reduce((result, part) => ({
    lower: result.lower + part.weight * part.lower,
    upper: result.upper + part.weight * part.upper,
    coverage: result.coverage + part.weight * part.coverage,
  }), { lower: 0, upper: 0, coverage: 0 });
}

function calculateGear(member) {
  const weapon = normalizedLevel(member.gear.weapon, GEAR_MAX_LEVEL);
  const armor = normalizedLevel(member.gear.armor, GEAR_MAX_LEVEL);
  const shoes = normalizedLevel(member.gear.shoes, GEAR_MAX_LEVEL);
  const weights = member.ruler ? GEAR_INTERNAL_WEIGHTS.ruler : GEAR_INTERNAL_WEIGHTS.general;
  const parts = [
    { weight: weights.weapon, ...weapon },
    { weight: weights.armor, ...armor },
    { weight: weights.shoes, ...shoes },
  ];
  let helmet = null;
  if (member.ruler) {
    helmet = normalizedLevel(member.gear.helmet, GEAR_MAX_LEVEL);
    parts.push({ weight: weights.helmet, ...helmet });
  }
  const total = weightedParts(parts);
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  return makeComponent(
    POWER_WEIGHTS.gear,
    total.lower,
    total.upper,
    total.coverage / totalWeight,
    {
      weapon: round((weapon.lower + weapon.upper) / 2),
      helmet: helmet ? round((helmet.lower + helmet.upper) / 2) : null,
      armor: round((armor.lower + armor.upper) / 2),
      defense: round(member.ruler
        ? ((armor.lower + armor.upper) + (helmet.lower + helmet.upper)) / 4
        : (armor.lower + armor.upper) / 2),
      shoes: round((shoes.lower + shoes.upper) / 2),
      weights,
    },
  );
}

function engravingQuality(engraving, context) {
  const values = context.engravingValues[engraving.key];
  if (!values || values.length === 0) fail(`각인 '${engraving.name}'의 로스터 분포가 없습니다.`);
  const percentile = percentileRank(engraving.value, values);
  const weight = values.length / (values.length + ENGRAVING_PRIOR_N);
  return weight * percentile + (1 - weight) * 50;
}

function calculateEngravings(member, context) {
  const eligibleSlots = member.engravings.length;
  let knownSlots = 0;
  let filledSlots = 0;
  let lowerTotal = 0;
  let upperTotal = 0;
  let qualityTotal = 0;

  for (const engraving of member.engravings) {
    if (engraving.state === FIELD_STATES.UNKNOWN) {
      upperTotal += 100;
      continue;
    }
    knownSlots += 1;
    if (engraving.state === FIELD_STATES.EMPTY) continue;
    if (engraving.state !== FIELD_STATES.OBSERVED) fail("적용 가능한 각인 state가 올바르지 않습니다.");
    filledSlots += 1;
    const quality = engravingQuality(engraving, context);
    qualityTotal += quality;
    const slotScore = 40 + 0.60 * quality;
    lowerTotal += slotScore;
    upperTotal += slotScore;
  }

  const lower = lowerTotal / eligibleSlots;
  const upper = upperTotal / eligibleSlots;
  const coverage = 100 * knownSlots / eligibleSlots;
  return makeComponent(POWER_WEIGHTS.engravings, lower, upper, coverage, {
    eligibleSlots,
    knownSlots,
    filledSlots,
    attachmentRate: round(100 * filledSlots / eligibleSlots),
    averageQuality: filledSlots ? round(qualityTotal / filledSlots) : null,
  });
}

function calculateHorse(member) {
  const level = normalizedLevel(member.horseLevel, HORSE_SCORING_LEVEL_CAP);
  const isRedHare = member.horse === "적토마";
  const gradeNames = Object.keys(HORSE_GRADE_BONUSES);
  const gradeIndex = gradeNames.indexOf(member.horse);
  const baseBonus = gradeIndex >= 0 ? HORSE_GRADE_BONUSES[member.horse] : 0;
  const lower = Math.min(100, level.lower + baseBonus);
  const upper = Math.min(100, level.upper + baseBonus);
  return makeComponent(POWER_WEIGHTS.horse, lower, upper, level.coverage, {
    horse: member.horse,
    isRedHare,
    gradeRank: gradeIndex >= 0 ? gradeIndex + 1 : null,
    gradeCount: gradeNames.length,
    baseBonus,
    level: isKnown(member.horseLevel) ? round(member.horseLevel.value) : null,
    scoringLevel: isKnown(member.horseLevel)
      ? round(Math.min(member.horseLevel.value, HORSE_SCORING_LEVEL_CAP))
      : null,
    scoringCap: HORSE_SCORING_LEVEL_CAP,
    enhancementScore: round((level.lower + level.upper) / 2),
  });
}

function combineComponents(components) {
  let lower = 0;
  let upper = 0;
  let coverage = 0;
  for (const [name, weight] of Object.entries(POWER_WEIGHTS)) {
    const component = components[name];
    lower += weight * component.lower / 100;
    upper += weight * component.upper / 100;
    coverage += weight * component.coverage / 100;
  }
  lower = round(lower);
  upper = round(upper);
  coverage = round(coverage);
  const score = round((lower + upper) / 2);
  const confirmed = Math.abs(coverage - 100) <= EPSILON;
  const rankable = coverage + EPSILON >= 85;
  return Object.freeze({
    version: POWER_INDEX_VERSION,
    score,
    lower,
    upper,
    coverage,
    status: confirmed
      ? POWER_STATUSES.CONFIRMED
      : rankable ? POWER_STATUSES.PROVISIONAL : POWER_STATUSES.INSUFFICIENT,
    rankable,
    components: Object.freeze(components),
  });
}

function calculateNormalizedPowerIndex(member, context) {
  return combineComponents({
    stats: calculateStats(member, context),
    gear: calculateGear(member),
    engravings: calculateEngravings(member, context),
    horse: calculateHorse(member),
  });
}

function calculatePowerIndex(member, context) {
  if (!isRecord(context) || !Array.isArray(context.levels)
      || !Array.isArray(context.statTotals) || !isRecord(context.statValues)
      || STAT_FIELDS.some(field => !Array.isArray(context.statValues[field]))
      || !isRecord(context.engravingValues)) {
    fail("createPowerIndexContext로 만든 context가 필요합니다.");
  }
  return calculateNormalizedPowerIndex(normalizeMember(member), context);
}

function calculateRosterPowerIndexes(roster) {
  if (!Array.isArray(roster) || roster.length === 0) fail("roster는 한 명 이상의 배열이어야 합니다.");
  const members = roster.map(normalizeMember);
  const context = createPowerIndexContextFromNormalized(members);
  return Object.freeze(members.map(member => calculateNormalizedPowerIndex(member, context)));
}

module.exports = {
  ABILITY_TOTAL_CAP,
  ENGRAVING_PRIOR_N,
  FIELD_STATES,
  GEAR_INTERNAL_WEIGHTS,
  GEAR_MAX_LEVEL,
  HORSE_MAX_LEVEL,
  HORSE_SCORING_LEVEL_CAP,
  HORSE_GRADE_BONUSES,
  POWER_INDEX_VERSION,
  POWER_STATUSES,
  POWER_WEIGHTS,
  RED_HARE_BASE_BONUS,
  STATS_INTERNAL_WEIGHTS,
  calculatePowerIndex,
  calculateRosterPowerIndexes,
  createPowerIndexContext,
  normalizeHorseName,
};
