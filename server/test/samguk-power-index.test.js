"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ENGRAVING_PRIOR_N,
  FIELD_STATES,
  GEAR_MAX_LEVEL,
  HORSE_MAX_LEVEL,
  POWER_INDEX_VERSION,
  POWER_STATUSES,
  POWER_WEIGHTS,
  STATS_INTERNAL_WEIGHTS,
  calculatePowerIndex,
  calculateRosterPowerIndexes,
  createPowerIndexContext,
} = require("../lib/samguk-power-index");

const observed = value => ({ state: FIELD_STATES.OBSERVED, value });
const empty = () => ({ state: FIELD_STATES.EMPTY });
const unknown = () => ({ state: FIELD_STATES.UNKNOWN });
const notApplicable = () => ({ state: FIELD_STATES.NOT_APPLICABLE });

function emptyEngravings(count) {
  return Array.from({ length: count }, empty);
}

function member(overrides = {}) {
  return {
    job: "천강",
    level: 0,
    strength: 0,
    agility: 0,
    vitality: 0,
    intelligence: 0,
    weapon: 0,
    helmet: null,
    armor: 0,
    shoes: 0,
    horseLevel: 0,
    engravings: emptyEngravings(9),
    ...overrides,
  };
}

function close(actual, expected, epsilon = 0.0001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("v1.1 상수와 30/35/20/15 가중치를 고정한다", () => {
  assert.equal(POWER_INDEX_VERSION, "v1.1");
  assert.deepEqual(POWER_WEIGHTS, { stats: 30, gear: 35, engravings: 20, horse: 15 });
  assert.deepEqual(STATS_INTERNAL_WEIGHTS, { level: 0.40, abilities: 0.60 });
  assert.equal(GEAR_MAX_LEVEL, 15);
  assert.equal(HORSE_MAX_LEVEL, 80);
  assert.equal(ENGRAVING_PRIOR_N, 10);
});

test("레벨과 기량 4종은 각각 전체 로스터 inclusive 백분위로 0~100을 만든다", () => {
  const results = calculateRosterPowerIndexes([
    member({ level: 0, strength: 0, agility: 0, vitality: 0, intelligence: 0 }),
    member({ level: 10, strength: 10, agility: 10, vitality: 10, intelligence: 10 }),
    member({ level: 20, strength: 20, agility: 20, vitality: 20, intelligence: 20, weapon: 15, armor: 15, shoes: 15, horseLevel: 80 }),
  ]);

  assert.deepEqual(results.map(result => result.components.stats.score), [0, 50, 100]);
  assert.equal(results[2].components.stats.level, 20);
  assert.equal(results[2].components.stats.abilityTotal, 80);
  assert.equal(results[2].components.gear.score, 100);
  assert.equal(results[2].components.horse.score, 100);
  assert.equal(results[2].score, 80);
  assert.equal(results[2].coverage, 100);
  assert.equal(results[2].status, POWER_STATUSES.CONFIRMED);
  assert.equal(results[2].rankable, true);
});

test("동점 레벨·기량에는 같은 midrank를 주고 단일 표본은 50점으로 둔다", () => {
  const tied = calculateRosterPowerIndexes([
    member({ level: 10, strength: 10, agility: 10, vitality: 10, intelligence: 10 }),
    member({ level: 10, strength: 10, agility: 10, vitality: 10, intelligence: 10 }),
    member({ level: 20, strength: 20, agility: 20, vitality: 20, intelligence: 20 }),
  ]);
  assert.deepEqual(tied.map(result => result.components.stats.score), [25, 25, 100]);

  const single = calculateRosterPowerIndexes([member({ strength: 999 })]);
  assert.equal(single[0].components.stats.score, 50);
});

test("레벨과 각 기량 결측은 Stats coverage에 독립적으로 반영한다", () => {
  const [missingLevel, missingAbility] = calculateRosterPowerIndexes([
    member({ level: unknown(), strength: 10 }),
    member({ level: 10, strength: unknown() }),
  ]);

  assert.equal(missingLevel.components.stats.coverage, 60);
  assert.equal(missingLevel.components.stats.lower, 30);
  assert.equal(missingLevel.components.stats.upper, 70);
  assert.equal(missingLevel.coverage, 88);
  assert.equal(missingLevel.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(missingLevel.rankable, true);

  assert.equal(missingAbility.components.stats.coverage, 85);
  assert.equal(missingAbility.components.stats.lower, 42.5);
  assert.equal(missingAbility.components.stats.upper, 57.5);
  assert.equal(missingAbility.coverage, 95.5);
  assert.equal(missingAbility.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(missingAbility.rankable, true);
  assert.equal(missingAbility.components.stats.statPercentiles.strength, null);
  assert.equal(missingAbility.components.stats.statPercentiles.agility, 50);
});

test("장비는 무기 50%, 방어 30%, 각갑 20%이며 군주 방어는 두갑·흉갑 평균이다", () => {
  const [general, ruler] = calculateRosterPowerIndexes([
    member({ weapon: 15, armor: 0, shoes: 15 }),
    member({ job: "조조", weapon: 15, helmet: 15, armor: 0, shoes: 15, engravings: emptyEngravings(12) }),
  ]);

  assert.equal(general.components.gear.score, 70);
  assert.equal(general.components.gear.defense, 0);
  assert.equal(general.components.gear.coverage, 100);
  assert.equal(ruler.components.gear.score, 85);
  assert.equal(ruler.components.gear.defense, 50);
  assert.equal(ruler.components.gear.coverage, 100);
});

test("군주 두갑 미관측은 장비 구간과 내부 coverage에만 반영한다", () => {
  const [result] = calculateRosterPowerIndexes([
    member({
      job: "유비",
      weapon: 15,
      helmet: unknown(),
      armor: 0,
      shoes: 15,
      engravings: emptyEngravings(12),
    }),
  ]);

  assert.equal(result.components.gear.lower, 70);
  assert.equal(result.components.gear.upper, 85);
  assert.equal(result.components.gear.score, 77.5);
  assert.equal(result.components.gear.coverage, 85);
  assert.equal(result.coverage, 94.75);
  assert.equal(result.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(result.rankable, true);
});

test("각인은 동일 이름 안에서만 백분위를 구하고 priorN=10으로 50에 축소한다", () => {
  const lowEngravings = [
    { name: "필살", value: 10, state: FIELD_STATES.OBSERVED },
    ...emptyEngravings(8),
  ];
  const highEngravings = [
    { name: "필살", value: 20, state: FIELD_STATES.OBSERVED },
    ...emptyEngravings(8),
  ];
  const [low, high] = calculateRosterPowerIndexes([
    member({ engravings: lowEngravings }),
    member({ engravings: highEngravings }),
  ]);

  close(low.components.engravings.averageQuality, 41.6667);
  close(high.components.engravings.averageQuality, 58.3333);
  close(low.components.engravings.score, 7.2222);
  close(high.components.engravings.score, 8.3333);
  assert.equal(high.components.engravings.filledSlots, 1);
  assert.equal(high.components.engravings.eligibleSlots, 9);
  assert.equal(high.components.engravings.coverage, 100);
});

test("같은 각인명이라도 presence와 퍼센트 단위는 서로 다른 분포로 계산한다", () => {
  const [presence, percent] = calculateRosterPowerIndexes([
    member({
      engravings: [
        { name: "강건", value: 1, unit: "presence", state: FIELD_STATES.OBSERVED },
        ...emptyEngravings(8),
      ],
    }),
    member({
      engravings: [
        { name: "강건", value: 13.5, unit: "%", state: FIELD_STATES.OBSERVED },
        ...emptyEngravings(8),
      ],
    }),
  ]);

  assert.equal(presence.components.engravings.averageQuality, 50);
  assert.equal(percent.components.engravings.averageQuality, 50);
  assert.equal(presence.components.engravings.score, percent.components.engravings.score);
});

test("숫자 각인의 퍼센트 표기 누락은 같은 이름의 숫자 분포로 비교한다", () => {
  const [plain, percent] = calculateRosterPowerIndexes([
    member({
      engravings: [
        { name: "필살", value: 10, unit: "value", state: FIELD_STATES.OBSERVED },
        ...emptyEngravings(8),
      ],
    }),
    member({
      engravings: [
        { name: "필살", value: 20, unit: "%", state: FIELD_STATES.OBSERVED },
        ...emptyEngravings(8),
      ],
    }),
  ]);

  close(plain.components.engravings.averageQuality, 41.6667);
  close(percent.components.engravings.averageQuality, 58.3333);
});

test("unknown 각인 슬롯은 0~100 구간과 50 midpoint, empty는 관측된 0으로 계산한다", () => {
  const engravings = [
    { name: "필살", value: 10, state: FIELD_STATES.OBSERVED },
    ...emptyEngravings(7),
    unknown(),
  ];
  const [result] = calculateRosterPowerIndexes([member({ engravings })]);
  const component = result.components.engravings;

  assert.equal(component.knownSlots, 8);
  close(component.coverage, 88.8889);
  close(component.lower, 7.7778);
  close(component.upper, 18.8889);
  close(component.score, 13.3334);
});

test("일반 장수의 두갑 각인 not_applicable 3칸은 9개 eligible 분모에서 제외한다", () => {
  const engravings = [
    ...emptyEngravings(9),
    notApplicable(), notApplicable(), notApplicable(),
  ];
  const [result] = calculateRosterPowerIndexes([member({ engravings })]);

  assert.equal(result.components.engravings.eligibleSlots, 9);
  assert.equal(result.components.engravings.knownSlots, 9);
  assert.equal(result.components.engravings.coverage, 100);
  assert.equal(result.components.engravings.score, 0);
});

test("말만 unknown이면 coverage 85%, midpoint와 15점 폭 구간의 잠정값이 된다", () => {
  const [result] = calculateRosterPowerIndexes([member({
    strength: 10,
    weapon: 15,
    armor: 15,
    shoes: 15,
    horseLevel: unknown(),
  })]);

  assert.equal(result.components.horse.lower, 0);
  assert.equal(result.components.horse.upper, 100);
  assert.equal(result.components.horse.score, 50);
  assert.equal(result.components.horse.coverage, 0);
  assert.equal(result.coverage, 85);
  assert.equal(result.lower, 50);
  assert.equal(result.upper, 65);
  assert.equal(result.score, 57.5);
  assert.equal(result.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(result.rankable, true);
});

test("coverage 85 미만은 데이터 부족이며 순위 대상이 아니다", () => {
  const engravings = [...emptyEngravings(8), unknown()];
  const [result] = calculateRosterPowerIndexes([member({
    strength: 10,
    weapon: 15,
    armor: 15,
    shoes: 15,
    horseLevel: unknown(),
    engravings,
  })]);

  close(result.coverage, 82.7778);
  assert.equal(result.status, POWER_STATUSES.INSUFFICIENT);
  assert.equal(result.rankable, false);
});

test("원값 0과 empty는 coverage에 포함하지만 null과 unknown은 포함하지 않는다", () => {
  const [observedZero] = calculateRosterPowerIndexes([member({ horseLevel: 0 })]);
  const [emptyHorse] = calculateRosterPowerIndexes([member({ horseLevel: empty() })]);
  const [unknownHorse] = calculateRosterPowerIndexes([member({ horseLevel: null })]);

  assert.equal(observedZero.components.horse.score, 0);
  assert.equal(observedZero.components.horse.coverage, 100);
  assert.equal(emptyHorse.components.horse.score, 0);
  assert.equal(emptyHorse.components.horse.coverage, 100);
  assert.equal(unknownHorse.components.horse.score, 50);
  assert.equal(unknownHorse.components.horse.coverage, 0);
});

test("createPowerIndexContext와 단일 계산 API가 로스터 분포를 재사용한다", () => {
  const roster = [
    member({ level: 0, strength: 0, agility: 0, vitality: 0, intelligence: 0 }),
    member({ level: 20, strength: 20, agility: 20, vitality: 20, intelligence: 20 }),
  ];
  const context = createPowerIndexContext(roster);
  const result = calculatePowerIndex(roster[1], context);

  assert.equal(result.components.stats.score, 100);
  assert.equal(result.version, "v1.1");
});

test("강화 상한, 말 상한, 각인 스키마와 eligible 슬롯 수를 엄격히 검증한다", () => {
  assert.throws(
    () => calculateRosterPowerIndexes([member({ weapon: 16 })]),
    /weapon 값은 0 이상 15 이하/,
  );
  assert.throws(
    () => calculateRosterPowerIndexes([member({ horseLevel: 81 })]),
    /horseLevel 값은 0 이상 80 이하/,
  );
  assert.throws(
    () => calculateRosterPowerIndexes([member({
      engravings: [{ name: "필살", state: FIELD_STATES.OBSERVED }, ...emptyEngravings(8)],
    })]),
    /engravings\[0\]\.value/,
  );
  assert.throws(
    () => calculateRosterPowerIndexes([member({ engravings: emptyEngravings(10) })]),
    /각인 슬롯은 최대 9개/,
  );
  assert.throws(
    () => calculateRosterPowerIndexes([member({ strength: { state: "missing" } })]),
    /strength\.state/,
  );
});
