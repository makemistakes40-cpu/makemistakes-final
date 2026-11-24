// READ-ONLY production migration audit.
// Connects to the new Atlas cluster using the SAME credentials from the app's
// env files, but targets the production database name `makemistakes`
// (database-name override ONLY - no env files are modified, no writes).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import mongodb from "mongodb";
import { EJSON } from "bson";

const { MongoClient } = mongodb;
const out = (s) => process.stdout.write(s + "\n");

const DEFAULT_DNS_SERVERS = ["8.8.8.8", "1.1.1.1", "8.8.4.4"];
(function initDns() {
  const disabled = process.env.DISABLE_CUSTOM_DNS === "true" || process.env.DNS_FALLBACK === "false";
  if (disabled) return;
  try {
    if (typeof dns.setDefaultResultOrder === "function") dns.setDefaultResultOrder("ipv4first");
    dns.setServers(DEFAULT_DNS_SERVERS);
  } catch {}
})();
let fallbackResolver = null;
function getFallbackResolver() {
  if (!fallbackResolver) { fallbackResolver = new dns.promises.Resolver(); fallbackResolver.setServers(DEFAULT_DNS_SERVERS); }
  return fallbackResolver;
}
function createResilientLookup() {
  return function resilientLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const wantAll = Boolean(options && options.all);
    dns.lookup(hostname, options, (err, address, family) => {
      if (!err && address) return callback(null, address, family);
      (async () => {
        try { const ips = await getFallbackResolver().resolve4(hostname); if (ips && ips.length) return callback(null, wantAll ? ips.map((ip) => ({ address: ip, family: 4 })) : ips[0], wantAll ? undefined : 4); } catch {}
        try { const ip6s = await getFallbackResolver().resolve6(hostname); if (ip6s && ip6s.length) return callback(null, wantAll ? ip6s.map((ip) => ({ address: ip, family: 6 })) : ip6s[0], wantAll ? undefined : 6); } catch {}
        return callback(err || new Error("DNS lookup failed for " + hostname), address, family);
      })();
    });
  };
}

// ---- read raw DATABASE_URL (outer-quote removal only) ----
function getRawDatabaseUrl() {
  const order = [".env.development.local", ".env.local", ".env.development", ".env"];
  for (const fn of order) {
    const p = path.join(process.cwd(), fn);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^DATABASE_URL\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[1].trim();
      if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
      return v;
    }
  }
  return null;
}

// ---- build a URI targeting the production db name, same creds ----
function prodUriFor(rawUri, dbName) {
  const u = new URL(rawUri);
  u.pathname = "/" + dbName;
  return u.toString();
}

const rawUri = getRawDatabaseUrl();
if (!rawUri) { out("FAIL: DATABASE_URL not found"); process.exit(2); }

const PROD_DB = process.env.AUDIT_DB || "makemistakes";
const uri = prodUriFor(rawUri, PROD_DB);

// sanitize for display
function sanitize(u) {
  try {
    const p = new URL(u);
    if (p.password) p.password = "***";
    if (p.username) p.username = p.username.slice(0, 2) + "***";
    return p.toString();
  } catch { return "[unparseable]"; }
}
out("TARGET_DB=" + PROD_DB);
out("HOST=" + (() => { try { return new URL(uri).hostname; } catch { return "?"; } })());

const lookup = createResilientLookup();
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, lookup });
let db;
try {
  out("CONNECTING...");
  await client.connect();
  db = client.db();
  await db.command({ ping: 1 });
  out("CONNECT=PASS");
} catch (e) {
  out("CONNECT=FAIL: " + String(e.message || e).replace(rawUri, "[REDACTED]"));
  process.exit(1);
}

// ---- collection inventory ----
const cols = await db.listCollections().toArray();
out("COLLECTION_COUNT=" + cols.length);
const colStats = {};
for (const c of cols) {
  let n = 0;
  try { n = await db.collection(c.name).countDocuments(); } catch {}
  colStats[c.name] = n;
  out("COLL|" + c.name + "|" + n);
}

