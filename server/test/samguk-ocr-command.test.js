"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const {
  SamgukOcrCommandError,
  createSamgukOcrCommand,
} = require("../lib/samguk-ocr-command");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CONTEXT = Object.freeze({
  playerId: "P001",
  targetId: "target-1",
  bjId: "streamer_1",
  observedAt: "2026-08-02T10:00:00.000Z",
});

function png(payload = "png-body") {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(payload)]);
}

function fakeSpawner(behavior) {
  const calls = [];
  function spawnImpl(command, args, options) {
    const input = [];
    const child = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        input.push(Buffer.from(chunk));
        callback();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = signal => {
      child.kills.push(signal);
      return true;
    };
    const call = { command, args, options, input, child };
    calls.push(call);
    queueMicrotask(() => behavior(call));
    return child;
  }
  return { calls, spawnImpl };
}

function closeWith(call, { stdout = [], stderr = [], code = 0 } = {}) {
  for (const chunk of stdout) call.child.stdout.write(chunk);
  for (const chunk of stderr) call.child.stderr.write(chunk);
  call.child.stdout.end();
  call.child.stderr.end();
  call.child.emit("close", code, null);
}

function command(fake, overrides = {}) {
  return createSamgukOcrCommand({
    command: "/opt/samguk/ocr-adapter",
    args: [
      "--profile={profileId}",
      "--player", "{playerId}",
      "--target={targetId}",
      "--bj={bjId}",
      "--observed-at", "{observedAt}",
    ],
    profileId: "equipment-v2",
    timeoutMs: 100,
    maxOutputBytes: 1_024,
    spawnImpl: fake.spawnImpl,
    ...overrides,
  });
}

function safeError(code, secret) {
  return error => {
    const visible = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;
    return error instanceof SamgukOcrCommandError
      && error.code === code
      && !visible.includes(secret)
      && !Object.hasOwn(error, "cause");
  };
}

