const crypto = require("node:crypto");
const net = require("node:net");
const { promisify } = require("node:util");

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_CONCURRENCY = 1;
const SCRYPT_MAX_QUEUE = 16;
let activeScryptJobs = 0;
const scryptQueue = [];

function acquireScryptSlot() {
  if (activeScryptJobs < SCRYPT_CONCURRENCY) {
    activeScryptJobs += 1;
    return Promise.resolve();
  }
  if (scryptQueue.length >= SCRYPT_MAX_QUEUE) {
    const error = new Error("scrypt queue is full");
    error.code = "SCRYPT_QUEUE_FULL";
    return Promise.reject(error);
  }
  return new Promise(resolve => scryptQueue.push(resolve));
}

function releaseScryptSlot() {
  const next = scryptQueue.shift();
  if (next) next();
  else activeScryptJobs = Math.max(0, activeScryptJobs - 1);
}

async function runScrypt(password, salt, keyLength, options) {
  await acquireScryptSlot();
  try {
    return await scryptAsync(password, salt, keyLength, options);
  } finally {
    releaseScryptSlot();
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest();
}

function resolveIdentitySecret(env = process.env) {
  if (env.COMMUNITY_IDENTITY_SECRET) {
    return Buffer.byteLength(env.COMMUNITY_IDENTITY_SECRET) >= 32
      ? env.COMMUNITY_IDENTITY_SECRET
      : null;
  }
  const baseSecret = env.SERVER_SECRET || env.SESSION_SECRET;
  if (!baseSecret) return null;
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(baseSecret),
    Buffer.alloc(0),
    Buffer.from("soop-notice/community-identity/v1"),
    32,
  )).toString("base64url");
}

function signDeviceId(deviceId, secret) {
  return `${deviceId}.${hmac(secret, `device:${deviceId}`).toString("base64url")}`;
}

function verifySignedDevice(value, secret) {
  if (!value || typeof value !== "string") return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const deviceId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(deviceId)) return null;
  const expected = hmac(secret, `device:${deviceId}`).toString("base64url");
  return timingSafeEqualText(signature, expected) ? deviceId : null;
}

function serializeCookie(name, value, {
  maxAge = 365 * 24 * 60 * 60,
  secure = true,
  path = "/",
} = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.floor(maxAge)}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function getGuestIdentity(req, res, {
  secret,
  cookieName = "__Host-soop-community",
  secureCookie = true,
} = {}) {
  if (!secret || Buffer.byteLength(secret) < 32) {
    const error = new Error("COMMUNITY_IDENTITY_SECRET must be at least 32 bytes");
    error.code = "COMMUNITY_NOT_CONFIGURED";
    throw error;
  }

  const current = verifySignedDevice(getCookie(req, cookieName), secret);
  const deviceId = current || crypto.randomBytes(24).toString("base64url");
  if (!current) {
    res.append("Set-Cookie", serializeCookie(
      cookieName,
      signDeviceId(deviceId, secret),
      { secure: secureCookie },
    ));
  }

  return {
    deviceId,
    rootHash: hmac(secret, `guest:${deviceId}`),
  };
}

function scopedActorHash(rootHash, scope, secret) {
  return hmac(secret, `scope:${scope}:${rootHash.toString("hex")}`);
}

function anonymousLabel(scopedHash) {
  return `익명${scopedHash.toString("hex").slice(0, 8).toUpperCase()}`;
}

function networkHash(req, secret, now = Date.now()) {
  const cfIp = String(req.get("cf-connecting-ip") || "").trim();
  const address = net.isIP(cfIp) ? cfIp : req.ip || req.socket?.remoteAddress || "unknown";
  const dayBucket = new Date(now).toISOString().slice(0, 10);
  return hmac(secret, `network:${dayBucket}:${address}`);
}

async function hashDeletePassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await runScrypt(String(password), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

async function verifyDeletePassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = String(encoded || "").split("$");
    if (algorithm !== "scrypt") return false;
    if (Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P) return false;
    const salt = Buffer.from(saltText, "base64url");
    if (salt.length !== 16) return false;
    const expected = Buffer.from(hashText, "base64url");
    if (expected.length !== SCRYPT_KEY_LENGTH) return false;
    const derived = await runScrypt(
      String(password),
      salt,
      expected.length,
      {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT_MAXMEM,
      },
    );
    return crypto.timingSafeEqual(expected, derived);
  } catch (error) {
    if (error?.code === "SCRYPT_QUEUE_FULL") throw error;
    return false;
  }
}

function contentHash(...parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest();
}

module.exports = {
  anonymousLabel,
  contentHash,
  getCookie,
  getGuestIdentity,
  hashDeletePassword,
  hmac,
  networkHash,
  resolveIdentitySecret,
  scopedActorHash,
  serializeCookie,
  signDeviceId,
  timingSafeEqualText,
  verifyDeletePassword,
  verifySignedDevice,
};
