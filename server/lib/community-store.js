const crypto = require("node:crypto");
const { pool, toMySQLDate } = require("../db");

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.includes("T") ? text : `${text.replace(" ", "T")}.000Z`;
}

function authorFromRow(row) {
  return {
    mode: "anonymous",
    label: row.author_label,
    isMember: false,
  };
}

function mapPost(row, { includeBody = false } = {}) {
  const post = {
    id: Number(row.id),
    category: row.category,
    title: row.title,
    author: authorFromRow(row),
    commentCount: Number(row.comment_count || 0),
    viewCount: Number(row.view_count || 0),
    recommendCount: Number(row.recommend_count || 0),
    createdAt: iso(row.created_at),
    isPinned: Boolean(row.is_pinned),
  };
  if (includeBody) {
    post.body = row.body;
    post.updatedAt = iso(row.updated_at);
  }
  return post;
}

function mapComment(row) {
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    body: row.body,
    author: authorFromRow(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function targetTable(targetType) {
  if (targetType === "post") return "community_posts";
  if (targetType === "comment") return "community_comments";
  throw new Error("invalid target type");
}

function createCommunityStore(dbPool = pool) {
  return {
    async consumeRateLimit({ key, action, windowMs, limit, now = Date.now() }) {
      const bucketMs = Math.floor(now / windowMs) * windowMs;
      const bucketStart = toMySQLDate(new Date(bucketMs).toISOString());
      const expiresAt = toMySQLDate(new Date(bucketMs + windowMs + 24 * 60 * 60 * 1000).toISOString());
      const [result] = await dbPool.execute(
        `INSERT INTO community_rate_limits
          (bucket_key, action_name, window_start, hits, expires_at, updated_at)
         VALUES (?, ?, ?, 1, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
          hits = LAST_INSERT_ID(hits + 1), expires_at = VALUES(expires_at), updated_at = UTC_TIMESTAMP()`,
        [key, action, bucketStart, expiresAt],
      );
      const hits = Number(result.insertId || 1);
      return { allowed: hits <= limit, hits, retryAfterSeconds: Math.ceil((bucketMs + windowMs - now) / 1000) };
    },

    async claimSubmission({ actorHash, contentHash, action, ttlMs, now = Date.now() }) {
      const claimToken = crypto.randomBytes(16);
      await dbPool.execute(
        `INSERT INTO community_submission_guards
          (actor_hash, content_hash, action_name, claim_token, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           claim_token = IF(expires_at < UTC_TIMESTAMP(), VALUES(claim_token), claim_token),
           expires_at = IF(expires_at < UTC_TIMESTAMP(), VALUES(expires_at), expires_at)`,
        [actorHash, contentHash, action, claimToken, toMySQLDate(new Date(now + ttlMs).toISOString())],
      );
      const [rows] = await dbPool.execute(
        `SELECT claim_token FROM community_submission_guards
         WHERE actor_hash = ? AND content_hash = ? AND action_name = ?`,
        [actorHash, contentHash, action],
      );
      return Boolean(rows[0]) && crypto.timingSafeEqual(rows[0].claim_token, claimToken);
    },

    async createPost({ category, title, body, passwordHash, makeIdentity }) {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `INSERT INTO community_posts
            (category, title, body, author_label, author_key_hash, delete_password_hash)
           VALUES (?, ?, ?, '익명00000000', ?, ?)`,
          [category, title, body, Buffer.alloc(32), passwordHash],
        );
        const id = Number(result.insertId);
        const identity = makeIdentity(id);
        await connection.execute(
          "UPDATE community_posts SET author_label = ?, author_key_hash = ? WHERE id = ?",
          [identity.label, identity.hash, id],
        );
        const [rows] = await connection.execute(
          `SELECT id, category, title, author_label, comment_count, view_count,
                  recommend_count, created_at, is_pinned
           FROM community_posts WHERE id = ?`,
          [id],
        );
        await connection.commit();
        return mapPost(rows[0]);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async listPosts({ category, sort, query, cursor, limit }) {
      const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 30, 1), 50);
      const where = ["p.status = 'active'"];
      const params = [];
      if (category !== "all") {
        where.push("p.category = ?");
        params.push(category);
      }
      if (query) {
        where.push("MATCH(p.title, p.body) AGAINST (? IN NATURAL LANGUAGE MODE)");
        params.push(query);
      }

      if (cursor && sort === "latest") {
        where.push("(p.is_pinned < ? OR (p.is_pinned = ? AND p.id < ?))");
        params.push(cursor.pinned, cursor.pinned, cursor.id);
      } else if (cursor && sort === "popular") {
        where.push(`(p.is_pinned < ? OR (p.is_pinned = ? AND
          (p.recommend_count < ? OR (p.recommend_count = ? AND p.id < ?))))`);
        params.push(cursor.pinned, cursor.pinned, cursor.score, cursor.score, cursor.id);
      }

      const order = sort === "popular"
        ? "p.is_pinned DESC, p.recommend_count DESC, p.id DESC"
        : "p.is_pinned DESC, p.id DESC";
      const [rows] = await dbPool.execute(
        `SELECT p.id, p.category, p.title, p.author_label, p.comment_count,
                p.view_count, p.recommend_count, p.created_at, p.is_pinned
         FROM community_posts p
         WHERE ${where.join(" AND ")}
         ORDER BY ${order}
         LIMIT ${safeLimit + 1}`,
        params,
      );
      const hasMore = rows.length > safeLimit;
      const selected = rows.slice(0, safeLimit);
      return {
        items: selected.map(row => mapPost(row)),
        cursorRow: hasMore ? selected[selected.length - 1] : null,
      };
    },

    async getPostDetail(id, actorHash, viewerHash) {
      const [posts] = await dbPool.execute(
        `SELECT id, category, title, body, author_label, author_key_hash,
                view_count, comment_count, recommend_count, is_pinned, created_at, updated_at
         FROM community_posts WHERE id = ? AND status = 'active'`,
        [id],
      );
      if (!posts[0]) return null;

      const viewToken = crypto.randomBytes(16);
      await dbPool.execute(
        `INSERT INTO community_post_views (post_id, viewer_hash, view_token, expires_at)
         VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))
         ON DUPLICATE KEY UPDATE
           view_token = IF(expires_at < UTC_TIMESTAMP(), VALUES(view_token), view_token),
           expires_at = IF(expires_at < UTC_TIMESTAMP(), VALUES(expires_at), expires_at)`,
        [id, viewerHash, viewToken],
      );
      const [viewRows] = await dbPool.execute(
        "SELECT view_token FROM community_post_views WHERE post_id = ? AND viewer_hash = ?",
        [id, viewerHash],
      );
      const countedView = Boolean(viewRows[0]) && crypto.timingSafeEqual(viewRows[0].view_token, viewToken);
      if (countedView) {
        const [updateResult] = await dbPool.execute(
          "UPDATE community_posts SET view_count = view_count + 1 WHERE id = ? AND status = 'active'",
          [id],
        );
        if (updateResult.affectedRows === 1) posts[0].view_count = Number(posts[0].view_count) + 1;
      }
      const [[comments], [reactions]] = await Promise.all([
        dbPool.execute(
          `SELECT id, post_id, body, author_label, author_key_hash, created_at, updated_at
           FROM community_comments
           WHERE post_id = ? AND status = 'active' ORDER BY id DESC LIMIT 200`,
          [id],
        ),
        dbPool.execute(
          "SELECT 1 FROM community_reactions WHERE post_id = ? AND actor_hash = ? AND reaction_type = 'recommend' LIMIT 1",
          [id, actorHash],
        ),
      ]);
      return {
        post: mapPost(posts[0], { includeBody: true }),
        postOwnerHash: posts[0].author_key_hash,
        comments: comments.reverse().map(row => ({
          ...mapComment(row),
          ownerHash: row.author_key_hash,
        })),
        commentsTruncated: Number(posts[0].comment_count || 0) > comments.length,
        myReaction: reactions.length > 0,
      };
    },

    async getPostOwner(id) {
      const [rows] = await dbPool.execute(
        "SELECT id, delete_password_hash FROM community_posts WHERE id = ? AND status = 'active'",
        [id],
      );
      return rows[0] || null;
    },

    async softDeletePost(id) {
      const [result] = await dbPool.execute(
        `UPDATE community_posts
         SET status = 'deleted', title = '삭제된 게시글입니다', body = '', author_label = '삭제',
             author_key_hash = NULL, delete_password_hash = NULL,
             deleted_at = UTC_TIMESTAMP()
         WHERE id = ? AND status = 'active'`,
        [id],
      );
      return result.affectedRows === 1;
    },

    async createComment({ postId, body, label, actorHash, passwordHash }) {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `INSERT INTO community_comments
            (post_id, body, author_label, author_key_hash, delete_password_hash)
           SELECT id, ?, ?, ?, ? FROM community_posts
           WHERE id = ? AND status = 'active'`,
          [body, label, actorHash, passwordHash, postId],
        );
        if (result.affectedRows !== 1) {
          await connection.rollback();
          return null;
        }
        await connection.execute(
          "UPDATE community_posts SET comment_count = comment_count + 1 WHERE id = ?",
          [postId],
        );
        const [rows] = await connection.execute(
          `SELECT id, post_id, body, author_label, created_at, updated_at
           FROM community_comments WHERE id = ?`,
          [result.insertId],
        );
        await connection.commit();
        return mapComment(rows[0]);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async getCommentOwner(id) {
      const [rows] = await dbPool.execute(
        `SELECT id, post_id, delete_password_hash
         FROM community_comments WHERE id = ? AND status = 'active'`,
        [id],
      );
      return rows[0] || null;
    },

    async softDeleteComment(id, postId) {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `UPDATE community_comments
           SET status = 'deleted', body = '', author_label = '삭제', author_key_hash = NULL,
               delete_password_hash = NULL, deleted_at = UTC_TIMESTAMP()
           WHERE id = ? AND status = 'active'`,
          [id],
        );
        if (result.affectedRows === 1) {
          await connection.execute(
            "UPDATE community_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = ?",
            [postId],
          );
        }
        await connection.commit();
        return result.affectedRows === 1;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async toggleReaction(postId, actorHash) {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        const [posts] = await connection.execute(
          "SELECT id FROM community_posts WHERE id = ? AND status = 'active' FOR UPDATE",
          [postId],
        );
        if (!posts[0]) {
          await connection.rollback();
          return null;
        }
        const [existing] = await connection.execute(
          `SELECT 1 FROM community_reactions
           WHERE post_id = ? AND actor_hash = ? AND reaction_type = 'recommend'`,
          [postId, actorHash],
        );
        const active = existing.length === 0;
        if (active) {
          await connection.execute(
            `INSERT INTO community_reactions (post_id, actor_hash, reaction_type)
             VALUES (?, ?, 'recommend')`,
            [postId, actorHash],
          );
          await connection.execute(
            "UPDATE community_posts SET recommend_count = recommend_count + 1 WHERE id = ?",
            [postId],
          );
        } else {
          await connection.execute(
            `DELETE FROM community_reactions
             WHERE post_id = ? AND actor_hash = ? AND reaction_type = 'recommend'`,
            [postId, actorHash],
          );
          await connection.execute(
            "UPDATE community_posts SET recommend_count = GREATEST(recommend_count - 1, 0) WHERE id = ?",
            [postId],
          );
        }
        const [counts] = await connection.execute(
          "SELECT recommend_count FROM community_posts WHERE id = ?",
          [postId],
        );
        await connection.commit();
        return { active, recommendCount: Number(counts[0].recommend_count) };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async createReport({ targetType, targetId, actorHash, reason, detail }) {
      const table = targetTable(targetType);
      const [targets] = await dbPool.execute(
        `SELECT id FROM ${table} WHERE id = ? AND status = 'active'`,
        [targetId],
      );
      if (!targets[0]) return { missing: true };
      const [result] = await dbPool.execute(
        `INSERT IGNORE INTO community_reports
          (target_type, target_id, reporter_hash, reason, detail)
         VALUES (?, ?, ?, ?, ?)`,
        [targetType, targetId, actorHash, reason, detail],
      );
      return { duplicate: result.affectedRows === 0 };
    },

    async listReports({ status, limit }) {
      const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 100);
      const [rows] = await dbPool.execute(
        `SELECT r.id, r.target_type, r.target_id, r.reason, r.detail, r.status,
                r.created_at, r.updated_at,
                CASE WHEN r.target_type = 'post' THEN p.status ELSE c.status END AS target_status,
                CASE WHEN r.target_type = 'post' THEN p.title ELSE cp.title END AS target_title,
                CASE WHEN r.target_type = 'post' THEN LEFT(p.body, 500) ELSE LEFT(c.body, 500) END AS target_excerpt,
                CASE WHEN r.target_type = 'comment' THEN c.post_id ELSE p.id END AS target_post_id
         FROM community_reports r
         LEFT JOIN community_posts p
           ON r.target_type = 'post' AND p.id = r.target_id
         LEFT JOIN community_comments c
           ON r.target_type = 'comment' AND c.id = r.target_id
         LEFT JOIN community_posts cp ON cp.id = c.post_id
         WHERE r.status = ? ORDER BY r.id ASC LIMIT ${safeLimit}`,
        [status],
      );
      return rows.map(row => ({
        id: Number(row.id),
        targetType: row.target_type,
        targetId: Number(row.target_id),
        reason: row.reason,
        detail: row.detail,
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        target: {
          status: row.target_status || "missing",
          title: row.target_title || "",
          excerpt: row.target_excerpt || "",
          postId: row.target_post_id ? Number(row.target_post_id) : null,
        },
      }));
    },

    async moderateTarget(targetType, targetId, action) {
      const table = targetTable(targetType);
      const status = action === "restore" ? "active" : action === "hide" ? "hidden" : "deleted";
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
          `SELECT id, status${targetType === "comment" ? ", post_id" : ""}
           FROM ${table} WHERE id = ? FOR UPDATE`,
          [targetId],
        );
        const current = rows[0];
        if (!current) {
          await connection.rollback();
          return false;
        }
        if (current.status === "deleted") {
          await connection.rollback();
          return false;
        }
        const scrub = status === "deleted"
          ? targetType === "post"
            ? ", title = '삭제된 게시글입니다', body = '', author_label = '삭제', author_key_hash = NULL, delete_password_hash = NULL, deleted_at = UTC_TIMESTAMP()"
            : ", body = '', author_label = '삭제', author_key_hash = NULL, delete_password_hash = NULL, deleted_at = UTC_TIMESTAMP()"
          : "";
        await connection.execute(`UPDATE ${table} SET status = ?${scrub} WHERE id = ?`, [status, targetId]);
        if (targetType === "comment" && current.status !== status) {
          const delta = status === "active" ? 1 : current.status === "active" ? -1 : 0;
          if (delta !== 0) {
            await connection.execute(
              "UPDATE community_posts SET comment_count = GREATEST(comment_count + ?, 0) WHERE id = ?",
              [delta, current.post_id],
            );
          }
        }
        if (action !== "restore") {
          await connection.execute(
            `UPDATE community_reports SET status = 'resolved', updated_at = UTC_TIMESTAMP()
             WHERE target_type = ? AND target_id = ? AND status = 'pending'`,
            [targetType, targetId],
          );
        }
        await connection.commit();
        return true;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async updateReportStatus(id, status) {
      const [result] = await dbPool.execute(
        "UPDATE community_reports SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
        [status, id],
      );
      return result.affectedRows === 1;
    },
  };
}

module.exports = {
  createCommunityStore,
  mapComment,
  mapPost,
};
