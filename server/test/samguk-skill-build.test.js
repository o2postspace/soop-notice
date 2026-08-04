"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SamgukSkillBuildError,
  normalizeSkillBuild,
} = require("../lib/samguk-skill-build");

function build(overrides = {}) {
  return {
    version: 1,
    preset: 2,
    ownedPoints: 7,
    skills: Array.from({ length: 6 }, (_value, index) => ({
      name: `절기 ${index + 1}`,
      requiredPoints: index + 1,
      allocatedPoints: index,
    })),
    ...overrides,
  };
}

function rejects(code, input) {
  assert.throws(
    () => normalizeSkillBuild(input),
    error => error instanceof SamgukSkillBuildError && error.code === code,
  );
}

test("6행 절기 배분을 고정 key 순서의 canonical JSON 문자열로 만든다", () => {
  const input = build({
    preset: null,
    skills: build().skills.map((skill, index) => ({
      allocatedPoints: skill.allocatedPoints,
      requiredPoints: skill.requiredPoints,
      name: `  절기  ${index + 1}  `,
    })),
  });
  const canonical = normalizeSkillBuild(input);
  assert.equal(canonical, JSON.stringify({
    version: 1,
    preset: null,
    ownedPoints: 7,
    skills: Array.from({ length: 6 }, (_value, index) => ({
      name: `절기 ${index + 1}`,
      requiredPoints: index + 1,
      allocatedPoints: index,
    })),
  }));
  assert.equal(normalizeSkillBuild(`\n${canonical}\n`), canonical);
  assert.equal(normalizeSkillBuild(JSON.parse(canonical)), canonical);
});

test("직업별 9행 절기 배분도 같은 canonical schema로 보존한다", () => {
  const input = build({
    skills: Array.from({ length: 9 }, (_value, index) => ({
      name: `절기 ${index + 1}`,
      requiredPoints: index < 4 ? 1 : index === 4 ? 2 : 3,
      allocatedPoints: index % 3,
    })),
  });
  assert.equal(JSON.parse(normalizeSkillBuild(input)).skills.length, 9);
});

test("version·preset·point와 허용된 6/9행을 엄격히 검증한다", () => {
  rejects("invalid_version", build({ version: 2 }));
  for (const preset of [0, 5, "1", 1.5]) rejects("invalid_preset", build({ preset }));
  for (const ownedPoints of [-1, 1.5, "1", 1_000_001]) {
    rejects("invalid_points", build({ ownedPoints }));
  }
  rejects("invalid_skills", build({ skills: build().skills.slice(0, 5) }));
  rejects("invalid_skills", build({ skills: [...build().skills, {
    name: "절기 7", requiredPoints: 1, allocatedPoints: 0,
  }] }));
  rejects("invalid_json", "not-json");
});

test("skill row extra key·이름 중복·점수 타입 오류를 전체 snapshot 오류로 처리한다", () => {
  rejects("invalid_schema", build({ debug: true }));
  rejects("invalid_schema", build({
    skills: build().skills.map((skill, index) => (
      index === 0 ? { ...skill, confidence: 0.99 } : skill
    )),
  }));
  rejects("duplicate_skill", build({
    skills: build().skills.map((skill, index) => (
      index === 1 ? { ...skill, name: "절기 1" } : skill
    )),
  }));
  rejects("invalid_name", build({
    skills: build().skills.map((skill, index) => (
      index === 0 ? { ...skill, name: "\u0000" } : skill
    )),
  }));
  for (const field of ["requiredPoints", "allocatedPoints"]) {
    rejects("invalid_points", build({
      skills: build().skills.map((skill, index) => (
        index === 0 ? { ...skill, [field]: -1 } : skill
      )),
    }));
  }
});
