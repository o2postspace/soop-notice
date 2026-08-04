"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ABILITY_POWER_PER_POINT,
  ABILITY_TOTAL_CAP,
  ENGRAVING_PRIOR_N,
  FIELD_STATES,
  GEAR_INTERNAL_WEIGHTS,
  GEAR_MAX_LEVEL,
  HORSE_GRADE_BONUSES,
  HORSE_MAX_LEVEL,
  HORSE_SCORING_LEVEL_CAP,
  POWER_INDEX_VERSION,
  POWER_DISPLAY_SCALE,
  POWER_STATUSES,
  POWER_WEIGHTS,
  RED_HARE_BASE_BONUS,
  STATS_INTERNAL_WEIGHTS,
  calculatePowerIndex,
  calculateRosterPowerIndexes,
  createPowerIndexContext,
  normalizeHorseName,
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
    horse: "담운마",
    horseLevel: 0,
    engravings: emptyEngravings(9),
    ...overrides,
  };
}

function close(actual, expected, epsilon = 0.0001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("v1.6 상수와 외부·장비 내부 가중치를 고정한다", () => {
  assert.equal(POWER_INDEX_VERSION, "v1.6");
  assert.equal(POWER_DISPLAY_SCALE, 125);
  assert.equal(ABILITY_POWER_PER_POINT, 1);
  assert.equal(ABILITY_TOTAL_CAP, 2250);
  assert.deepEqual(POWER_WEIGHTS, { stats: 30, gear: 35, engravings: 20, horse: 15 });
  assert.deepEqual(GEAR_INTERNAL_WEIGHTS, {
    general: { weapon: 0.60, armor: 0.30, shoes: 0.10 },
    ruler: { weapon: 0.60, helmet: 0.15, armor: 0.30, shoes: 0.10 },
  });
  assert.deepEqual(STATS_INTERNAL_WEIGHTS, { level: 0.40, abilities: 0.60 });
  assert.equal(GEAR_MAX_LEVEL, 15);
  assert.equal(HORSE_MAX_LEVEL, 80);
  assert.equal(HORSE_SCORING_LEVEL_CAP, 80);
  assert.equal(RED_HARE_BASE_BONUS, 35);
  assert.deepEqual(HORSE_GRADE_BONUSES, {
    "담운마": 0,
    "금표마": 8.75,
    "백룡마": 17.5,
    "현풍마": 26.25,
    "적토마": 35,
  });
  assert.equal(ENGRAVING_PRIOR_N, 10);
});

test("레벨은 로스터 백분위, 기량 4종은 최종 표시점수에 합계 그대로 더한다", () => {
  const results = calculateRosterPowerIndexes([
    member({ level: 0, strength: 0, agility: 0, vitality: 0, intelligence: 0 }),
    member({ level: 10, strength: 10, agility: 10, vitality: 10, intelligence: 10 }),
    member({ level: 20, strength: 20, agility: 20, vitality: 20, intelligence: 20, weapon: 15, armor: 15, shoes: 15, horseLevel: 80 }),
  ]);

  assert.deepEqual(results.map(result => result.components.stats.score), [0, 21.0667, 42.1333]);
  assert.equal(results[2].components.stats.level, 20);
  assert.equal(results[2].components.stats.abilityTotal, 80);
  assert.equal(results[2].components.gear.score, 100);
  assert.equal(results[2].components.horse.score, 100);
  assert.equal(results[2].score, 62.64);
  assert.equal(results[2].coverage, 100);
  assert.equal(results[2].status, POWER_STATUSES.CONFIRMED);
  assert.equal(results[2].rankable, true);
});

test("완비된 기량은 로스터 분포가 아니라 네 기량 실제 합계로 선형 비교한다", () => {
  const [jo, hwang] = calculateRosterPowerIndexes([
    member({ level: 0, strength: 230, agility: 0, vitality: 100, intelligence: 100 }),
    member({ level: 0, strength: 100, agility: 1, vitality: 100, intelligence: 4 }),
  ]);

  assert.equal(jo.components.stats.abilityTotal, 430);
  assert.equal(hwang.components.stats.abilityTotal, 205);
  assert.ok(jo.components.stats.score > hwang.components.stats.score);
  assert.deepEqual([jo.components.stats.abilityScore, hwang.components.stats.abilityScore], [19.1111, 9.1111]);
  assert.deepEqual([jo.components.stats.abilityPowerPoints, hwang.components.stats.abilityPowerPoints], [430, 205]);
  assert.deepEqual([jo.components.stats.score, hwang.components.stats.score], [31.4667, 25.4667]);
  assert.ok(jo.components.stats.statPercentiles.agility < hwang.components.stats.statPercentiles.agility);
});

test("동점 레벨에는 같은 midrank를 주고 기량은 로스터 구성과 무관하게 계산한다", () => {
  const tied = calculateRosterPowerIndexes([
    member({ level: 10, strength: 10, agility: 10, vitality: 10, intelligence: 10 }),
    member({ level: 10, strength: 10, agility: 10, vitality: 10, intelligence: 10 }),
    member({ level: 20, strength: 20, agility: 20, vitality: 20, intelligence: 20 }),
  ]);
  assert.deepEqual(tied.map(result => result.components.stats.score), [11.0667, 11.0667, 42.1333]);

  const single = calculateRosterPowerIndexes([member({ strength: 999 })]);
  assert.equal(single[0].components.stats.abilityTotal, 999);
  assert.equal(single[0].components.stats.abilityScore, 44.4);
  assert.equal(single[0].components.stats.abilityPowerPoints, 999);
  assert.equal(single[0].components.stats.score, 46.64);
});

test("기량 원값 1점 증가는 표시 파워를 정확히 1점 올린다", () => {
  const [base, plusOne] = calculateRosterPowerIndexes([
    member({ strength: 100, agility: 100, vitality: 100, intelligence: 100 }),
    member({ strength: 101, agility: 100, vitality: 100, intelligence: 100 }),
  ]);

  close((plusOne.lower - base.lower) * POWER_DISPLAY_SCALE, 1);
  assert.equal(plusOne.components.stats.abilityTotal - base.components.stats.abilityTotal, 1);
  assert.equal(plusOne.components.stats.abilityPowerPoints - base.components.stats.abilityPowerPoints, 1);
});

test("레벨과 각 기량 결측은 Stats coverage에 독립적으로 반영한다", () => {
  const [missingLevel, missingAbility] = calculateRosterPowerIndexes([
    member({ level: unknown(), strength: 10 }),
    member({ level: 10, strength: unknown() }),
  ]);

  assert.equal(missingLevel.components.stats.coverage, 60);
  close(missingLevel.components.stats.lower, 0.2667);
  close(missingLevel.components.stats.upper, 40.2667);
  assert.equal(missingLevel.coverage, 88);
  assert.equal(missingLevel.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(missingLevel.rankable, true);

  assert.equal(missingAbility.components.stats.coverage, 85);
  assert.equal(missingAbility.components.stats.lower, 20);
  assert.equal(missingAbility.components.stats.upper, 80);
  assert.equal(missingAbility.coverage, 95.5);
  assert.equal(missingAbility.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(missingAbility.rankable, true);
  assert.equal(missingAbility.components.stats.statPercentiles.strength, null);
  assert.equal(missingAbility.components.stats.statPercentiles.agility, 50);
});

test("장비는 무기 60%·흉갑 30%·각갑 10%이며 군주 두갑 15%는 추가 보너스다", () => {
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
  assert.deepEqual(general.components.gear.weights, GEAR_INTERNAL_WEIGHTS.general);
  assert.deepEqual(ruler.components.gear.weights, GEAR_INTERNAL_WEIGHTS.ruler);
});

test("무기와 각갑을 고립해 장비 내부 60%·10% 가중치를 검증한다", () => {
  const [weaponOnly, shoesOnly, rulerWeaponOnly, rulerShoesOnly] = calculateRosterPowerIndexes([
    member({ weapon: 15 }),
    member({ shoes: 15 }),
    member({ job: "조조", weapon: 15, helmet: 0, engravings: emptyEngravings(12) }),
    member({ job: "유비", helmet: 0, shoes: 15, engravings: emptyEngravings(12) }),
  ]);

  assert.equal(weaponOnly.components.gear.score, 60);
  assert.equal(shoesOnly.components.gear.score, 10);
  assert.equal(rulerWeaponOnly.components.gear.score, 60);
  assert.equal(rulerShoesOnly.components.gear.score, 10);
  assert.equal(weaponOnly.components.gear.weapon, 100);
  assert.equal(shoesOnly.components.gear.shoes, 100);
});

test("군주 9·8·8과 두갑 5는 일반 장수 9·8·7보다 높은 장비점수다", () => {
  const [jo, hwang] = calculateRosterPowerIndexes([
    member({
      job: "조조", weapon: 9, helmet: 5, armor: 8, shoes: 8,
      engravings: emptyEngravings(12),
    }),
    member({ job: "여몽", weapon: 9, armor: 8, shoes: 7 }),
  ]);

  close(jo.components.gear.score, 62.3333);
  close(hwang.components.gear.score, 56.6667);
  assert.ok(jo.components.gear.score > hwang.components.gear.score);
  assert.ok(jo.score > hwang.score);
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
  close(result.components.gear.coverage, 86.9565);
  close(result.coverage, 95.4348);
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
  close(result.lower, 41.08);
  close(result.upper, 56.08);
  close(result.score, 48.58);
  assert.equal(result.status, POWER_STATUSES.PROVISIONAL);
  assert.equal(result.rankable, true);
});

test("말 5등급은 균등한 기본 보너스를 받고 강화 80강 환산은 별도로 유지한다", () => {
  assert.equal(normalizeHorseName("  적 토마  "), "적토마");
  assert.equal(normalizeHorseName("赤兔馬"), "적토마");
  assert.equal(normalizeHorseName("  백룡마   "), "백룡마");

  const [cloudZero, goldZero, whiteZero, windZero, redZero, redOne, normalMax, redTen, overScoringCap] = calculateRosterPowerIndexes([
    member({ horse: "담운마", horseLevel: 0 }),
    member({ horse: "금표마", horseLevel: 0 }),
    member({ horse: "백룡마", horseLevel: 0 }),
    member({ horse: "현풍마", horseLevel: 0 }),
    member({ horse: " 적 토마 ", horseLevel: 0 }),
    member({ horse: "赤兔馬", horseLevel: 1 }),
    member({ horse: "담운마", horseLevel: 80 }),
    member({ horse: "적토마", horseLevel: 10 }),
    member({ horse: "담운마", horseLevel: 80 }),
  ]);

  assert.deepEqual([
    cloudZero.components.horse.score,
    goldZero.components.horse.score,
    whiteZero.components.horse.score,
    windZero.components.horse.score,
    redZero.components.horse.score,
  ], [0, 8.75, 17.5, 26.25, 35]);
  assert.equal(redZero.components.horse.score, 35);
  close(redOne.components.horse.score, 36.25);
  assert.equal(normalMax.components.horse.score, 100);
  close(redTen.components.horse.score, 47.5);
  assert.equal(overScoringCap.components.horse.score, 100);
  assert.equal(redOne.components.horse.horse, "적토마");
  assert.equal(redOne.components.horse.isRedHare, true);
  assert.equal(redOne.components.horse.gradeRank, 5);
  assert.equal(redOne.components.horse.gradeCount, 5);
  assert.equal(redOne.components.horse.baseBonus, 35);
  assert.equal(redOne.components.horse.level, 1);
  assert.equal(redOne.components.horse.scoringLevel, 1);
  assert.equal(redOne.components.horse.scoringCap, 80);
  close(redOne.components.horse.enhancementScore, 1.25);
  assert.equal(overScoringCap.components.horse.level, 80);
  assert.equal(overScoringCap.components.horse.scoringLevel, 80);
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

  assert.equal(result.components.stats.score, 42.1333);
  assert.equal(result.version, "v1.6");
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
