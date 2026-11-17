/**
 * TEMPORARY READ-ONLY production index inspection script (Phase 3).
 *
 * Compares the required Nova indexes (JUSTIFIED_INDEXES in src/lib/dbIndexes.ts)
 * against the actual indexes present on the configured production MongoDB database.
 *
 * SAFETY:
 *  - READ-ONLY: performs only db.listCollections() and collection.indexes().
 *  - It NEVER creates, modifies, or drops indexes.
 *  - It NEVER writes to the database.
 *  - It NEVER prints credentials; all connection strings are redacted to a host name.
 *
 * Usage (pick one):
 *   npx tsx scripts/inspect_prod_indexes.ts
 *   node --experimental-loader ./tests/nova/routeTestLoader.mjs scripts/inspect_prod_indexes.ts
 */

import dotenv from "dotenv";
import path from "path";

const envPath =
  typeof __dirname !== "undefined"
    ? path.join(__dirname, "..", ".env")
    : path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath });

import { getDb } from "../src/lib/mongodb";
import { JUSTIFIED_INDEXES, matchesKeySpecAndOrder } from "../src/lib/dbIndexes";
import type { IndexDescription } from "mongodb";

interface CompareResult {
  collection: string;
  requiredName: string;
  requiredSpec: string;
  requiredUnique: boolean;
  status: "EXISTS" | "MISSING" | "SAME_NAME_CONFLICT" | "EQUIVALENT_DIFFERENT_NAME";
  actualName?: string;
  actualKey?: string;
  actualUnique?: boolean;
  actualSparse?: boolean;
  actualPartial?: string;
  detail: string;
}

function fmtKey(key: unknown): string {
  if (!key) return "(none)";
  return JSON.stringify(key);
}

function fmtPartial(idx: IndexDescription): string {
  const p = (idx as unknown as Record<string, unknown>).partialFilterExpression;
  return p ? JSON.stringify(p) : "";
}

function fmtSparse(idx: IndexDescription): boolean {
  return Boolean((idx as unknown as Record<string, unknown>).sparse);
}

