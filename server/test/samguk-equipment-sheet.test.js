"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  enrichMembersWithPowerIndex,
  mergeEquipmentData,
  parseEquipmentCsv,
} = require("../lib/samguk-sheet");

const HEADERS = [
  "닉네임", "SOOP_ID",
  "무기각인1", "무기각인2", "무기각인3",
  "두갑각인1", "두갑각인2", "두갑각인3",
  "흉갑각인1", "흉갑각인2", "흉갑각인3",
  "각갑각인1", "각갑각인2", "각갑각인3",
  "최종확인", "최근근거", "출처종류", "교차검증수",
];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeCsv(rows) {
  return [HEADERS, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
}

function equipmentRow(overrides = {}) {
  const values = {
    name: "테스트",
    soopId: "test_bj",
    weapon1: "필살 13.5%",
    weapon2: "없음",
    weapon3: "",
    helmet1: "해당없음",
    helmet2: "해당없음",
    helmet3: "해당없음",
    armor1: "강건",
    armor2: "",
    armor3: "",
    shoes1: "난격 3.4",
    shoes2: "",
    shoes3: "",
    observedAt: "2026-08-02 22:00:00",
    evidence: "방송 01:07:54",
    sourceType: "방송/시트",
    sourceCount: "2",
    ...overrides,
  };
  return [
    values.name, values.soopId,
    values.weapon1, values.weapon2, values.weapon3,
    values.helmet1, values.helmet2, values.helmet3,
    values.armor1, values.armor2, values.armor3,
    values.shoes1, values.shoes2, values.shoes3,
    values.observedAt, values.evidence, values.sourceType, values.sourceCount,
  ];
}

test("장비현황은 수치형·이름형 각인과 명시적 결측 상태를 구분한다", () => {
  const result = parseEquipmentCsv(makeCsv([equipmentRow()]));

  assert.equal(result.equipment.length, 1);
  const row = result.equipment[0];
  assert.equal(row.name, "테스트");
  assert.equal(row.soopId, "test_bj");
  assert.equal(row.engravings.length, 12);
  assert.deepEqual(row.engravings[0], {
    slot: "weapon1", state: "observed", name: "필살", value: 13.5, unit: "%",
  });
  assert.equal(row.engravings[1].state, "empty");
  assert.equal(row.engravings[2].state, "unknown");
  assert.equal(row.engravings[3].state, "not_applicable");
  assert.deepEqual(row.engravings[6], {
    slot: "armor1", state: "observed", name: "강건", value: 1, unit: "presence",
  });
  assert.equal(row.engravings[9].name, "난격");
  assert.equal(row.engravings[9].value, 3.4);
  assert.equal(row.observedAt, "2026-08-02T13:00:00.000Z");
  assert.equal(row.sourceType, "sheet+broadcast");
  assert.equal(row.sourceCount, 2);
});

test("장비현황 공백은 0점이 아니라 unknown이며 잘못된 각인 수치는 제외한다", () => {
  const parsed = parseEquipmentCsv(makeCsv([
    equipmentRow({ weapon1: "필살 -3%", weapon2: "", sourceCount: "0" }),
  ]));

  assert.equal(parsed.equipment[0].engravings[0].state, "unknown");
  assert.equal(parsed.equipment[0].engravings[1].state, "unknown");
  assert.equal(parsed.equipment[0].sourceCount, 1);
  assert.match(parsed.warnings.join(" "), /필살 -3%/);
  assert.match(parsed.warnings.join(" "), /교차검증수/);
});

test("장비현황은 SOOP_ID 우선·닉네임 보조로 참가자에 합치고 미일치 행은 경고한다", () => {
  const parsed = parseEquipmentCsv(makeCsv([
    equipmentRow(),
    equipmentRow({ name: "없는사람", soopId: "missing_bj" }),
  ]));
  const members = [
    { name: "테스트", soopId: "test_bj", job: "천강" },
    { name: "닉네임매칭", soopId: "name_only", job: "운책" },
  ];
  const nameOnly = parseEquipmentCsv(makeCsv([
    equipmentRow({ name: "닉네임매칭", soopId: "" }),
  ])).equipment;
  const merged = mergeEquipmentData(members, [...parsed.equipment, ...nameOnly]);

  assert.equal(merged.members[0].engravings[0].name, "필살");
  assert.equal(merged.members[1].engravings[0].name, "필살");
  assert.match(merged.warnings.join(" "), /없는사람/);
  assert.equal(members[0].engravings, undefined, "원본 멤버 객체를 변경하지 않아야 한다");
});

test("유효하지만 다른 SOOP_ID가 있으면 같은 닉네임으로 대신 합치지 않는다", () => {
  const parsed = parseEquipmentCsv(makeCsv([
    equipmentRow({ soopId: "other_valid_id" }),
  ]));
  const merged = mergeEquipmentData([
    { name: "테스트", soopId: "test_bj", job: "천강" },
  ], parsed.equipment);

  assert.equal(merged.members[0].engravings, undefined);
  assert.match(merged.warnings.join(" "), /찾지 못했습니다/);
});

test("일반 장수의 빈 두갑 각인 3칸은 해당 없음으로 바꿔 9개 슬롯만 계산한다", () => {
  const parsed = parseEquipmentCsv(makeCsv([
    equipmentRow({ helmet1: "", helmet2: "", helmet3: "" }),
  ]));
  const merged = mergeEquipmentData([{
    name: "테스트",
    soopId: "test_bj",
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
  }], parsed.equipment);

  assert.deepEqual(
    merged.members[0].engravings.slice(3, 6).map(engraving => engraving.state),
    ["not_applicable", "not_applicable", "not_applicable"],
  );
  const [powered] = enrichMembersWithPowerIndex(merged.members);
  assert.equal(powered.powerComponents.engravings.eligibleSlots, 9);
  assert.equal(powered.powerStatus, "provisional");
});