function trackedAbortSignal() {
  let aborted = false;
  const listeners = new Set();
  const signal = {
    get aborted() { return aborted; },
    addEventListener(type, listener) {
      if (type === "abort") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "abort") listeners.delete(listener);
    },
  };
  return {
    signal,
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test("command·profile·args template과 실행 제한을 엄격히 검증한다", () => {
  const valid = {
    command: "/opt/samguk/ocr",
    profileId: "profile-1",
  };
  for (const options of [
    null,
    {},
    { ...valid, command: "./ocr" },
    { ...valid, command: "/opt/ocr\n--bad" },
    { ...valid, profileId: "bad/profile" },
    { ...valid, args: "--profile" },
    { ...valid, args: ["{unknown}"] },
    { ...valid, args: ["{{profileId}}"] },
    { ...valid, timeoutMs: 0 },
    { ...valid, maxOutputBytes: 0 },
    { ...valid, spawnImpl: true },
    { ...valid, extra: true },
  ]) {
    assert.throws(
      () => createSamgukOcrCommand(options),
      error => error instanceof SamgukOcrCommandError && error.code === "invalid_config",
    );
  }
});

test("PNG는 stdin에만 보내고 허용 template만 argv로 치환한다", async () => {
  const secret = "stdin-only-secret-token";
  const input = png(secret);
  const fake = fakeSpawner(call => closeWith(call, {
    stdout: [Buffer.from('{"version":'), Buffer.from("2}\n")],
    stderr: ["diagnostic"],
  }));
  const output = await command(fake).run(input, CONTEXT);
  const [call] = fake.calls;

  assert.equal(output, '{"version":2}\n');
  assert.equal(call.command, "/opt/samguk/ocr-adapter");
  assert.deepEqual(call.args, [
    "--profile=equipment-v2",
    "--player", "P001",
    "--target=target-1",
    "--bj=streamer_1",
    "--observed-at", "2026-08-02T10:00:00.000Z",
  ]);
  assert.equal(call.args.join(" ").includes(secret), false);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(Object.keys(call.options.env).sort(), Object.keys(call.options.env)
    .filter(key => ["PATH", "LANG", "LC_ALL"].includes(key)).sort());
  assert.equal(Object.hasOwn(call.options.env, "HOME"), false);
  assert.deepEqual(Buffer.concat(call.input), input);
  assert.notStrictEqual(Buffer.concat(call.input), input);
});

test("PNG와 실행 context는 spawn 전에 엄격히 검증한다", async () => {
  const fake = fakeSpawner(() => {});
  const instance = command(fake);
  for (const [input, context, code] of [
    ["not-buffer", CONTEXT, "invalid_png"],
    [Buffer.from("not-png"), CONTEXT, "invalid_png"],
    [png(), { ...CONTEXT, extra: true }, "invalid_context"],
    [png(), { ...CONTEXT, playerId: "P1" }, "invalid_context"],
    [png(), { ...CONTEXT, targetId: "bad/target" }, "invalid_context"],
    [png(), { ...CONTEXT, bjId: "bad-bj" }, "invalid_context"],
    [png(), { ...CONTEXT, observedAt: "not-a-date" }, "invalid_context"],
  ]) {
    await assert.rejects(instance.run(input, context), error => error.code === code);
  }
  assert.equal(fake.calls.length, 0);
});

test("stdout과 stderr cap 초과 시 각각 SIGKILL한다", async () => {
  const stdoutFake = fakeSpawner(call => closeWith(call, { stdout: ["12345"] }));
  await assert.rejects(
    command(stdoutFake, { maxOutputBytes: 4 }).run(png(), CONTEXT),
    error => error.code === "stdout_too_large",
  );
  assert.deepEqual(stdoutFake.calls[0].child.kills, ["SIGKILL"]);

  const secret = "stderr-secret";
  const stderrFake = fakeSpawner(call => closeWith(call, { stderr: [secret], code: 1 }));
  await assert.rejects(
    command(stderrFake, { maxOutputBytes: 4 }).run(png(), CONTEXT),
    safeError("stderr_too_large", secret),
  );
  assert.deepEqual(stderrFake.calls[0].child.kills, ["SIGKILL"]);
});

test("timeout은 SIGKILL하고 뒤늦은 close를 무시한다", async () => {
  let invocation;
  const fake = fakeSpawner(call => { invocation = call; });
  const promise = command(fake, { timeoutMs: 10 }).run(png(), CONTEXT);
  await assert.rejects(promise, error => error.code === "timeout");
  assert.deepEqual(invocation.child.kills, ["SIGKILL"]);
  closeWith(invocation, { stdout: ["late-secret"] });
  assert.deepEqual(invocation.child.kills, ["SIGKILL"]);
});

test("spawn·stdin·프로세스 오류에 입력과 출력의 비밀을 노출하지 않는다", async () => {
  const secret = "super-private-secret";
  const throwing = createSamgukOcrCommand({
    command: "/opt/samguk/ocr",
    profileId: "profile",
    spawnImpl() { throw new Error(secret); },
  });
  await assert.rejects(throwing.run(png(secret), CONTEXT), safeError("spawn_failed", secret));

  const stdinFake = fakeSpawner(call => {
    call.child.stdin.emit("error", new Error(secret));
    call.child.emit("close", 0, null);
  });
  await assert.rejects(
    command(stdinFake).run(png(secret), CONTEXT),
    safeError("stdin_error", secret),
  );
  assert.deepEqual(stdinFake.calls[0].child.kills, ["SIGKILL"]);

  const processFake = fakeSpawner(call => closeWith(call, {
    stdout: [secret],
    stderr: [secret],
    code: 7,
  }));
  await assert.rejects(
    command(processFake).run(png(secret), CONTEXT),
    safeError("command_failed", secret),
  );
});

test("이미 abort된 signal과 잘못된 signal은 spawn 전에 거부한다", async () => {
  const secret = "ocr-abort-reason-secret";
  const fake = fakeSpawner(() => {});
  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(
    command(fake).run(png(), CONTEXT, { signal: controller.signal }),
    safeError("aborted", secret),
  );

  for (const runOptions of [
    null,
    { signal: null },
    { signal: { aborted: false, removeEventListener() {} } },
    { signal: controller.signal, extra: true },
  ]) {
    await assert.rejects(
      command(fake).run(png(), CONTEXT, runOptions),
      error => error.code === "invalid_signal",
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("실행 중 abort는 SIGKILL하고 listener를 제거하며 뒤늦은 close를 무시한다", async () => {
  const tracked = trackedAbortSignal();
  const fake = fakeSpawner(() => {});
  const promise = command(fake).run(png(), CONTEXT, { signal: tracked.signal });
  assert.equal(tracked.listenerCount(), 1);
  tracked.abort();

  await assert.rejects(promise, error => error.code === "aborted");
  const [call] = fake.calls;
  assert.deepEqual(call.child.kills, ["SIGKILL"]);
  assert.equal(tracked.listenerCount(), 0);
  closeWith(call, { stdout: ["late-output"] });
  assert.deepEqual(call.child.kills, ["SIGKILL"]);
});

test("정상 완료 후에도 abort listener를 제거한다", async () => {
  const tracked = trackedAbortSignal();
  const fake = fakeSpawner(call => closeWith(call, { stdout: ["ok"] }));
  assert.equal(await command(fake).run(png(), CONTEXT, { signal: tracked.signal }), "ok");
  assert.equal(tracked.listenerCount(), 0);
});
