const crypto = require("node:crypto");
const { Router } = require("express");
const { createProfanityFilter } = require("../lib/community-filter");
const {
  anonymousLabel,
  contentHash,
  getGuestIdentity,
  hashDeletePassword,
  hmac,
  networkHash,
  resolveIdentitySecret,
  scopedActorHash,
  verifyDeletePassword,
} = require("../lib/community-security");
const { createCommunityStore } = require("../lib/community-store");
const { requireCommunityAdmin } = require("../middleware/admin-auth");

const CATEGORIES = new Set(["all", "free", "samguk", "question"]);
const REPORT_REASONS = new Set(["profanity", "spam", "personal_info", "other"]);
const REPORT_STATUSES = new Set(["pending", "resolved", "dismissed"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const URL_PATTERN = /https?:\/\/|www\./gi;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function requireText(value, { name, min, max, maxUrls = Infinity, singleLine = false }) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${name}을(를) 입력해주세요`, "INVALID_TYPE");
  }
  const text = cleanText(value);
  if (text.length < min || text.length > max) {
    throw new HttpError(400, `${name}은(는) ${min}~${max}자로 입력해주세요`, "INVALID_LENGTH");
  }
  if ((text.match(URL_PATTERN) || []).length > maxUrls) {
    throw new HttpError(400, `${name}에 링크가 너무 많습니다`, "TOO_MANY_LINKS");
  }
  if (singleLine && text.includes("\n")) {
    throw new HttpError(400, `${name}은(는) 한 줄로 입력해주세요`, "INVALID_FORMAT");
  }
  return text;
}

function requireId(value) {
  if (!/^\d+$/.test(String(value || ""))) {
    throw new HttpError(400, "올바르지 않은 번호입니다", "INVALID_ID");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new HttpError(400, "올바르지 않은 번호입니다", "INVALID_ID");
  }
  return id;
}

function requireDeletePassword(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "삭제 비밀번호를 입력해주세요", "INVALID_DELETE_PASSWORD");
  }
  const password = value;
  if (password.length < 4 || password.length > 64) {
    throw new HttpError(400, "삭제 비밀번호는 4~64자로 입력해주세요", "INVALID_DELETE_PASSWORD");
  }
  return password;
}

function encodeCursor(row, sort) {
  if (!row) return null;
  const payload = {
    v: 1,
    s: sort,
    p: Number(row.is_pinned || 0),
    i: Number(row.id),
  };
  if (sort === "popular") payload.r = Number(row.recommend_count || 0);
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(value, sort) {
  if (!value) return null;
  if (String(value).length > 256) {
    throw new HttpError(400, "올바르지 않은 cursor입니다", "INVALID_CURSOR");
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (parsed.v !== 1 || parsed.s !== sort) throw new Error("bad cursor");
    if (![0, 1].includes(parsed.p) || !Number.isSafeInteger(parsed.i) || parsed.i < 1) {
      throw new Error("bad cursor");
    }
    if (sort === "popular" && (!Number.isSafeInteger(parsed.r) || parsed.r < 0)) {
      throw new Error("bad cursor");
    }
    return { pinned: parsed.p, id: parsed.i, score: parsed.r || 0 };
  } catch {
    throw new HttpError(400, "올바르지 않은 cursor입니다", "INVALID_CURSOR");
  }
}

function buffersEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function allowedOrigins(env = process.env) {
  const defaults = ["https://soopnotice.com", "https://www.soopnotice.com"];
  return new Set([
    ...defaults,
    ...String(env.COMMUNITY_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean),
  ]);
}

function isAllowedOrigin(origin, configured, env = process.env) {
  if (!origin) return env.NODE_ENV !== "production";
  if (configured.has(origin)) return true;
  if (env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function createRouter({
  store = createCommunityStore(),
  env = process.env,
  profanityFilter = createProfanityFilter(env.COMMUNITY_BLOCKED_WORDS),
  now = () => Date.now(),
} = {}) {
  const router = Router();
  const secret = resolveIdentitySecret(env);
  const origins = allowedOrigins(env);
  const production = env.NODE_ENV === "production";
  const cookieName = production ? "__Host-soop-community" : "soop_community_guest_dev";

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (MUTATING_METHODS.has(req.method) && !isAllowedOrigin(req.get("origin"), origins, env)) {
      return res.status(403).json({ error: "허용되지 않은 요청 출처입니다", code: "ORIGIN_FORBIDDEN" });
    }
    return next();
  });

  router.get("/moderation/reports", requireCommunityAdmin, async (req, res) => {
    const status = req.query.status || "pending";
    if (!REPORT_STATUSES.has(status)) {
      throw new HttpError(400, "올바르지 않은 신고 상태입니다", "INVALID_REPORT_STATUS");
    }
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), 100);
    const items = await store.listReports({ status, limit });
    res.json({ items });
  });

  router.patch("/moderation/reports/:id", requireCommunityAdmin, async (req, res) => {
    const id = requireId(req.params.id);
    const status = req.body?.status;
    if (!new Set(["resolved", "dismissed"]).has(status)) {
      throw new HttpError(400, "올바르지 않은 신고 상태입니다", "INVALID_REPORT_STATUS");
    }
    const changed = await store.updateReportStatus(id, status);
    if (!changed) throw new HttpError(404, "신고를 찾을 수 없습니다", "NOT_FOUND");
    res.json({ ok: true });
  });

  router.patch("/moderation/:targetType/:targetId", requireCommunityAdmin, async (req, res) => {
    const { targetType } = req.params;
    const targetId = requireId(req.params.targetId);
    const action = req.body?.action;
    if (!["post", "comment"].includes(targetType) || !["hide", "restore", "delete"].includes(action)) {
      throw new HttpError(400, "올바르지 않은 관리 작업입니다", "INVALID_MODERATION_ACTION");
    }
    const changed = await store.moderateTarget(targetType, targetId, action);
    if (!changed) throw new HttpError(404, "대상을 찾을 수 없습니다", "NOT_FOUND");
    res.json({ ok: true });
  });

  router.use((req, res, next) => {
    if (!secret) {
      return res.status(503).json({
        error: "커뮤니티 보안 설정이 완료되지 않았습니다",
        code: "COMMUNITY_NOT_CONFIGURED",
      });
    }
    try {
      req.communityIdentity = getGuestIdentity(req, res, {
        secret,
        cookieName,
        secureCookie: production || env.COMMUNITY_SECURE_COOKIE === "1",
      });
      req.communityNetworkHash = networkHash(req, secret, now());
      return next();
    } catch (error) {
      return next(error);
    }
  });

  async function enforceRate(req, res, action, limit, windowMs) {
    const deviceKey = hmac(secret, `rate-device:${req.communityIdentity.rootHash.toString("hex")}`);
    const checks = await Promise.all([
      store.consumeRateLimit({ key: deviceKey, action: `${action}:device`, windowMs, limit, now: now() }),
      store.consumeRateLimit({ key: req.communityNetworkHash, action: `${action}:network`, windowMs, limit: limit * 3, now: now() }),
    ]);
    const blocked = checks.find(result => !result.allowed);
    if (blocked) {
      res.set("Retry-After", String(Math.max(1, blocked.retryAfterSeconds)));
      throw new HttpError(429, "요청이 너무 많습니다. 잠시 후 다시 시도해주세요", "RATE_LIMITED");
    }
  }

  function rejectProfanity(...values) {
    if (values.some(value => profanityFilter.hasBlockedTerm(value))) {
      throw new HttpError(422, "비속어가 포함되어 있습니다", "PROFANITY_BLOCKED");
    }
  }

  router.get("/posts", async (req, res) => {
    const category = req.query.category || "all";
    if (!CATEGORIES.has(category)) throw new HttpError(400, "올바르지 않은 말머리입니다", "INVALID_CATEGORY");
    const sort = req.query.sort || "latest";
    if (!["latest", "popular"].includes(sort)) throw new HttpError(400, "올바르지 않은 정렬입니다", "INVALID_SORT");
    if (req.query.q !== undefined && typeof req.query.q !== "string") {
      throw new HttpError(400, "검색어 형식이 올바르지 않습니다", "INVALID_QUERY");
    }
    const query = cleanText(req.query.q).slice(0, 51);
    if (query.length > 50) throw new HttpError(400, "검색어는 50자 이하로 입력해주세요", "INVALID_QUERY");
    if (query && query.length < 2) throw new HttpError(400, "검색어는 2자 이상 입력해주세요", "INVALID_QUERY");
    if (query) await enforceRate(req, res, "search", 30, 60 * 1000);
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 30, 10), 50);
    const cursor = decodeCursor(req.query.cursor, sort);
    const result = await store.listPosts({ category, sort, query, cursor, limit });
    res.json({
      items: result.items,
      nextCursor: encodeCursor(result.cursorRow, sort),
    });
  });

  router.get("/posts/:id", async (req, res) => {
    const id = requireId(req.params.id);
    const actorHash = scopedActorHash(req.communityIdentity.rootHash, `thread:${id}`, secret);
    // 조회수는 쿠키가 아니라 일 단위 네트워크 식별자로 중복 제거한다.
    // 쿠키 삭제/차단을 반복해도 DB write와 조회수를 증폭시키지 않는다.
    const viewHash = hmac(secret, `view-network:${req.communityNetworkHash.toString("hex")}`);
    const detail = await store.getPostDetail(id, actorHash, viewHash);
    if (!detail) throw new HttpError(404, "게시글을 찾을 수 없습니다", "NOT_FOUND");
    detail.post.canDelete = buffersEqual(detail.postOwnerHash, actorHash);
    detail.post.myReaction = detail.myReaction;
    const comments = detail.comments.map(comment => {
      const { ownerHash, ...publicComment } = comment;
      publicComment.canDelete = buffersEqual(ownerHash, actorHash);
      return publicComment;
    });
    res.json({ post: detail.post, comments, commentsTruncated: Boolean(detail.commentsTruncated) });
  });

  router.post("/posts", async (req, res) => {
    await enforceRate(req, res, "post", 5, 10 * 60 * 1000);
    const category = req.body?.category;
    if (!CATEGORIES.has(category) || category === "all") {
      throw new HttpError(400, "올바른 말머리를 선택해주세요", "INVALID_CATEGORY");
    }
    if (req.body?.authorMode && req.body.authorMode !== "anonymous") {
      throw new HttpError(400, "현재는 익명 작성만 지원합니다", "NAMED_MODE_UNAVAILABLE");
    }
    const title = requireText(req.body?.title, { name: "제목", min: 2, max: 120, maxUrls: 1, singleLine: true });
    const body = requireText(req.body?.body, { name: "내용", min: 2, max: 10_000, maxUrls: 3 });
    const deletePassword = requireDeletePassword(req.body?.deletePassword);
    rejectProfanity(title, body);

    const submissionContentHash = contentHash(category, title, body);
    const submissionActorHash = hmac(secret, `submission:${req.communityIdentity.rootHash.toString("hex")}`);
    const unique = await store.claimSubmission({
      actorHash: submissionActorHash,
      contentHash: submissionContentHash,
      action: "post",
      ttlMs: 10 * 60 * 1000,
      now: now(),
    });
    if (!unique) throw new HttpError(409, "같은 글을 연속으로 등록할 수 없습니다", "DUPLICATE_SUBMISSION");

    const passwordHash = await hashDeletePassword(deletePassword);
    const post = await store.createPost({
      category,
      title,
      body,
      passwordHash,
      makeIdentity: id => {
        const hash = scopedActorHash(req.communityIdentity.rootHash, `thread:${id}`, secret);
        return { hash, label: anonymousLabel(hash) };
      },
    });
    res.status(201).json({ post });
  });

  router.delete("/posts/:id", async (req, res) => {
    await enforceRate(req, res, "delete", 10, 15 * 60 * 1000);
    const id = requireId(req.params.id);
    const password = requireDeletePassword(req.body?.deletePassword);
    const owner = await store.getPostOwner(id);
    if (!owner) throw new HttpError(404, "게시글을 찾을 수 없습니다", "NOT_FOUND");
    if (!await verifyDeletePassword(password, owner.delete_password_hash)) {
      throw new HttpError(403, "삭제 비밀번호가 일치하지 않습니다", "DELETE_PASSWORD_MISMATCH");
    }
    await store.softDeletePost(id);
    res.json({ ok: true });
  });

  router.post("/posts/:id/comments", async (req, res) => {
    await enforceRate(req, res, "comment", 20, 10 * 60 * 1000);
    const postId = requireId(req.params.id);
    if (req.body?.authorMode && req.body.authorMode !== "anonymous") {
      throw new HttpError(400, "현재는 익명 작성만 지원합니다", "NAMED_MODE_UNAVAILABLE");
    }
    const body = requireText(req.body?.body, { name: "댓글", min: 2, max: 2_000, maxUrls: 2 });
    const deletePassword = requireDeletePassword(req.body?.deletePassword);
    rejectProfanity(body);
    const actorHash = scopedActorHash(req.communityIdentity.rootHash, `thread:${postId}`, secret);
    const submissionContentHash = contentHash(String(postId), body);
    const unique = await store.claimSubmission({
      actorHash: hmac(secret, `submission:${req.communityIdentity.rootHash.toString("hex")}`),
      contentHash: submissionContentHash,
      action: "comment",
      ttlMs: 3 * 60 * 1000,
      now: now(),
    });
    if (!unique) throw new HttpError(409, "같은 댓글을 연속으로 등록할 수 없습니다", "DUPLICATE_SUBMISSION");
    const passwordHash = await hashDeletePassword(deletePassword);
    const comment = await store.createComment({
      postId,
      body,
      label: anonymousLabel(actorHash),
      actorHash,
      passwordHash,
    });
    if (!comment) throw new HttpError(404, "게시글을 찾을 수 없습니다", "NOT_FOUND");
    res.status(201).json({ comment });
  });

  router.delete("/comments/:id", async (req, res) => {
    await enforceRate(req, res, "delete", 10, 15 * 60 * 1000);
    const id = requireId(req.params.id);
    const password = requireDeletePassword(req.body?.deletePassword);
    const owner = await store.getCommentOwner(id);
    if (!owner) throw new HttpError(404, "댓글을 찾을 수 없습니다", "NOT_FOUND");
    if (!await verifyDeletePassword(password, owner.delete_password_hash)) {
      throw new HttpError(403, "삭제 비밀번호가 일치하지 않습니다", "DELETE_PASSWORD_MISMATCH");
    }
    await store.softDeleteComment(id, Number(owner.post_id));
    res.json({ ok: true });
  });

  router.post("/posts/:id/reactions", async (req, res) => {
    await enforceRate(req, res, "reaction", 60, 10 * 60 * 1000);
    const postId = requireId(req.params.id);
    if (req.body?.type !== "recommend") {
      throw new HttpError(400, "올바르지 않은 추천 유형입니다", "INVALID_REACTION");
    }
    const actorHash = scopedActorHash(req.communityIdentity.rootHash, `thread:${postId}`, secret);
    const result = await store.toggleReaction(postId, actorHash);
    if (!result) throw new HttpError(404, "게시글을 찾을 수 없습니다", "NOT_FOUND");
    res.json(result);
  });

  router.post("/reports", async (req, res) => {
    await enforceRate(req, res, "report", 10, 60 * 60 * 1000);
    const targetType = req.body?.targetType;
    const targetId = requireId(req.body?.targetId);
    const reason = req.body?.reason;
    if (!["post", "comment"].includes(targetType) || !REPORT_REASONS.has(reason)) {
      throw new HttpError(400, "올바른 신고 사유를 선택해주세요", "INVALID_REPORT");
    }
    if (req.body?.detail !== undefined && typeof req.body.detail !== "string") {
      throw new HttpError(400, "신고 내용 형식이 올바르지 않습니다", "INVALID_TYPE");
    }
    const detail = cleanText(req.body?.detail);
    if (detail.length > 500) throw new HttpError(400, "신고 내용은 500자 이하로 입력해주세요", "INVALID_LENGTH");
    const actorHash = scopedActorHash(
      req.communityIdentity.rootHash,
      `report:${targetType}:${targetId}`,
      secret,
    );
    const result = await store.createReport({ targetType, targetId, actorHash, reason, detail });
    if (result.missing) throw new HttpError(404, "신고 대상을 찾을 수 없습니다", "NOT_FOUND");
    if (result.duplicate) throw new HttpError(409, "이미 신고한 항목입니다", "DUPLICATE_REPORT");
    res.status(201).json({ ok: true });
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.code === "SCRYPT_QUEUE_FULL") {
      res.set("Retry-After", "2");
      return res.status(503).json({
        error: "요청이 몰리고 있습니다. 잠시 후 다시 시도해주세요",
        code: "COMMUNITY_BUSY",
      });
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    console.error("community route error", error);
    return res.status(500).json({ error: "서버 오류가 발생했습니다", code: "INTERNAL_ERROR" });
  });

  return router;
}

const router = createRouter();

module.exports = router;
module.exports._test = {
  HttpError,
  cleanText,
  createRouter,
  decodeCursor,
  encodeCursor,
  isAllowedOrigin,
  requireDeletePassword,
  requireId,
  requireText,
};
