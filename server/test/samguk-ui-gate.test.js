"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  FRAME_BYTES,
  SamgukUiGateError,
  analyzeGrayFrame,
  createGrayFrameParser,
  createSamgukUiGate,
} = require("../lib/samguk-ui-gate");

function solid(value) {
  return Buffer.alloc(FRAME_BYTES, value);
}

function fillRect(frame, x, y, width, height, value) {
  for (let row = y; row < y + height; row += 1) {
    frame.fill(value, row * FRAME_WIDTH + x, row * FRAME_WIDTH + x + width);
  }
}

function titleFrame({ x = 5, y = 4, width = 20, height = 5 } = {}) {
  const frame = solid(120);
  fillRect(frame, x, y, width, height, 35);
  return frame;
}

function panelFrame({ x = 17, y = 4, width = 13, height = 12, background = 70 } = {}) {
  const frame = solid(background);
  fillRect(frame, x, y, width, height, 30);
  // 실제 inventory/tooltip처럼 어두운 패널 안에 희소한 글자·아이콘 edge를 만든다.
  for (let row = y + 1; row < y + height - 1; row += 2) {
    for (let column = x + 2; column < x + width - 1; column += 3) {
      frame[row * FRAME_WIDTH + column] = 90;
    }
  }
  return frame;
}

function deathOverlayFrame() {
  const frame = solid(28);
  for (let x = 18; x < 30; x += 2) frame[12 * FRAME_WIDTH + x] = 88;
  for (let y = 15; y < FRAME_HEIGHT; y += 1) {
    const start = 37 - Math.floor((y - 15) / 2);
    for (let x = start; x < FRAME_WIDTH; x += 1) frame[y * FRAME_WIDTH + x] = 115;
  }
  return frame;
}

function loadingFrame() {
  const frame = solid(30);
  for (let y = 3; y < 24; y += 1) {
    const center = 24 + Math.floor(5 * Math.sin(y));
    for (let x = center - 2; x <= center + 2; x += 1) frame[y * FRAME_WIDTH + x] = 105;
  }
  return frame;
}

function loadingSplashFrame() {
  const frame = solid(25);
  fillRect(frame, 7, 8, 28, 12, 30);
  for (let y = 8; y < 20; y += 1) {
    frame[y * FRAME_WIDTH + 6] = 70;
    frame[y * FRAME_WIDTH + 35] = 70;
  }
  for (let y = 9; y < 19; y += 2) {
    for (let x = 9; x < 33; x += 3) frame[y * FRAME_WIDTH + x] = 90;
  }
  for (let y = 16; y < FRAME_HEIGHT; y += 1) {
    const start = 42 - Math.floor((y - 16) / 2);
    for (let x = start; x < FRAME_WIDTH; x += 1) frame[y * FRAME_WIDTH + x] = 210;
  }
  return frame;
}

function gameplayObjectFrame() {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      frame[y * FRAME_WIDTH + x] = 75 + ((x * 17 + y * 29) % 70);
    }
  }
  for (let y = 5; y < 22; y += 1) {
    const left = 15 + (y % 4);
    const right = 31 - ((y * 3) % 5);
    fillRect(frame, left, y, right - left, 1, 32);
  }
  return frame;
}

test("48x27 gray frame 크기를 고정한다", () => {
  assert.equal(FRAME_WIDTH, 48);
  assert.equal(FRAME_HEIGHT, 27);
  assert.equal(FRAME_BYTES, 1_296);
});

test("어두운 가로 UI title은 화면 좌우 어느 위치에서도 찾는다", () => {
  for (const frame of [titleFrame({ x: 2 }), titleFrame({ x: 26, y: 18 })]) {
    const result = analyzeGrayFrame(frame);
    assert.equal(result.uiCandidate, true);
    assert.equal(result.reason, "candidate");
    assert.equal(result.features.candidateKind, "text_panel");
    assert.ok(result.features.titleContrast >= 42);
    assert.equal(Object.hasOwn(result, "frame"), false);
    assert.equal(Object.hasOwn(result.features, "raw"), false);
  }
});

