const crypto = require("node:crypto");

const ALLOWED_HOSTS = new Set(["script.google.com", "script.googleusercontent.com"]);
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

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
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new SamgukSheetWriterError("response_too_large", "Google Sheet webhook 응답이 너무 큽니다.");
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SamgukSheetWriterError("invalid_response", "Google Sheet webhook 응답이 JSON이 아닙니다.");
  }
  return parsed;
}

function createSamgukSheetWriter(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const webhookUrl = validateWebhookUrl(
    options.webhookUrl || process.env.SAMGUK_SHEET_WEBHOOK_URL || "",
  );
  const secret = validateSecret(
    options.secret || process.env.SAMGUK_SHEET_WEBHOOK_SECRET || "",
  );
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = positiveInt(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const now = options.now || Date.now;

  async function appendSnapshot(snapshot) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: makeSignedRequest(snapshot, { secret, now: now() }),
        redirect: "follow",
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
  SamgukSheetWriterError,
  createSamgukSheetWriter,
  makeSignedRequest,
  readJsonLimited,
  validateWebhookUrl,
};
