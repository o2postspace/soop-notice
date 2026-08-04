"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const FALLBACK = require("../data/samguk-fallback.json");
const {
  collectGamcomFactionsWithChromium,
  currentMembersWithPlayerIds,
  runChromiumPage,
  runGamcomChromiumMonitor,
} = require("../lib/samguk-gamcom-chromium-monitor");
const { CURRENT_SEASON_ID } = require("../lib/samguk-observations");

const NATION_LONG = Object.freeze({ "위": "위나라", "촉": "촉나라", "오": "오나라" });

function rscPayload(rows) {
  return `7:["$","section",null,{"data":{"rows":${JSON.stringify(rows)},"emptySlotCount":0}}]`;
}

function rawRow(member, overrides = {}) {
  return {
    nation: NATION_LONG[member.nation],
    crew_name: member.crew || "미확인",
    nickname: member.name,
    job: member.job || "미확인",
    horse: member.horse,
    horse_level: 0,
    weapon: 1,
    helmet: null,
    armor: 1,
    shoes: 1,
    stat_strength: 0,
    stat_agility: 0,
    stat_vitality: 0,
    stat_intelligence: 0,
    ...overrides,
  };
}

function rowsForNation(nation) {
  return FALLBACK.members.filter(member => member.nation === nation).map(member => rawRow(member));
}

function baselinePayload() {
  return {
    source: "google-sheet",
    stale: false,
    seasonId: CURRENT_SEASON_ID,
    sheetUrl: "https://docs.google.com/spreadsheets/d/test-sheet-id/edit",
    members: FALLBACK.members.map(member => ({
      ...member,
      horseLevel: 0,
      weapon: 0,
      helmet: member.job === "군주" ? 0 : null,
      armor: 0,
      shoes: 0,
      strength: 0,
      agility: 0,
      vitality: 0,
      intelligence: 0,
    })),
  };
}

function visiblePayload() {
  const payload = baselinePayload();
  payload.members = payload.members.map(member => ({
    ...member,
    weapon: 1,
    armor: 1,
    shoes: 1,
  }));
  return payload;
}

function unlocked() {
  return { release() {} };
}

function chromiumFixture(overrides = {}) {
  const calls = [];
  const profiles = [];
  const removed = [];
  return {
    calls,
    profiles,
    removed,
    options: {
      chromiumPath: "/usr/bin/google-chrome",
      createProfileDir: () => {
        const value = `/tmp/test-gamcom-profile-${profiles.length + 1}`;
        profiles.push(value);
        return value;
      },
      removeProfileDir: value => removed.push(value),
      runPage: async ({ nation, url, profileDir, attempt }) => {
        calls.push({ nation, url, profileDir, attempt });
        const shortNation = nation[0];
        return rscPayload(rowsForNation(shortNation));
      },
      ...overrides,
    },
  };
}

test("Chromium Gamcom 수집은 3국을 격리 profile로 병렬 수집하고 90명을 exact-set 검증한다", async () => {
  const fixture = chromiumFixture();
  const rows = await collectGamcomFactionsWithChromium(fixture.options);

  assert.equal(rows.length, 90);
  assert.equal(new Set(rows.map(row => row.nickname)).size, 90);
  assert.equal(fixture.calls.length, 3);
  assert.equal(new Set(fixture.calls.map(call => call.profileDir)).size, 3);
  assert.equal(fixture.profiles.length, 3);
  assert.deepEqual([...fixture.removed].sort(), [...fixture.profiles].sort());
  assert.ok(rows.every(row => row.sourceUrl.includes("season=2")));
});

test("Vercel checkpoint payload는 같은 profile에서 한 번 재시도한다", async () => {
  let first = true;
  const fixture = chromiumFixture({
    runPage: async ({ nation, url, profileDir, attempt }) => {
      fixture.calls.push({ nation, url, profileDir, attempt });
      if (first) {
        first = false;
        return "<html><title>Vercel Security Checkpoint</title></html>";
      }
      return rscPayload(rowsForNation(nation[0]));
    },
  });
  const rows = await collectGamcomFactionsWithChromium(fixture.options);
  assert.equal(rows.length, 90);
  assert.equal(fixture.calls.length, 4);
  const retried = fixture.calls.find(call => call.attempt === 1);
  const nationCalls = fixture.calls.filter(call => call.nation === retried.nation);
  assert.deepEqual(nationCalls.map(call => call.attempt), [0, 1]);
  assert.equal(new Set(nationCalls.map(call => call.profileDir)).size, 1);
  assert.deepEqual([...fixture.removed].sort(), [...fixture.profiles].sort());
});

