const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const envPath = path.resolve(__dirname, "..", ".env");
const rotateAdmin = process.argv.includes("--rotate-admin");

function randomSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function readEnvFile() {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function hasValue(source, name) {
  const match = source.match(new RegExp(`^${name}=(.*)$`, "m"));
  return Boolean(match && match[1].trim());
}

function setValue(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  const prefix = source && !source.endsWith("\n") ? `${source}\n` : source;
  return `${prefix}${line}\n`;
}

let source = readEnvFile();
const changed = [];

if (!hasValue(source, "COMMUNITY_IDENTITY_SECRET")) {
  source = setValue(source, "COMMUNITY_IDENTITY_SECRET", randomSecret());
  changed.push("COMMUNITY_IDENTITY_SECRET");
}

if (rotateAdmin) {
  source = setValue(source, "ADMIN_KEY", randomSecret());
  changed.push("ADMIN_KEY");
}

if (changed.length) {
  const temporaryPath = `${envPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, source, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, envPath);
  fs.chmodSync(envPath, 0o600);
}

console.log(changed.length ? `updated: ${changed.join(", ")}` : "local secrets already configured");
