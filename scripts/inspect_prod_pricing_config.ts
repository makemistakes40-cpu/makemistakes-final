/**
 * TEMPORARY READ-ONLY production inspection of nova_pricing_config (Pricing Safety migration).
 *
 * SAFETY:
 *  - READ-ONLY: only db.listCollections(), collection.countDocuments(), collection.find(),
 *    and collection.indexes(). NO writes, NO index creation/drop, NO document mutation.
 *  - Never prints credentials; connection is redacted to host name.
 *
 * Usage:
 *   npx tsx scripts/inspect_prod_pricing_config.ts
 */

import path from "path";
import dotenv from "dotenv";

const envPath =
  typeof __dirname !== "undefined"
    ? path.join(__dirname, "..", ".env")
    : path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath });

import { getDb } from "../src/lib/mongodb";

async function main(): Promise<void> {
  const db = await getDb();
  const uri = process.env.DATABASE_URL || "";
  let host = "(unknown)";
  try {
    host = new URL(uri).hostname;
  } catch {
    /* keep default */
  }
  console.log(`Connected to MongoDB host: ${host}`);

  const COLL = "nova_pricing_config";

  // 1. Does the collection exist?
  const existingCollections = new Set<string>();
  for (const c of await db.listCollections().toArray()) {
    existingCollections.add(c.name);
  }
  const exists = existingCollections.has(COLL);
  console.log(`\nCollection "${COLL}" exists: ${exists}`);

  if (!exists) {
    console.log("\nCOLLECTION IS MISSING (treated as empty / no indexes).");
    // 5a. Still attempt to list indexes (returns empty for missing collection).
    try {
      const indexes = await db.collection(COLL).indexes();
      console.log(`Indexes on missing collection (len=${indexes.length}):`);
      for (const idx of indexes) {
        console.log(`  ${JSON.stringify(idx)}`);
      }
    } catch (e) {
      console.warn("  (could not list indexes on missing collection)");
    }
    return;
  }

  // 2. Total document count.
  const total = await db.collection(COLL).countDocuments();
  console.log(`\nTotal documents: ${total}`);

  // 3. Count where isCurrent === true.
  const current = await db.collection(COLL).countDocuments({ isCurrent: true });
  console.log(`Documents with isCurrent=true: ${current}`);

  // 4. All documents: version, isCurrent, updatedAt.
  console.log("\nAll documents (version | isCurrent | updatedAt):");
  const docs = await db
    .collection(COLL)
    .find({}, { projection: { version: 1, isCurrent: 1, updatedAt: 1, _id: 1 } })
    .toArray();
  for (const d of docs) {
    console.log(
      `  _id=${d._id} | version=${JSON.stringify(d.version)} | isCurrent=${JSON.stringify(
        d.isCurrent
      )} | updatedAt=${d.updatedAt}`
    );
  }

  // 5. Missing / duplicate version analysis.
  const versions = docs.map((d: any) => d.version);
  const missingVersion = versions.filter((v: any) => v === undefined || v === null).length;
  const seen = new Map<string, number>();
  for (const v of versions) {
    const key = typeof v === "string" ? v : JSON.stringify(v);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1);
  console.log(`\nDocs with missing version: ${missingVersion}`);
  console.log(`Duplicate version values: ${duplicates.length ? JSON.stringify(duplicates) : "none"}`);

  // 6. All existing indexes.
  console.log("\nExisting indexes on nova_pricing_config:");
  const indexes = await db.collection(COLL).indexes();
  for (const idx of indexes) {
    const key = JSON.stringify(idx.key);
    const unique = Boolean(idx.unique);
    const partial = idx.partialFilterExpression ? JSON.stringify(idx.partialFilterExpression) : "";
    const sparse = Boolean(idx.sparse);
    console.log(
      `  name=${idx.name} | key=${key} | unique=${unique} | partial=${partial || "-"} | sparse=${sparse}`
    );
  }

  console.log("\nREAD-ONLY inspection complete. No writes or index changes were performed.");
}

main().catch((err) => {
  console.error("Fatal error during inspection:", err?.message || err);
  process.exit(1);
});