async function main(): Promise<void> {
  // 0. Establish connection (host only; never the full URI).
  const db = await getDb();
  const uri = process.env.DATABASE_URL || "";
  let host = "(unknown)";
  try {
    host = new URL(uri).hostname;
  } catch {
    /* keep default */
  }
  console.log(`Connected to MongoDB host: ${host}`);

  // 1. Resolve the set of collections that carry required indexes.
  const requiredCollections = [...new Set(JUSTIFIED_INDEXES.map((d) => d.collection))];

  // 2. List collections that actually exist (read-only).
  const existingCollections = new Set<string>();
  for (const c of await db.listCollections().toArray()) {
    existingCollections.add(c.name);
  }

  console.log(`\nRequired collections: ${requiredCollections.length}`);
  console.log(`Collections present in DB: ${existingCollections.size}`);

  // 3. Compare each required index against the live indexes.
  const results: CompareResult[] = [];

  for (const def of JUSTIFIED_INDEXES) {
    if (!existingCollections.has(def.collection)) {
      results.push({
        collection: def.collection,
        requiredName: def.options.name,
        requiredSpec: fmtKey(def.spec),
        requiredUnique: Boolean(def.options.unique),
        status: "MISSING",
        detail: `Collection "${def.collection}" does not exist in the database.`,
      });
      continue;
    }

    const liveIndexes: IndexDescription[] = await db.collection(def.collection).indexes();

    // a) Same-name match?
    const byName = liveIndexes.find((idx) => idx.name === def.options.name);
    if (byName) {
      const keyOk = matchesKeySpecAndOrder(byName.key as Record<string, unknown>, def.spec);
      const uniqueOk = Boolean(byName.unique) === Boolean(def.options.unique);
      const partialOk =
        JSON.stringify(
          (byName as unknown as Record<string, unknown>).partialFilterExpression ?? undefined
        ) === JSON.stringify(def.options.partialFilterExpression ?? undefined);
      if (keyOk && uniqueOk && partialOk) {
        results.push({
          collection: def.collection,
          requiredName: def.options.name,
          requiredSpec: fmtKey(def.spec),
          requiredUnique: Boolean(def.options.unique),
          status: "EXISTS",
          actualName: byName.name,
          actualKey: fmtKey(byName.key),
          actualUnique: Boolean(byName.unique),
          actualSparse: fmtSparse(byName),
          actualPartial: fmtPartial(byName),
          detail: "Exact match on name, key order, and unique option.",
        });
      } else {
        results.push({
          collection: def.collection,
          requiredName: def.options.name,
          requiredSpec: fmtKey(def.spec),
          requiredUnique: Boolean(def.options.unique),
          status: "SAME_NAME_CONFLICT",
          actualName: byName.name,
          actualKey: fmtKey(byName.key),
          actualUnique: Boolean(byName.unique),
          actualSparse: fmtSparse(byName),
          actualPartial: fmtPartial(byName),
          detail: `Index exists with name "${def.options.name}" but keys/unique differ.`,
        });
      }
      continue;
    }

    // b) Equivalent keys under a different name?
    const byKey = liveIndexes.find((idx) =>
      matchesKeySpecAndOrder(idx.key as Record<string, unknown>, def.spec)
    );
    if (byKey) {
      const uniqueOk = Boolean(byKey.unique) === Boolean(def.options.unique);
      const partialOk =
        JSON.stringify(
          (byKey as unknown as Record<string, unknown>).partialFilterExpression ?? undefined
        ) === JSON.stringify(def.options.partialFilterExpression ?? undefined);
      const exactOptions = uniqueOk && partialOk;
      results.push({
        collection: def.collection,
        requiredName: def.options.name,
        requiredSpec: fmtKey(def.spec),
        requiredUnique: Boolean(def.options.unique),
        status: exactOptions ? "EQUIVALENT_DIFFERENT_NAME" : "SAME_NAME_CONFLICT",
        actualName: byKey.name,
        actualKey: fmtKey(byKey.key),
        actualUnique: Boolean(byKey.unique),
        actualSparse: fmtSparse(byKey),
        actualPartial: fmtPartial(byKey),
        detail: exactOptions
          ? `Equivalent keys exist under name "${byKey.name}".`
          : `Equivalent keys exist under name "${byKey.name}" but unique/partial options differ.`,
      });
      continue;
    }

    // c) Missing.
    results.push({
      collection: def.collection,
      requiredName: def.options.name,
      requiredSpec: fmtKey(def.spec),
      requiredUnique: Boolean(def.options.unique),
      status: "MISSING",
      detail: "No index with matching name or key spec found.",
    });
  }

  // 4. Report.
  const count = (s: CompareResult["status"]) => results.filter((r) => r.status === s).length;

  console.log("\n=== REQUIRED INDEX COMPARISON ===");
  console.log(
    "COLLECTION | REQUIRED NAME | REQUIRED SPEC | UNIQ | STATUS | ACTUAL NAME | ACTUAL SPEC | ACTUAL UNIQ | ACTUAL SPARSE | ACTUAL PARTIAL | DETAIL"
  );
  for (const r of results) {
    console.log(
      [
        r.collection,
        r.requiredName,
        r.requiredSpec,
        r.requiredUnique ? "Y" : "N",
        r.status,
        r.actualName ?? "-",
        r.actualKey ?? "-",
        r.actualUnique === undefined ? "-" : r.actualUnique ? "Y" : "N",
        r.actualSparse ? "Y" : "N",
        r.actualPartial || "-",
        r.detail,
      ].join(" | ")
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Required indexes inspected  : ${JUSTIFIED_INDEXES.length}`);
  console.log(`Already-existing (exact)    : ${count("EXISTS")}`);
  console.log(`Missing                     : ${count("MISSING")}`);
  console.log(`Same-name conflicts          : ${count("SAME_NAME_CONFLICT")}`);
  console.log(`Equivalent, different name   : ${count("EQUIVALENT_DIFFERENT_NAME")}`);

  // 5. Unexpected indexes (present in DB but not required).
  console.log("\n=== UNEXPECTED INDEXES (present in DB, not required) ===");
  let unexpectedTotal = 0;
  for (const col of requiredCollections) {
    if (!existingCollections.has(col)) continue;
    const liveIndexes: IndexDescription[] = await db.collection(col).indexes();
    const requiredForCol = JUSTIFIED_INDEXES.filter((d) => d.collection === col);
    for (const idx of liveIndexes) {
      if (idx.name === "_id_") continue; // default index, always expected
      const isRequired = requiredForCol.some((d) => {
        const nameMatch = d.options.name === idx.name;
        const keyMatch = matchesKeySpecAndOrder(idx.key as Record<string, unknown>, d.spec);
        return nameMatch || keyMatch;
      });
      if (!isRequired) {
        unexpectedTotal++;
        console.log(
          `  ${col}.${idx.name} | key=${fmtKey(idx.key)} | unique=${Boolean(idx.unique)} | sparse=${fmtSparse(idx)}`
        );
      }
    }
  }
  if (unexpectedTotal === 0) {
    console.log("  (none)");
  }

  console.log("\nREAD-ONLY inspection complete. No indexes were created, modified, or dropped.");

  const blockCreate = count("SAME_NAME_CONFLICT") > 0 || count("MISSING") === 0;
  if (blockCreate) {
    console.log("ADVISORY: resolve same-name conflicts / confirm before running ensure_indexes.ts.");
  }
}

main().catch((err) => {
  console.error("Fatal error during index inspection:", err?.message || err);
  process.exit(1);
});
