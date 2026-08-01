const { timingSafeEqualText } = require("../lib/community-security");

function readAdminKey(req) {
  const direct = req.get("x-admin-key");
  if (direct) return direct;
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function adminMiddleware(resolveKey) {
  return function authenticateAdmin(req, res, next) {
    res.set("Cache-Control", "no-store");
    const configured = resolveKey();
    if (!configured) {
      return res.status(503).json({ error: "관리자 인증이 설정되지 않았습니다", code: "ADMIN_NOT_CONFIGURED" });
    }
    if (!timingSafeEqualText(readAdminKey(req), configured)) {
      return res.status(403).json({ error: "Forbidden", code: "ADMIN_FORBIDDEN" });
    }
    return next();
  };
}

const requireAdmin = adminMiddleware(() => process.env.ADMIN_KEY);
const requireCommunityAdmin = adminMiddleware(
  () => process.env.COMMUNITY_ADMIN_KEY || process.env.ADMIN_KEY,
);

module.exports = { adminMiddleware, readAdminKey, requireAdmin, requireCommunityAdmin };