test("밝은 gameplay와 전체 암전은 거부한다", () => {
  const bright = analyzeGrayFrame(solid(200));
  assert.equal(bright.uiCandidate, false);
  assert.equal(bright.reason, "frame_too_flat");

  const black = analyzeGrayFrame(solid(0));
  assert.equal(black.uiCandidate, false);
  assert.equal(black.reason, "frame_too_dark");
  assert.equal(black.features.overallDarkRatio, 1);
});

test("inventory와 강화형 패널은 위치와 폭이 달라도 찾는다", () => {
  const narrow = analyzeGrayFrame(panelFrame({ x: 3, y: 2 }));
  assert.equal(narrow.uiCandidate, true);
  assert.equal(narrow.features.candidateKind, "panel");
  assert.ok(narrow.features.panelRect.width < 19);

  const wide = analyzeGrayFrame(panelFrame({ x: 18, y: 10, width: 25, height: 12 }));
  assert.equal(wide.uiCandidate, true);
  assert.equal(wide.features.candidateKind, "panel");
  assert.ok(wide.features.panelRect.width >= 19);
});

test("사망 dim, 로딩, 불규칙 gameplay object는 패널로 오인하지 않는다", () => {
  for (const frame of [deathOverlayFrame(), loadingFrame(), loadingSplashFrame(), gameplayObjectFrame()]) {
    const result = analyzeGrayFrame(frame);
    assert.equal(result.uiCandidate, false);
    assert.notEqual(result.reason, "candidate");
    assert.equal(result.features.candidateKind, null);
  }

  const flatDark = analyzeGrayFrame(solid(50), { maxOverallDarkRatio: 1 });
  assert.equal(flatDark.uiCandidate, false);
  assert.equal(flatDark.reason, "frame_too_flat");
});

test("고분산 저조도 loading splash guard는 실제 panel 조건과 별도로 작동한다", () => {
  const splash = loadingSplashFrame();
  const guarded = analyzeGrayFrame(splash);
  assert.equal(guarded.uiCandidate, false);
  assert.ok(guarded.features.overallMean < 48);
  assert.ok(guarded.features.lumaStdDev > 30);

  const unguarded = analyzeGrayFrame(splash, { minHighVariancePanelMean: 0 });
  assert.equal(unguarded.uiCandidate, true);
  assert.equal(unguarded.features.candidateKind, "panel");
});

test("짧거나 여러 프레임이 섞인 입력은 단일 frame 분석에서 거부한다", () => {
  const short = analyzeGrayFrame(solid(10).subarray(0, FRAME_BYTES - 1));
  assert.equal(short.uiCandidate, false);
  assert.equal(short.reason, "short_frame");
  assert.equal(short.features.receivedBytes, FRAME_BYTES - 1);
  assert.equal(short.features.titleContrast, null);

  const oversized = analyzeGrayFrame(Buffer.alloc(FRAME_BYTES + 1));
  assert.equal(oversized.uiCandidate, false);
  assert.equal(oversized.reason, "invalid_frame_size");
});

test("threshold를 조정할 수 있고 잘못된 값과 오타는 즉시 거부한다", () => {
  const frame = titleFrame();
  assert.equal(analyzeGrayFrame(frame).uiCandidate, true);
  const strict = analyzeGrayFrame(frame, { minTitleContrast: 100 });
  assert.equal(strict.uiCandidate, false);
  assert.equal(strict.reason, "no_local_ui_pattern");

  for (const thresholds of [
    { minTitleDarkRatio: 1.1 },
    { darkPixelMax: 64.5 },
    { edgeDelta: 256 },
    { minLumaStdDev: 256 },
    { minBrightRowColumnRatio: 17 },
    { smoothDelta: 21, edgeDelta: 20 },
    { minBrightMean: 150, maxBrightMean: 100 },
    { minTitleContrst: 10 },
  ]) {
    assert.throws(
      () => analyzeGrayFrame(frame, thresholds),
      error => error instanceof SamgukUiGateError && error.code === "invalid_config",
    );
  }

  assert.equal(createSamgukUiGate({ minTitleContrast: 50 }).getState()
    .thresholds.minTitleContrast, 50);
  assert.throws(
    () => createSamgukUiGate({ thresholds: {}, minTitleContrast: 50 }),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => createGrayFrameParser({ maxBufferdBytes: FRAME_BYTES }),
    error => error.code === "invalid_config",
  );
});