// ---- problems deep verification ----
const problemsColl = db.collection("problems");
const pTotal = await problemsColl.countDocuments();
const pDocs = await problemsColl.find({}).toArray();
const pIds = pDocs.map((d) => String(d.problemId ?? d._id));
const seen = new Set();
const dupSet = new Set();
for (const id of pIds) {
  if (seen.has(id)) dupSet.add(id);
  seen.add(id);
}
let missReq = 0, badDiff = 0, fb = 0;
const VALID_DIFF = new Set(["Beginner", "Intermediate", "Advanced"]);
for (const d of pDocs) {
  if (!d.problemId || !d.title || !d.problemStatement || !d.category) missReq++;
  const top = d.difficulty;
  const lvl = d.learning && d.learning.level;
  const resolved = top ?? lvl;
  if ((top === null || top === undefined || top === "") && typeof lvl === "string" && lvl) fb++;
  if (!(typeof resolved === "string" && VALID_DIFF.has(resolved))) badDiff++;
}
out("PROBLEMS_TOTAL=" + pTotal);
out("PROBLEMS_DISTINCT_IDS=" + seen.size);
out("PROBLEMS_DUP_IDS=" + dupSet.size);
out("PROBLEMS_MISSING_REQFIELDS=" + missReq);
out("PROBLEMS_INVALID_DIFF=" + badDiff);
out("PROBLEMS_DIFF_FALLBACK=" + fb);

try {
  const idx = await problemsColl.indexes();
  out("PROBLEMS_INDEXES=" + JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique }))));
} catch (e) {
  out("PROBLEMS_INDEXES=FAIL " + (e.message || e));
}

// ---- compare against backups ----
const keyOf = (d) => { const c = { ...d }; delete c._id; return crypto.createHash("sha256").update(JSON.stringify(c)).digest("hex"); };
const newBy = new Map(pDocs.map((d) => [String(d.problemId ?? d._id), d]));
const backupPaths = process.argv.slice(2);
for (const bp of backupPaths) {
  const fp = path.join(process.cwd(), bp);
  if (!fs.existsSync(fp)) { out("BACKUP_MISSING|" + bp); continue; }
  let arr;
  try { arr = EJSON.deserialize(JSON.parse(fs.readFileSync(fp, "utf8"))); }
  catch (e) { out("BACKUP_PARSE_FAIL|" + bp + "|" + e.message); continue; }
  const bIds = arr.map((d) => String(d.problemId ?? d._id));
  const bSet = new Set(bIds);
  const bSeen = new Set();
  const bDup = new Set();
  for (const id of bIds) { if (bSeen.has(id)) bDup.add(id); bSeen.add(id); }
  const missing = [...bSet].filter((id) => !newBy.has(id));
  const extra = [...newBy.keys()].filter((id) => !bSet.has(id));
  let hashMatch = 0, hashMismatch = 0;
  for (const b of arr) {
    const nd = newBy.get(String(b.problemId ?? b._id));
    if (!nd) continue;
    if (keyOf(b) === keyOf(nd)) hashMatch++; else hashMismatch++;
  }
  out("BACKUP|" + path.basename(bp) + "|total=" + arr.length + "|distinct=" + bSet.size + "|dup=" + bDup.size);
  out("BACKUP_COMPARE|" + path.basename(bp) + "|missing=" + missing.length + "|extra=" + extra.length + "|hash_match=" + hashMatch + "|hash_mismatch=" + hashMismatch);
  if (missing.length && missing.length <= 10) out("BACKUP_MISSING_IDS|" + JSON.stringify(missing));
  if (extra.length && extra.length <= 10) out("BACKUP_EXTRA_IDS|" + JSON.stringify(extra));
}

// ---- other collections - reference relationships ----
if (colStats.user_journeys) {
  out("REL_user_journeys_problems=" + (await db.collection("user_journeys").estimatedDocumentCount()));
}
if (colStats.missions || colStats.tasks) {
  const mc = colStats.missions || 0;
  const tc = colStats.tasks || 0;
  out("REL_missions=" + mc + "|tasks=" + tc);
}

await client.close();
out("DONE");
