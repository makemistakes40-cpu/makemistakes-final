// Read-only migration audit. Connects via the app's env path, prints only
// sanitized host/DB name + counts, and compares `problems` against the exports.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import mongodb from "mongodb";
import { EJSON } from "bson";

const { MongoClient } = mongodb;
const out = (s) => process.stdout.write(s + "\n");
out("SCRIPT_START");

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

const root = process.cwd();
const order = [".env.development.local", ".env.local", ".env.development", ".env"];
const env = {};
for (const fn of order) {
  const p = path.join(root, fn);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (m[1] in env) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
      v = v.slice(1, -1);
    }
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    v = v.replace(/(\s+)#[^'"]*$/, "$1");
    v = v.trim();
    env[m[1]] = v;
  }
}

// Use the RAW DATABASE_URL value (only outer-quote removal, no comment/parse
// heuristics) so a parser defect cannot be mistaken for a credential failure.
function getRawDatabaseUrl() {
  const order2 = [".env.development.local", ".env.local", ".env.development", ".env"];
  for (const fn of order2) {
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
const uri = getRawDatabaseUrl();
if (!uri) {
  out("FAIL: DATABASE_URL not found in env");
  process.exit(2);
}
let host = "";
let dbName = "";
try {
  const u = new URL(uri);
  host = u.hostname;
  const seg = u.pathname.split("/").filter(Boolean);
  dbName = seg.length ? decodeURIComponent(seg[0]) : "";
} catch {
  console.log("FAIL: cannot parse DATABASE_URL host/dbname");
  process.exit(2);
}
out("HOST=" + host);
out("DB=" + dbName);

const lookup = createResilientLookup();
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000, connectTimeoutMS: 12000, lookup });
let db;
try {
  out("CONNECTING...");
  await client.connect();
  db = client.db();
  await db.command({ ping: 1 });
  out("CONNECT=PASS");
} catch (e) {
  out("CONNECT=FAIL: " + String(e.message || e).replace(uri, "[REDACTED]"));
  process.exit(1);
}

const cols = await db.listCollections().toArray();
console.log("COLLECTION_COUNT=" + cols.length);
for (const c of cols) {
  let n = 0;
  try {
    n = await db.collection(c.name).countDocuments();
  } catch {}
  console.log("COLL|" + c.name + "|" + n);
}

const problemsColl = db.collection("problems");
const pTotal = await problemsColl.countDocuments();
const pDocs = await problemsColl
  .find({}, { projection: { _id: 1, problemId: 1, title: 1, problemStatement: 1, category: 1, difficulty: 1, learning: 1 } })
  .toArray();
const pIds = pDocs.map((d) => String(d.problemId ?? d._id));
const dupSet = new Set();
const seen = new Set();
for (const id of pIds) {
  if (seen.has(id)) dupSet.add(id);
  seen.add(id);
}
let missReq = 0;
let badDiff = 0;
let fb = 0;
for (const d of pDocs) {
  if (!d.problemId || !d.title || !d.problemStatement || !d.category) missReq++;
  const top = d.difficulty;
  const lvl = d.learning && d.learning.level;
  const resolved = top ?? lvl;
  if ((top === null || top === undefined || top === "") && typeof lvl === "string" && lvl) fb++;
  if (!(typeof resolved === "string" && ["Beginner", "Intermediate", "Advanced"].includes(resolved))) badDiff++;
}
console.log("PROBLEMS_TOTAL=" + pTotal);
console.log("PROBLEMS_DISTINCT_IDS=" + seen.size);
console.log("PROBLEMS_DUP_IDS=" + dupSet.size);
console.log("PROBLEMS_MISSING_REQFIELDS=" + missReq);
console.log("PROBLEMS_INVALID_DIFF=" + badDiff);
console.log("PROBLEMS_DIFF_FALLBACK=" + fb);

try {
  const idx = await problemsColl.indexes();
  console.log(
    "PROBLEMS_INDEXES=" +
      JSON.stringify(idx.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })))
  );
} catch (e) {
  console.log("PROBLEMS_INDEXES=FAIL " + (e.message || e));
}

const backupPaths = process.argv.slice(2);
const keyOf = (d) => {
  const c = { ...d };
  delete c._id;
  return crypto.createHash("sha256").update(JSON.stringify(c)).digest("hex");
};

for (const bp of backupPaths) {
  const fp = path.join(root, bp);
  if (!fs.existsSync(fp)) {
    console.log("BACKUP_MISSING|" + bp);
    continue;
  }
  let arr;
  try {
    arr = EJSON.deserialize(JSON.parse(fs.readFileSync(fp, "utf8")));
  } catch (e) {
    console.log("BACKUP_PARSE_FAIL|" + bp + "|" + e.message);
    continue;
  }
  const bIds = arr.map((d) => String(d.problemId ?? d._id));
  const bSet = new Set(bIds);
  const bDup = new Set();
  const bSeen = new Set();
  for (const id of bIds) {
    if (bSeen.has(id)) bDup.add(id);
    bSeen.add(id);
  }
  const newSet = new Set(pIds);
  const missing = [...bSet].filter((id) => !newSet.has(id));
  const extra = [...newSet].filter((id) => !bSet.has(id));
  const newBy = new Map(pDocs.map((d) => [String(d.problemId ?? d._id), d]));
  let hashMatch = 0;
  let hashMismatch = 0;
  let checked = 0;
  for (const b of arr) {
    const id = String(b.problemId ?? b._id);
    const nd = newBy.get(id);
    if (!nd) continue;
    checked++;
    if (keyOf(b) === keyOf(nd)) hashMatch++;
    else hashMismatch++;
  }
  console.log("BACKUP|" + bp + "|total=" + arr.length + "|distinct=" + bSet.size + "|dup=" + bDup.size);
  console.log(
    "BACKUP_COMPARE|" + bp + "|missing=" + missing.length + "|extra=" + extra.length +
      "|hash_match=" + hashMatch + "|hash_mismatch=" + hashMismatch + "|hashed=" + checked
  );
  if (missing.length && missing.length <= 5) console.log("BACKUP_MISSING_IDS|" + JSON.stringify(missing));
}
await client.close();
console.log("DONE");
