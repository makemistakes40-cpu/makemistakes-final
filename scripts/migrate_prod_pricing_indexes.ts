/**
 * TEMPORARY, NARROWLY SCOPED production migration for nova_pricing_config indexes (Pricing Safety).
 *
 * Scope (ONLY these operations, ONLY on nova_pricing_config):
 *   1. Drop the obsolete NON-UNIQUE index idx_nova_pricing_isCurrent (key {isCurrent:1}, no partial).
 *   2. Create UNIQUE partial index idx_nova_pricing_isCurrent on {isCurrent:1}
 *      with partialFilterExpression {isCurrent:{$eq:true}}.
 *   3. Create UNIQUE index idx_nova_pricing_version on {version:1}.
 *   4. Verify both indexes after creation.
 *
 * SAFETY:
 *  - NEVER deletes pricing documents. NEVER inserts/updates/seeds documents.
 *  - NEVER touches any other collection or index.
 *  - Fail-closed: if any step errors, stop immediately and report the exact error (no partial continuation).
 *  - Does NOT run ensure_indexes.ts.
 *
 * Usage:
 *   npx tsx scripts/migrate_prod_pricing_indexes.ts
 */

import path from "path";
import dotenv from "dotenv";

const envPath =
  typeof __dirname !== "undefined"
    ? path.join(__dirname, "..", ".env")
    : path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath });

import { getDb } from "../src/lib/mongodb";

const COLL = "nova_pricing_config";

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

  // Preflight: confirm the collection exists and is empty (safety invariant from the inspection).
  const total = await db.collection(COLL).countDocuments();
  console.log(`\nPreflight: "${COLL}" total documents = ${total}`);
  if (total !== 0) {
    console.error(`❌ ABORT: expected empty collection for migration (got ${total} docs). No changes made.`);
    process.exit(1);
  }

  // Preflight: confirm only the obsolete non-unique index exists (plus _id_).
  const before = await db.collection(COLL).indexes();
  const theNonUnique = before.find(
    (idx: any) => idx.name === "idx_nova_pricing_isCurrent" && !idx.unique && !idx.partialFilterExpression
  );
  if (!theNonUnique) {
    console.error('❌ ABORT: expected obsolete non-unique index "idx_nova_pricing_isCurrent" to exist. No changes made.');
    process.exit(1);
  }

  // 1. Drop the obsolete non-unique index.
  console.log('\n[1] Dropping obsolete non-unique index "idx_nova_pricing_isCurrent"...');
  await db.collection(COLL).dropIndex("idx_nova_pricing_isCurrent");
  console.log("  ✓ dropped");

  // Verify it is gone.
  const afterDrop = await db.collection(COLL).indexes();
  if (afterDrop.some((idx: any) => idx.name === "idx_nova_pricing_isCurrent")) {
    console.error('❌ ABORT: obsolete index still present after drop.');
    process.exit(1);
  }

  // 2. Create unique partial index.
  console.log("\n[2] Creating unique partial index idx_nova_pricing_isCurrent...");
  await db.collection(COLL).createIndex(
    { isCurrent: 1 },
    {
      name: "idx_nova_pricing_isCurrent",
      unique: true,
      background: true,
      partialFilterExpression: { isCurrent: { $eq: true } },
    }
  );
  console.log("  ✓ created");

  // 3. Create unique version index.
  console.log("\n[3] Creating unique index idx_nova_pricing_version...");
  await db.collection(COLL).createIndex(
    { version: 1 },
    { name: "idx_nova_pricing_version", unique: true, background: true }
  );
  console.log("  ✓ created");

  // 4. Verify both indexes.
  console.log("\n[4] Verifying indexes...");
  const after = await db.collection(COLL).indexes();

  const curIdx = after.find((idx: any) => idx.name === "idx_nova_pricing_isCurrent");
  const verIdx = after.find((idx: any) => idx.name === "idx_nova_pricing_version");

  const curOk =
    curIdx &&
    curIdx.unique === true &&
    JSON.stringify(curIdx.key) === JSON.stringify({ isCurrent: 1 }) &&
    JSON.stringify(curIdx.partialFilterExpression) === JSON.stringify({ isCurrent: { $eq: true } });

  const verOk =
    verIdx && verIdx.unique === true && JSON.stringify(verIdx.key) === JSON.stringify({ version: 1 });

  if (!curOk) {
    console.error("❌ VERIFICATION FAILED: unique partial current-version index is wrong:");
    console.error(JSON.stringify(curIdx, null, 2));
    process.exit(1);
  }
  if (!verOk) {
    console.error("❌ VERIFICATION FAILED: unique version index is wrong:");
    console.error(JSON.stringify(verIdx, null, 2));
    process.exit(1);
  }

  console.log("\nFinal index state on nova_pricing_config:");
  for (const idx of after) {
    console.log(
      `  name=${idx.name} | key=${JSON.stringify(idx.key)} | unique=${Boolean(
        idx.unique
      )} | partial=${idx.partialFilterExpression ? JSON.stringify(idx.partialFilterExpression) : "-"}`
    );
  }

  console.log("\n✅ MIGRATION COMPLETE: obsolete non-unique index dropped; unique partial current index and unique version index created and verified.");
}

main().catch((err) => {
  console.error("\n❌ MIGRATION FAILED (no further steps were attempted):", err?.message || err);
  process.exit(1);
});
