"use strict";

const SKILL_BUILD_VERSION = 1;
const SKILL_BUILD_ROW_COUNTS = Object.freeze([6, 9]);
const MAX_SKILL_BUILD_BYTES = 8 * 1024;
const MAX_SKILL_NAME_LENGTH = 80;
const MAX_SKILL_POINTS = 1_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const BUILD_KEYS = new Set(["version", "preset", "ownedPoints", "skills"]);
const SKILL_KEYS = new Set(["name", "requiredPoints", "allocatedPoints"]);

class SamgukSkillBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukSkillBuildError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukSkillBuildError(code, message);
}

function strictObject(value, allowedKeys, requiredKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_schema", `${label}은(는) 객체여야 합니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_schema", `${label}은(는) 일반 객체여야 합니다.`);
  }
  const unexpected = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    fail("invalid_schema", `${label}에 허용되지 않은 항목이 있습니다: ${unexpected.join(", ")}`);
  }
  const missing = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    fail("invalid_schema", `${label}에 필수 항목이 없습니다: ${missing.join(", ")}`);
  }
}

function normalizeInput(input) {
  if (typeof input !== "string") return input;
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes < 2 || bytes > MAX_SKILL_BUILD_BYTES) {
    fail("invalid_json", `skillBuild JSON은 2~${MAX_SKILL_BUILD_BYTES}바이트여야 합니다.`);
  }
  try {
    return JSON.parse(input);
  } catch {
    fail("invalid_json", "skillBuild 값은 JSON 객체 문자열이어야 합니다.");
  }
}

function normalizePoint(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SKILL_POINTS) {
    fail("invalid_points", `${label}은(는) 0~${MAX_SKILL_POINTS} 정수여야 합니다.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeName(value, label) {
  if (typeof value !== "string") fail("invalid_name", `${label}은(는) 문자열이어야 합니다.`);
  const compatible = value.normalize("NFKC").trim();
  if (!compatible || CONTROL_CHARACTER_PATTERN.test(compatible)) {
    fail("invalid_name", `${label} 형식이 올바르지 않습니다.`);
  }
  const normalized = compatible.replace(/\s+/gu, " ");
  if (normalized.length > MAX_SKILL_NAME_LENGTH) {
    fail("invalid_name", `${label} 형식이 올바르지 않습니다.`);
  }
  return normalized;
}

function normalizeSkillBuild(input) {
  const parsed = normalizeInput(input);
  strictObject(parsed, BUILD_KEYS, [...BUILD_KEYS], "skillBuild");
  if (parsed.version !== SKILL_BUILD_VERSION) {
    fail("invalid_version", `skillBuild version은 ${SKILL_BUILD_VERSION}이어야 합니다.`);
  }
  if (parsed.preset !== null
    && (!Number.isSafeInteger(parsed.preset) || parsed.preset < 1 || parsed.preset > 4)) {
    fail("invalid_preset", "skillBuild preset은 null 또는 1~4 정수여야 합니다.");
  }
  if (!Array.isArray(parsed.skills) || !SKILL_BUILD_ROW_COUNTS.includes(parsed.skills.length)) {
    fail("invalid_skills", `skillBuild skills는 ${SKILL_BUILD_ROW_COUNTS.join("행 또는 ")}행이어야 합니다.`);
  }

  const names = new Set();
  const skills = parsed.skills.map((skill, index) => {
    const label = `skillBuild.skills[${index}]`;
    strictObject(skill, SKILL_KEYS, [...SKILL_KEYS], label);
    const name = normalizeName(skill.name, `${label}.name`);
    if (names.has(name)) fail("duplicate_skill", `skillBuild skill name이 중복되었습니다: ${name}`);
    names.add(name);
    return {
      name,
      requiredPoints: normalizePoint(skill.requiredPoints, `${label}.requiredPoints`),
      allocatedPoints: normalizePoint(skill.allocatedPoints, `${label}.allocatedPoints`),
    };
  });

  // 이 객체 생성 순서가 Sheet와 두-frame 합의에서 사용하는 canonical wire order다.
  return JSON.stringify({
    version: SKILL_BUILD_VERSION,
    preset: parsed.preset,
    ownedPoints: normalizePoint(parsed.ownedPoints, "skillBuild.ownedPoints"),
    skills,
  });
}

module.exports = {
  MAX_SKILL_BUILD_BYTES,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_POINTS,
  SKILL_BUILD_ROW_COUNTS,
  SKILL_BUILD_VERSION,
  SamgukSkillBuildError,
  normalizeSkillBuild,
};
