const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  createProfanityFilter,
  normalizeForFilter,
  normalizeKoreanForFilter,
} = require("../lib/community-filter");
const {
  anonymousLabel,
  hashDeletePassword,
  resolveIdentitySecret,
  scopedActorHash,
  signDeviceId,
  verifyDeletePassword,
  verifySignedDevice,
} = require("../lib/community-security");
const { createRouter, decodeCursor, encodeCursor } = require("../routes/community")._test;

function createFakeStore() {
  const posts = new Map();
  const comments = new Map();
  const rateCalls = [];
  let nextCommentId = 1;

  return {
    posts,
    comments,
    rateCalls,
    async consumeRateLimit(input) {
      rateCalls.push(input);
      return { allowed: true, hits: 1, retryAfterSeconds: 1 };
    },
    async claimSubmission() {
      return true;
    },
    async createPost(input) {
      const id = 1;
      const identity = input.makeIdentity(id);
      posts.set(id, { ...input, identity });
      return {
        id,
        category: input.category,
        title: input.title,
        author: { mode: "anonymous", label: identity.label, isMember: false },
        commentCount: 0,
        viewCount: 0,
        recommendCount: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        isPinned: false,
      };
    },
    async listPosts() {
      return { items: [], cursorRow: null };
    },
    async getPostDetail(id, actorHash, viewerHash) {
      const stored = posts.get(id);
      if (!stored) return null;
      assert.equal(Buffer.isBuffer(actorHash), true);
      assert.equal(Buffer.isBuffer(viewerHash), true);
      assert.notDeepEqual(actorHash, viewerHash);
      return {
        post: {
          id,
          category: stored.category,
          title: stored.title,
          body: stored.body,
          author: { mode: "anonymous", label: stored.identity.label, isMember: false },
          commentCount: comments.size,
          viewCount: 1,
          recommendCount: 0,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          isPinned: false,
        },
        postOwnerHash: stored.identity.hash,
        comments: [...comments.values()].map(comment => ({ ...comment, ownerHash: comment.actorHash })),
        myReaction: false,
      };
    },
    async getPostOwner(id) {
      const stored = posts.get(id);
      return stored ? { delete_password_hash: stored.passwordHash } : null;
    },
    async softDeletePost(id) {
      return posts.delete(id);
    },
    async createComment(input) {
      if (!posts.has(input.postId)) return null;
      const comment = {
        id: nextCommentId++,
        postId: input.postId,
        body: input.body,
        author: { mode: "anonymous", label: input.label, isMember: false },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        actorHash: input.actorHash,
        passwordHash: input.passwordHash,
      };
      comments.set(comment.id, comment);
      return comment;
    },
    async getCommentOwner(id) {
      const comment = comments.get(id);
      return comment ? { post_id: comment.postId, delete_password_hash: comment.passwordHash } : null;
    },
    async softDeleteComment(id) {
      return comments.delete(id);
    },
    async toggleReaction(postId) {
      return posts.has(postId) ? { active: true, recommendCount: 1 } : null;
    },
    async createReport({ targetId }) {
      return posts.has(targetId) ? { duplicate: false } : { missing: true };
    },
    async listReports() {
      return [];
    },
    async moderateTarget() {
      return true;
    },
    async updateReportStatus() {
      return true;
    },
  };
}

