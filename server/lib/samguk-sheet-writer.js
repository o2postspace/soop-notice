const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_HOSTS = new Set(["script.google.com", "script.googleusercontent.com"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MAX_PRIVATE_CONFIG_BYTES = 16 * 1024;

class SamgukSheetWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukSheetWriterError";
    this.code = code;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function webhookTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new SamgukSheetWriterError(
      "invalid_config",
      `SAMGUK_SHEET_WEBHOOK_TIMEOUT_MS는 1~${MAX_TIMEOUT_MS} 사이의 정수여야 합니다.`,
    );
  }
  return parsed;
}

function validateWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SamgukSheetWriterError("invalid_config", "Google Apps Script webhook URL이 올바르지 않습니다.");
  }
  if (url.protocol !== "https:" || url.username || url.password || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new SamgukSheetWriterError("invalid_config", "허용된 Google Apps Script HTTPS URL만 사용할 수 있습니다.");
  }
  return url.toString();
}

function validateSecret(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 512) {
    throw new SamgukSheetWriterError("invalid_config", "SAMGUK_SHEET_WEBHOOK_SECRET은 32자 이상이어야 합니다.");
  }
  return value;
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.size === right.size;
}

function readPrivateConfigFile(filePath, label) {
  const resolved = typeof filePath === "string" ? filePath.trim() : "";
  if (!path.isAbsolute(resolved)) {
    throw new SamgukSheetWriterError("invalid_config", `${label}_PATH는 절대 경로여야 합니다.`);
  }
  let descriptor;
  try {
    const initial = fs.lstatSync(resolved);
    const permissions = initial.mode & 0o7777;
    if (!initial.isFile() || initial.isSymbolicLink()
        || initial.size > MAX_PRIVATE_CONFIG_BYTES
        || (typeof process.getuid === "function" && initial.uid !== process.getuid())
        || (permissions & 0o400) === 0 || (permissions & ~0o600) !== 0) {
      throw new SamgukSheetWriterError(
        "invalid_config",
        `${label}_PATH는 현재 사용자 소유의 0400 또는 0600 일반 파일이어야 합니다.`,
      );
    }
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileState(initial, openedBefore)) {
      throw new SamgukSheetWriterError("invalid_config", `${label}_PATH 파일이 읽는 중 변경되었습니다.`);
    }
    const buffer = Buffer.alloc(openedBefore.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const openedAfter = fs.fstatSync(descriptor);
    const final = fs.lstatSync(resolved);
    if (offset !== buffer.length || !sameFileState(openedBefore, openedAfter)
        || !sameFileState(openedAfter, final)) {
      throw new SamgukSheetWriterError("invalid_config", `${label}_PATH 파일이 읽는 중 변경되었습니다.`);
    }
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
      throw new SamgukSheetWriterError("invalid_config", `${label}_PATH 파일 인코딩이 올바르지 않습니다.`);
    }
    return text.trim();
  } catch (error) {
    if (error instanceof SamgukSheetWriterError) throw error;
    throw new SamgukSheetWriterError("invalid_config", `${label}_PATH 파일을 안전하게 읽지 못했습니다.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolvePrivateConfig(optionValue, environmentValue, filePath, label) {
  const value = optionValue || environmentValue
    || (filePath ? readPrivateConfigFile(filePath, label) : "");
  return typeof value === "string" ? value.trim() : value;
}

function makeSignedRequest(snapshot, { secret, now = Date.now() }) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new SamgukSheetWriterError("invalid_snapshot", "승격할 스냅샷이 필요합니다.");
  }
  const payload = JSON.stringify({
    version: 1,
    issuedAt: new Date(now).toISOString(),
    snapshot,
  });
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return JSON.stringify({ payload, signature });
}

async function readJsonLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SamgukSheetWriterError("response_too_large", "Google Sheet webhook 응답이 너무 큽니다.");
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SamgukSheetWriterError("response_too_large", "Google Sheet webhook 응답이 너무 큽니다.");
      }
      chunks.push(Buffer.from(value));
    }
  }
  const buffer = Buffer.concat(chunks, total);
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SamgukSheetWriterError("invalid_response", "Google Sheet webhook 응답이 JSON이 아닙니다.");
  }
  return parsed;
}

async function fetchWebhook(fetchImpl, initialUrl, initialInit) {
  let url = validateWebhookUrl(initialUrl);
  let init = { ...initialInit, redirect: "manual" };
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(url, init);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === MAX_REDIRECTS) {
      throw new SamgukSheetWriterError("too_many_redirects", "Google Sheet webhook redirect가 너무 많습니다.");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new SamgukSheetWriterError("invalid_redirect", "Google Sheet webhook redirect가 올바르지 않습니다.");
    }
    url = validateWebhookUrl(new URL(location, url).toString());
    if ([301, 302, 303].includes(response.status) && String(init.method || "GET").toUpperCase() === "POST") {
      const headers = { ...(init.headers || {}) };
      delete headers["Content-Type"];
      delete headers["content-type"];
      init = { ...init, method: "GET", headers, body: undefined, redirect: "manual" };
    }
  }
  throw new SamgukSheetWriterError("too_many_redirects", "Google Sheet webhook redirect가 너무 많습니다.");
}

function createSamgukSheetWriter(options = {}) {
  const mode = String(options.mode || process.env.SAMGUK_SHEET_WRITE_MODE || "webhook").trim();
  if (mode === "oauth") {
    const { createSamgukGoogleSheetWriter } = require("./samguk-google-sheet-writer");
    return createSamgukGoogleSheetWriter(options);
  }
  if (mode !== "webhook") {
    throw new SamgukSheetWriterError("invalid_config", "SAMGUK_SHEET_WRITE_MODE는 webhook 또는 oauth여야 합니다.");
  }
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const webhookUrl = validateWebhookUrl(resolvePrivateConfig(
    options.webhookUrl,
    process.env.SAMGUK_SHEET_WEBHOOK_URL,
    process.env.SAMGUK_SHEET_WEBHOOK_URL_PATH,
    "SAMGUK_SHEET_WEBHOOK_URL",
  ));
  const secret = validateSecret(resolvePrivateConfig(
    options.secret,
    process.env.SAMGUK_SHEET_WEBHOOK_SECRET,
    process.env.SAMGUK_SHEET_WEBHOOK_SECRET_PATH,
    "SAMGUK_SHEET_WEBHOOK_SECRET",
  ));
  const timeoutMs = webhookTimeoutMs(
    options.timeoutMs ?? process.env.SAMGUK_SHEET_WEBHOOK_TIMEOUT_MS,
  );
  const maxResponseBytes = positiveInt(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const now = options.now || Date.now;

  async function appendSnapshot(snapshot) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchWebhook(fetchImpl, webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: makeSignedRequest(snapshot, { secret, now: now() }),
        signal: controller.signal,
      });
      const result = await readJsonLimited(response, maxResponseBytes);
      if (!response.ok || !result.ok) {
        throw new SamgukSheetWriterError(
          "upstream_error",
          `Google Sheet webhook 저장 실패${result.error ? `: ${result.error}` : ""}`,
        );
      }
      return result;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new SamgukSheetWriterError("upstream_timeout", "Google Sheet webhook 시간이 초과되었습니다.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { appendSnapshot };
}

module.exports = {
  ALLOWED_HOSTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_PRIVATE_CONFIG_BYTES,
  MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
  SamgukSheetWriterError,
  createSamgukSheetWriter,
  makeSignedRequest,
  readPrivateConfigFile,
  readJsonLimited,
  validateWebhookUrl,
};
