#!/usr/bin/env node
/**
 * verify_dev_environment.mjs — Verify the local development environment is
 * isolated from production BEFORE you trust it.
 *
 * Checks:
 *   1. `.env.local` override is present and DATABASE_URL is set.
 *   2. DATABASE_URL targets a development/local database (refuses non-dev URLs
 *      unless --allow-cloud-dev is given for an Atlas makemistakes_dev SRV URL),
 *      so we never probe the production database.
 *   3. The dev MongoDB is reachable, readable, and writable (probe document is
 *      written to a throwaway collection and removed afterwards).
 *   4. A development-only session secret (JWT_ACCESS_SECRET, >= 32 bytes) is in
 *      use.
 *
 * Usage:
 *   node scripts/verify_dev_environment.mjs
 *   node scripts/verify_dev_environment.mjs --allow-cloud-dev  # allow Atlas dev DB
 *
 * The Atlas/loopback safety rules mirror scripts/setup_dev_env.mjs:
 *   - loopback hosts (localhost/127.0.0.1/::1) are accepted by default;
 *   - MongoDB Atlas SRV URLs are accepted only with --allow-cloud-dev AND the
 *     database name exactly 'makemistakes_dev';
 *   - production database names and non-Atlas cloud URLs are always rejected.
 *
 * Exits 0 on success, non-zero on any failure.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { classifyDevDatabaseUrl } from "./lib/devDatabaseUrl.mjs";

const ROOT = process.cwd();
const ALLOW_CLOUD_DEV = process.argv.includes("--allow-cloud-dev");

function loadLocalEnv() {
  for (const name of [".env.local", ".env.development.local", ".env"]) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

function classifyDb(url) {
  return classifyDevDatabaseUrl(url, { allowCloud: ALLOW_CLOUD_DEV });
}

function fail(msg) {
  console.error("❌ [verify-dev-env] " + msg);
  process.exitCode = 1;
}

let failures = 0;

function check(cond, ok, bad) {
  if (cond) {
    console.log("  ✔ " + ok);
  } else {
    console.log("  ✘ " + bad);
    failures += 1;
  }
}

loadLocalEnv();

console.log("Verifying local development environment isolation…\n");

// 1. DATABASE_URL present
const uri = process.env.DATABASE_URL;
check(Boolean(uri && uri.trim()), "DATABASE_URL is set", "DATABASE_URL is missing");
if (!uri || !uri.trim()) {
  fail("No DATABASE_URL available. Run `node scripts/setup_dev_env.mjs` first.");
  process.exit(1);
}

// 2. Dev classification + never probe production
const info = classifyDb(uri.trim());
console.log("  Target database:", info.host || "(none)", "/", info.dbName || "(none)", `(${info.reason})`);

if (!info.devMode) {
  fail(
    "Refusing to verify: DATABASE_URL does not point at a development/local database. " +
      "Atlas development URLs require the --allow-cloud-dev flag and the " +
      "'makemistakes_dev' database name (loopback hosts are always allowed)."
  );
  process.exit(1);
}

// 3. Session secret (dev-only, >= 32 bytes)
const secret = process.env.JWT_ACCESS_SECRET || "";
check(
  Boolean(secret) && Buffer.byteLength(secret, "utf8") >= 32,
  "Development session secret is set (>= 32 bytes)",
  "JWT_ACCESS_SECRET is missing or shorter than 32 bytes"
);

// 4. Connectivity + write probe
const client = new MongoClient(uri.trim(), {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 10000,
});

try {
  await client.connect();
  const db = client.db();
  const ping = await db.command({ ping: 1 });
  check(ping && ping.ok === 1, "Dev MongoDB reachable (ping ok)", "Dev MongoDB not reachable");

  const probeCol = db.collection("__dev_env_probe");
  await probeCol.insertOne({ probe: true, at: new Date() });
  const n = await probeCol.countDocuments({ probe: true });
  check(n >= 1, "Dev MongoDB writable (probe insert ok)", "Dev MongoDB write probe failed");
  await probeCol.deleteMany({ probe: true });
  await probeCol.drop().catch(() => {});
  console.log("  ✔ Probe document cleaned up");
} catch (err) {
  check(false, "", "Failed to connect/write to dev MongoDB: " + (err.message || err));
} finally {
  await client.close();
}

console.log("");
if (failures === 0) {
  console.log("✅ [verify-dev-env] Development environment is isolated and healthy.");
  console.log(
    "   The configured DATABASE_URL is a development database; production configuration was not touched."
  );
  process.exit(0);
} else {
  fail(`${failures} check(s) failed. Fix them before trusting the dev environment.`);
  process.exit(1);
}