async function startApp(t, { store, env }) {
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use("/api/community", createRouter({ store, env, now: () => Date.UTC(2026, 7, 1) }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/community`;
}

const productionEnv = {
  NODE_ENV: "production",
  COMMUNITY_IDENTITY_SECRET: "test-community-secret-that-is-long-enough-1234",
};

test("guest cookie 서명과 글별 익명 이름이 안정적이다", () => {
  const secret = productionEnv.COMMUNITY_IDENTITY_SECRET;
  const signed = signDeviceId("abcdefghijklmnopqrstuvwxyzABCDEFG", secret);
  assert.equal(verifySignedDevice(signed, secret), "abcdefghijklmnopqrstuvwxyzABCDEFG");
  assert.equal(verifySignedDevice(`${signed}x`, secret), null);

  const root = Buffer.alloc(32, 7);
  const first = anonymousLabel(scopedActorHash(root, "thread:11", secret));
  const again = anonymousLabel(scopedActorHash(root, "thread:11", secret));
  const other = anonymousLabel(scopedActorHash(root, "thread:12", secret));
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.match(first, /^익명[0-9A-F]{8}$/);
});

test("삭제 비밀번호를 scrypt로 해시하고 검증한다", async () => {
  const encoded = await hashDeletePassword("safe-pass-123");
  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes("safe-pass-123"), false);
  assert.equal(await verifyDeletePassword("safe-pass-123", encoded), true);
  assert.equal(await verifyDeletePassword("wrong-pass", encoded), false);
});

test("비속어 우회 표기를 정규화하고 일반 단어 예외를 유지한다", () => {
  const filter = createProfanityFilter();
  assert.equal(normalizeForFilter("씨---발"), "씨발");
  assert.equal(normalizeKoreanForFilter("씨1발"), "씨발");
  for (const blocked of ["씨 --- 발", "ㅆ ㅂ", "ㅈ-ㄴ", "f.u.c.k", "b1tch"]) {
    assert.equal(filter.hasBlockedTerm(blocked), true, blocked);
  }
  for (const allowed of [
    "시발점에서 출발",
    "공지 내용을 알아보지도 않고 댓글 달지 마세요",
    "잠을 자지도 못하고 서버가 꺼져서 다시 켰어요",
    "병신년은 육십갑자의 하나입니다",
    "병신일주를 달력에서 확인했습니다",
    "a bit change is expected",
    "an 8-bit chess game",
    "class hole example",
    "정상적인 의견입니다",
  ]) {
    assert.equal(filter.hasBlockedTerm(allowed), false, allowed);
  }
});

test("운영 unsafe 요청은 정확한 Origin과 보안 guest cookie를 요구한다", async t => {
  const store = createFakeStore();
  const base = await startApp(t, { store, env: productionEnv });
  const body = JSON.stringify({
    category: "free",
    title: "정상 제목",
    body: "정상적인 게시글 내용",
    deletePassword: "1234",
  });

  const missingOrigin = await fetch(`${base}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(missingOrigin.status, 403);

  const response = await fetch(`${base}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com" },
    body,
  });
  assert.equal(response.status, 201);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-soop-community=/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  assert.equal(setCookie.includes("Domain="), false);
});

test("동일 guest는 같은 글의 게시글과 댓글에 같은 익명 이름을 쓴다", async t => {
  const store = createFakeStore();
  const base = await startApp(t, { store, env: productionEnv });
  const create = await fetch(`${base}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com" },
    body: JSON.stringify({
      category: "samguk",
      title: "삼국지 이야기",
      body: "오늘 진행 내용을 공유합니다",
      deletePassword: "1234",
    }),
  });
  const cookie = create.headers.get("set-cookie").split(";", 1)[0];
  const createdPost = (await create.json()).post;

  const commentResponse = await fetch(`${base}/posts/1/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://soopnotice.com",
      cookie,
    },
    body: JSON.stringify({ body: "같은 사람이 쓴 댓글입니다", deletePassword: "5678" }),
  });
  assert.equal(commentResponse.status, 201);
  const createdComment = (await commentResponse.json()).comment;
  assert.equal(createdPost.author.label, createdComment.author.label);

  const detail = await fetch(`${base}/posts/1`, { headers: { cookie } });
  const payload = await detail.json();
  assert.equal(payload.post.canDelete, true);
  assert.equal(payload.comments[0].canDelete, true);
  assert.equal("ownerHash" in payload.comments[0], false);

  const deleteComment = await fetch(`${base}/comments/1`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com", cookie },
    body: JSON.stringify({ deletePassword: "5678" }),
  });
  assert.equal(deleteComment.status, 200);
  assert.deepEqual(await deleteComment.json(), { ok: true });
});

test("추천·신고·비밀번호 삭제 API가 guest identity로 동작한다", async t => {
  const store = createFakeStore();
  const base = await startApp(t, { store, env: productionEnv });
  const create = await fetch(`${base}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com" },
    body: JSON.stringify({
      category: "question",
      title: "질문 게시글",
      body: "테스트를 위한 정상 내용입니다",
      deletePassword: "post-pass",
    }),
  });
  const cookie = create.headers.get("set-cookie").split(";", 1)[0];

  const reaction = await fetch(`${base}/posts/1/reactions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com", cookie },
    body: JSON.stringify({ type: "recommend" }),
  });
  assert.equal(reaction.status, 200);
  assert.deepEqual(await reaction.json(), { active: true, recommendCount: 1 });

  const report = await fetch(`${base}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com", cookie },
    body: JSON.stringify({ targetType: "post", targetId: 1, reason: "spam", detail: "반복 게시물" }),
  });
  assert.equal(report.status, 201);
  assert.deepEqual(await report.json(), { ok: true });

  const deletion = await fetch(`${base}/posts/1`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com", cookie },
    body: JSON.stringify({ deletePassword: "post-pass" }),
  });
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { ok: true });
});