test("parser는 임의 chunk 경계에서도 frame 순서를 정확히 복원한다", () => {
  const sums = [];
  const parser = createGrayFrameParser({
    onFrame: frame => sums.push(frame.reduce((sum, pixel) => sum + pixel, 0)),
  });
  const stream = Buffer.concat([solid(3), solid(7), solid(11)]);
  const cuts = [1, 17, FRAME_BYTES - 5, FRAME_BYTES + 33, stream.length];
  let start = 0;
  let parsed = 0;
  for (const end of cuts) {
    parsed += parser.push(stream.subarray(start, end)).framesParsed;
    start = end;
  }

  assert.equal(parsed, 3);
  assert.deepEqual(sums, [3, 7, 11].map(value => value * FRAME_BYTES));
  assert.equal(parser.getState().bufferedBytes, 0);
  assert.equal(parser.getState().totalBytes, stream.length);
});

test("큰 chunk도 한 frame 크기 buffer 상한 안에서 처리한다", () => {
  let count = 0;
  const parser = createGrayFrameParser({
    maxBufferedBytes: FRAME_BYTES,
    onFrame: () => { count += 1; },
  });
  const state = parser.push(Buffer.alloc(FRAME_BYTES * 100, 90));
  assert.equal(count, 100);
  assert.equal(state.totalFrames, 100);
  assert.ok(state.bufferedBytes <= state.maxBufferedBytes);
  assert.equal(state.maxBufferedBytes, FRAME_BYTES);

  assert.throws(
    () => createGrayFrameParser({ maxBufferedBytes: FRAME_BYTES - 1 }),
    error => error.code === "invalid_config",
  );
});

test("통합 gate는 완성 frame의 feature 결과만 내고 partial은 end에서 거부한다", () => {
  const observed = [];
  const gate = createSamgukUiGate({ onResult: result => observed.push(result) });
  const candidate = titleFrame();
  assert.deepEqual(gate.push(candidate.subarray(0, 333)), []);
  const completed = gate.push(candidate.subarray(333));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].uiCandidate, true);
  assert.equal(gate.getState().bufferedBytes, 0);

  assert.deepEqual(gate.push(Buffer.alloc(23, 200)), []);
  const final = gate.end();
  assert.equal(final.length, 1);
  assert.equal(final[0].reason, "short_frame");
  assert.equal(final[0].features.receivedBytes, 23);
  assert.deepEqual(observed, [completed[0], final[0]]);

  const visible = JSON.stringify({ completed, final, state: gate.getState() });
  assert.equal(visible.includes(candidate.toString("hex")), false);
});

test("parser는 byte가 아닌 chunk와 종료 뒤 입력을 거부하며 reset 후 재사용된다", () => {
  const parser = createGrayFrameParser();
  assert.throws(
    () => parser.push("not-bytes"),
    error => error.code === "invalid_chunk",
  );
  parser.push(Buffer.alloc(10));
  assert.equal(parser.end().discardedBytes, 10);
  assert.throws(
    () => parser.push(Buffer.alloc(1)),
    error => error.code === "parser_ended",
  );
  assert.equal(parser.reset().ended, false);
  assert.equal(parser.push(solid(1)).framesParsed, 1);
});