test("Chromium timeout은 child 종료 뒤에 반환해 profile 정리 경합을 막는다", async () => {
  let closed = false;
  let spawnOptions;
  let spawnArguments;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {
    setImmediate(() => {
      closed = true;
      child.emit("close", null, "SIGKILL");
    });
    return true;
  };

  await assert.rejects(runChromiumPage({
    chromiumPath: "/usr/bin/google-chrome",
    profileDir: "/tmp/test-gamcom-profile-timeout",
    url: "https://gamcom-3kingdom.vercel.app/factions/%EC%9C%84?season=2",
    timeoutMs: 1,
    virtualTimeBudgetMs: 1,
    maxOutputBytes: 1024,
    spawnImpl: (_executable, args, options) => {
      spawnArguments = args;
      spawnOptions = options;
      return child;
    },
  }), (error) => {
    assert.equal(closed, true);
    return error.code === "upstream_timeout";
  });
  assert.equal(spawnOptions.detached, process.platform !== "win32");
  assert.equal(spawnOptions.env.HOME, "/tmp/test-gamcom-profile-timeout");
  assert.equal(Object.hasOwn(spawnOptions.env, "SAMGUK_SHEET_WEBHOOK_SECRET"), false);
  assert.equal(spawnArguments.includes("--no-sandbox"), false);
});

test("AbortSignal은 활성 Chromium을 종료하고 close까지 기다린다", async () => {
  const controller = new AbortController();
  let closed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {
    setImmediate(() => {
      closed = true;
      child.emit("close", null, "SIGKILL");
    });
    return true;
  };
  const pending = runChromiumPage({
    chromiumPath: "/usr/bin/google-chrome",
    profileDir: "/tmp/test-gamcom-profile-abort",
    url: "https://gamcom-3kingdom.vercel.app/factions/%EC%9C%84?season=2",
    timeoutMs: 1_000,
    virtualTimeBudgetMs: 1,
    maxOutputBytes: 1024,
    signal: controller.signal,
    spawnImpl: () => child,
  });
  controller.abort();
  await assert.rejects(pending, error => error.code === "aborted" && closed);
});

test("운영원장 90명은 고정 playerId·SOOP ID·국가와 exact-set으로 묶는다", () => {
  const members = currentMembersWithPlayerIds(baselinePayload());
  assert.equal(members.length, 90);
  assert.equal(members[0].playerId, "P001");
  assert.equal(members[89].playerId, "P090");

  const invalid = baselinePayload();
  invalid.members[0] = { ...invalid.members[0], soopId: "wrong_id" };
  assert.throws(() => currentMembersWithPlayerIds(invalid), error => error.code === "invalid_roster");
});

test("Gamcom 상승분은 한 batch로만 운영 Sheet에 기록한다", async () => {
  const fixture = chromiumFixture();
  const batches = [];
  let loads = 0;
  const result = await runGamcomChromiumMonitor({
    ...fixture.options,
    now: () => Date.parse("2026-08-05T04:55:00+09:00"),
    write: true,
    acquireLock: unlocked,
    service: { load: async () => (loads++ === 0 ? baselinePayload() : visiblePayload()) },
    writer: {
      appendSnapshots: async snapshots => {
        batches.push(snapshots);
        return { appendedCount: snapshots.length, duplicateCount: 0 };
      },
    },
  });

  assert.equal(result.matched, 90);
  assert.equal(result.snapshots, 90);
  assert.equal(result.written, 90);
  assert.equal(result.visible, true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 90);
  assert.ok(batches[0].every(snapshot => snapshot.fields.weapon === 1));
});

test("다른 process가 수집 중이면 Sheet와 Chromium을 건드리지 않고 busy skip한다", async () => {
  let loaded = false;
  const busy = new Error("busy");
  busy.code = "queue_lock_timeout";
  const result = await runGamcomChromiumMonitor({
    acquireLock: () => { throw busy; },
    service: { load: async () => { loaded = true; } },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "busy");
  assert.equal(loaded, false);
});
