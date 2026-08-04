const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const DEFAULT_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=120";

function makeEtag(digest, encoding) {
  return `"${digest}-${encoding}"`;
}

async function encodeJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("JSON cache loader returned a non-serializable value");
  }

  const identity = Buffer.from(json);
  const digest = createHash("sha256").update(identity).digest("base64url");
  const [br, gz] = await Promise.all([
    brotliCompress(identity, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: identity.length,
      },
    }),
    gzip(identity, { level: 4 }),
  ]);

  return {
    identity: { body: identity, etag: makeEtag(digest, "identity") },
    br: { body: br, etag: makeEtag(digest, "br") },
    gzip: { body: gz, etag: makeEtag(digest, "gzip") },
  };
}

function createEncodedJsonCache({
  load,
  ttlMs = 60_000,
  staleIfErrorMs = 15_000,
  getInvalidationToken,
  onRefreshError,
  now = Date.now,
}) {
  if (typeof load !== "function") {
    throw new TypeError("load must be a function");
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError("ttlMs must be a non-negative finite number");
  }
  if (!Number.isFinite(staleIfErrorMs) || staleIfErrorMs < 0) {
    throw new RangeError("staleIfErrorMs must be a non-negative finite number");
  }
  if (getInvalidationToken !== undefined && typeof getInvalidationToken !== "function") {
    throw new TypeError("getInvalidationToken must be a function");
  }

  let cached = null;
  let inFlight = null;
  let generation = 0;
  let invalidationTokenInitialized = false;
  let invalidationToken;

  function clear() {
    generation += 1;
    cached = null;
    inFlight = null;
  }

  function synchronizeInvalidationToken() {
    if (!getInvalidationToken) return;
    const nextToken = getInvalidationToken();
    if (!invalidationTokenInitialized) {
      invalidationToken = nextToken;
      invalidationTokenInitialized = true;
      return;
    }
    if (!Object.is(nextToken, invalidationToken)) {
      invalidationToken = nextToken;
      clear();
    }
  }

  async function refresh(refreshGeneration) {
    const value = await load();
    const variants = await encodeJson(value);
    const entry = {
      variants,
      expiresAt: now() + ttlMs,
    };
    if (generation === refreshGeneration) cached = entry;
    return entry;
  }

  return {
    get() {
      synchronizeInvalidationToken();
      if (cached && now() < cached.expiresAt) {
        return Promise.resolve(cached);
      }

      if (!inFlight) {
        const refreshGeneration = generation;
        const promise = refresh(refreshGeneration)
          .catch((error) => {
            if (generation !== refreshGeneration || !cached) throw error;
            cached.expiresAt = now() + staleIfErrorMs;
            if (typeof onRefreshError === "function") onRefreshError(error);
            return cached;
          })
          .finally(() => {
            if (inFlight?.promise === promise) inFlight = null;
          });
        inFlight = { generation: refreshGeneration, promise };
      }
      return inFlight.promise;
    },
    invalidate() {
      clear();
    },
  };
}

function validateInvalidationPath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("cache invalidation path must be absolute");
  }
  return path.normalize(filePath);
}

function readCacheInvalidationToken(filePath) {
  const target = validateInvalidationPath(filePath);
  try {
    return fs.readFileSync(target, "utf8").trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function markCacheInvalidated(filePath, { now = Date.now, nonce = randomUUID } = {}) {
  const target = validateInvalidationPath(filePath);
  if (typeof now !== "function" || typeof nonce !== "function") {
    throw new TypeError("cache invalidation clock and nonce must be functions");
  }
  const directory = path.dirname(target);
  const token = `${new Date(now()).toISOString()}:${process.pid}:${nonce()}`;
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${nonce()}.tmp`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
  return token;
}

function parseAcceptEncoding(header) {
  const accepted = new Map();
  if (typeof header !== "string" || header.trim() === "") {
    return accepted;
  }

  for (const part of header.split(",")) {
    const [rawName, ...parameters] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;

    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(\d*(?:\.\d+)?)\s*$/i.exec(parameter);
      if (!match) continue;
      const parsed = Number(match[1]);
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      break;
    }
    accepted.set(name, quality);
  }
  return accepted;
}

function selectEncoding(header) {
  if (typeof header !== "string" || header.trim() === "") {
    return "identity";
  }

  const accepted = parseAcceptEncoding(header);
  const wildcard = accepted.get("*");
  const qualityFor = (encoding) => {
    if (accepted.has(encoding)) return accepted.get(encoding);
    if (encoding === "identity") return wildcard === 0 ? 0 : 1;
    return wildcard === undefined ? 0 : wildcard;
  };

  const candidates = ["br", "gzip", "identity"]
    .map((encoding, preference) => ({
      encoding,
      preference,
      quality: qualityFor(encoding),
    }))
    .filter(candidate => candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.preference - b.preference);

  return candidates[0]?.encoding || null;
}

function appendVary(res, field) {
  const existing = res.getHeader("Vary");
  const values = Array.isArray(existing)
    ? existing.flatMap(value => String(value).split(","))
    : String(existing || "").split(",");
  const normalized = values.map(value => value.trim()).filter(Boolean);

  if (normalized.includes("*") || normalized.some(value => value.toLowerCase() === field.toLowerCase())) {
    return;
  }
  res.setHeader("Vary", [...normalized, field].join(", "));
}

function etagMatches(header, etag) {
  if (typeof header !== "string") return false;
  if (header.trim() === "*") return true;

  const normalizedTarget = etag.replace(/^W\//, "");
  const tags = header.match(/(?:W\/)?"[^"]*"/g) || [];
  return tags.some(tag => tag.replace(/^W\//, "") === normalizedTarget);
}

function sendEncodedJson(req, res, entry, {
  cacheControl = DEFAULT_CACHE_CONTROL,
} = {}) {
  const encoding = selectEncoding(req.headers["accept-encoding"]);

  appendVary(res, "Accept-Encoding");
  if (!encoding) {
    res.statusCode = 406;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }

  const variant = entry.variants[encoding];
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("ETag", variant.etag);

  if (etagMatches(req.headers["if-none-match"], variant.etag)) {
    res.statusCode = 304;
    res.removeHeader("Content-Type");
    res.removeHeader("Content-Length");
    res.removeHeader("Content-Encoding");
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(variant.body.length));
  if (encoding === "identity") {
    res.removeHeader("Content-Encoding");
  } else {
    res.setHeader("Content-Encoding", encoding);
  }

  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(variant.body);
  }
}

module.exports = {
  DEFAULT_CACHE_CONTROL,
  createEncodedJsonCache,
  encodeJson,
  etagMatches,
  markCacheInvalidated,
  parseAcceptEncoding,
  readCacheInvalidationToken,
  selectEncoding,
  sendEncodedJson,
};