test("비속어는 저장 전 422로 차단하고 삭제 시도도 공유 rate limit을 먼저 거친다", async t => {
  const store = createFakeStore();
  const base = await startApp(t, { store, env: productionEnv });
  const blocked = await fetch(`${base}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com" },
    body: JSON.stringify({
      category: "free",
      title: "정상 제목",
      body: "씨-발 이라고 우회",
      deletePassword: "1234",
    }),
  });
  assert.equal(blocked.status, 422);
  assert.equal((await blocked.json()).code, "PROFANITY_BLOCKED");

  const before = store.rateCalls.length;
  const missing = await fetch(`${base}/posts/999`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "https://soopnotice.com" },
    body: JSON.stringify({ deletePassword: "wrong" }),
  });
  assert.equal(missing.status, 404);
  assert.equal(store.rateCalls.length, before + 2);
});

test("cursor는 정렬 정보를 검증하고 과대 입력을 거부한다", () => {
  const encoded = encodeCursor({ id: 30, is_pinned: 1, recommend_count: 7 }, "popular");
  assert.deepEqual(decodeCursor(encoded, "popular"), { pinned: 1, id: 30, score: 7 });
  assert.throws(() => decodeCursor(encoded, "latest"), /cursor/);
  assert.throws(() => decodeCursor("a".repeat(257), "latest"), /cursor/);
});

test("identity secret에는 하드코딩 fallback이 없고 기존 server secret은 분리 파생한다", () => {
  assert.equal(resolveIdentitySecret({}), null);
  assert.equal(resolveIdentitySecret({ COMMUNITY_IDENTITY_SECRET: "short" }), null);
  const derived = resolveIdentitySecret({ SERVER_SECRET: "shared-but-configured-secret" });
  assert.equal(typeof derived, "string");
  assert.ok(derived.length >= 32);
});

test("관리자 API는 query key를 거부하고 전용 header만 허용한다", { concurrency: false }, async t => {
  const previous = process.env.COMMUNITY_ADMIN_KEY;
  process.env.COMMUNITY_ADMIN_KEY = "test-admin-key-that-is-not-a-fallback";
  t.after(() => {
    if (previous === undefined) delete process.env.COMMUNITY_ADMIN_KEY;
    else process.env.COMMUNITY_ADMIN_KEY = previous;
  });
  const store = createFakeStore();
  const base = await startApp(t, { store, env: productionEnv });

  const queryKey = await fetch(`${base}/moderation/reports?key=${process.env.COMMUNITY_ADMIN_KEY}`);
  assert.equal(queryKey.status, 403);

  const headerKey = await fetch(`${base}/moderation/reports`, {
    headers: { "x-admin-key": process.env.COMMUNITY_ADMIN_KEY },
  });
  assert.equal(headerKey.status, 200);
  assert.match(headerKey.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await headerKey.json(), { items: [] });
});
