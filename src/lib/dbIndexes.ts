import type { Db, Document, IndexDescription } from "mongodb";
import { getDb } from "./mongodb";

export interface IndexDefinition {
  collection: string;
  spec: Record<string, 1 | -1 | "text">;
  options: {
    name: string;
    unique?: boolean;
    background?: boolean;
    sparse?: boolean;
    partialFilterExpression?: Record<string, unknown>;
  };
  reason: string;
}

/**
 * Authoritative list of justified MongoDB indexes for MakeMistakes.
 *
 * Each index directly maps to frequent application queries identified in Task 4:
 * 1. user_profiles: Fast 1:1 lookup & upsert by authenticated userId in settings/profile.
 * 2. user_preferences: Fast 1:1 lookup & upsert by authenticated userId in settings/preferences.
 * 3. build_workspaces: Fast lookup & upsert by userId + problemId in BuildOS workspace service.
 * 4. problems: Eliminates in-memory SORT stage for newest/oldest catalog pagination in /api/products.
 * 5. user_journeys: Full ESR index for active in-progress journey query with compound sort in /api/journey/active.
 * 6. user_journeys: Unique journey document constraint per user and problem.
 * 7. problem_completions: Preserves unique completion constraint across user + problem pairs.
 */
export const JUSTIFIED_INDEXES: IndexDefinition[] = [
  {
    collection: "user_profiles",
    spec: { userId: 1 },
    options: { name: "idx_user_profiles_userId", unique: true, background: true },
    reason: "1:1 user profile lookup and upsert by authenticated userId in settings/profile and export-data.",
  },
  {
    collection: "user_preferences",
    spec: { userId: 1 },
    options: { name: "idx_user_preferences_userId", unique: true, background: true },
    reason: "1:1 user preferences lookup and upsert by authenticated userId in settings/preferences.",
  },
  {
    collection: "build_workspaces",
    spec: { userId: 1, problemId: 1 },
    options: { name: "idx_build_workspaces_userId_problemId", unique: true, background: true },
    reason: "Exact equality lookup and upsert for isolated BuildOS workspaces per user and problem.",
  },
  {
    collection: "build_workspace_files",
    spec: { userId: 1, problemId: 1, path: 1 },
    options: { name: "idx_build_workspace_files_userId_problemId_path", unique: true, background: true },
    reason: "Authoritative durable student file store; exact equality lookup by owned workspace and path. The unique compound key also keeps soft-delete tombstones occupied so a stale client cannot resurrect a deleted file (T6.1).",
  },
  {
    collection: "build_workspace_quotas",
    spec: { userId: 1, problemId: 1 },
    options: { name: "idx_build_workspace_quotas_userId_problemId", unique: true, background: true },
    reason: "1:1 per-workspace quota document; the single-document mutex for atomic quota enforcement (T6.1).",
  },
  {
    collection: "buildos_activity",
    spec: { userId: 1, problemId: 1, at: -1 },
    options: { name: "idx_buildos_activity_user_problem_at", background: true },
    reason: "Loads recent implementation and execution events for one authenticated student's project.",
  },
  {
    collection: "nova_conversation_messages",
    spec: { userId: 1, problemId: 1, conversationId: 1, sequence: -1 },
    options: { name: "idx_nova_messages_project_conversation_created", background: true },
    reason: "Loads bounded recent Nova messages within the authenticated student's project conversation.",
  },
  {
    collection: "problems",
    spec: { createdAt: -1, problemId: 1 },
    options: { name: "idx_createdAt_desc_problemId_asc", background: true },
    reason: "Supports newest/oldest deterministic pagination sorts in /api/products without in-memory SORT.",
  },
  {
    collection: "user_journeys",
    spec: { userId: 1, status: 1, updatedAt: -1, lastActivityAt: -1 },
    options: { name: "idx_userId_status_updatedAt_lastActivityAt", background: true },
    reason: "Full ESR index for active in-progress journey query with compound sort in /api/journey/active on dashboard load.",
  },
  {
    collection: "user_journeys",
    spec: { userId: 1, problemId: 1 },
    options: { name: "userId_1_problemId_1", unique: true, background: true },
    reason: "Unique journey document constraint per user and problem.",
  },
  {
    collection: "problem_completions",
    spec: { userId: 1, problemId: 1 },
    options: { name: "userId_1_problemId_1", unique: true, background: true },
    reason: "Unique completion document constraint per user and problem.",
  },
  {
    collection: "nova_user_wallets",
    spec: { userId: 1 },
    options: { name: "idx_nova_wallets_userId", unique: true, background: true },
    reason: "Fast 1:1 user wallet lookup and atomic rolling 24-hour balance reconciliation.",
  },
  {
    collection: "nova_credit_reservations",
    spec: { reservationId: 1 },
    options: { name: "idx_nova_reservations_id", unique: true, background: true },
    reason: "Idempotent reservation lookup and settlement by reservation ID.",
  },
  {
    collection: "nova_credit_reservations",
    spec: { userId: 1, status: 1 },
    options: { name: "idx_nova_reservations_userId_status", background: true },
    reason: "Fast lookup of in-flight active reservations per student.",
  },
  {
    collection: "nova_ai_usage_events",
    spec: { userId: 1, timestamp: -1 },
    options: { name: "idx_nova_usage_userId_timestamp", background: true },
    reason: "High-performance time-series aggregation of AI expenditure and token usage per student.",
  },
  {
    collection: "nova_pricing_config",
    spec: { isCurrent: 1 },
    options: {
      name: "idx_nova_pricing_isCurrent",
      unique: true,
      background: true,
      partialFilterExpression: { isCurrent: { $eq: true } },
    },
    reason: "Enforces exactly ONE current pricing document (preserving full versioned history) and enables instant resolution of the active pricing rules.",
  },
  {
    collection: "nova_pricing_config",
    spec: { version: 1 },
    options: { name: "idx_nova_pricing_version", unique: true, background: true },
    reason: "Guarantees each pricing version is created at most once, preventing concurrent updates from producing duplicate versions.",
  },
];

export interface EnsureIndexesResult {
  collection: string;
  name: string;
  status: "created" | "already_exists" | "skipped_duplicate_keys" | "error";
  details?: string;
}

/**
 * Checks whether an index matches the target key specification in both field names, values, and order.
 */
export function matchesKeySpecAndOrder(
  actualKey: Record<string, any> | undefined,
  targetSpec: Record<string, 1 | -1 | "text">
): boolean {
  if (!actualKey) return false;
  const rawKey = actualKey as Record<string, any>;
  const actEntries = Object.entries(rawKey);
  const expEntries = Object.entries(targetSpec);

  if (actEntries.length !== expEntries.length) return false;

  for (let i = 0; i < expEntries.length; i++) {
    const [expK, expV] = expEntries[i];
    const [actK, actV] = actEntries[i];
    if (expK !== actK || expV !== actV) {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether an index with the given name already exists.
 */
function findIndexByName(existingIndexes: IndexDescription[], name: string): IndexDescription | undefined {
  return existingIndexes.find((idx) => idx.name === name);
}

/**
 * Ensures all justified indexes exist on the target database.
 * - Idempotent: safe to run multiple times without re-creating existing indexes.
 * - Non-destructive: never drops or alters existing indexes.
 * - Non-blocking: background: true where applicable.
 * - Pre-validates uniqueness: checks for existing duplicate keys before creating unique indexes.
 */
export async function ensureAppIndexes(targetDb?: Db): Promise<EnsureIndexesResult[]> {
  const db = targetDb || (await getDb());
  const results: EnsureIndexesResult[] = [];

  for (const def of JUSTIFIED_INDEXES) {
    const collection = db.collection(def.collection);
    try {
      let existingIndexes: IndexDescription[] = [];
      try {
        existingIndexes = await collection.indexes();
      } catch (indexErr: any) {
        if (
          indexErr?.code === 26 ||
          indexErr?.codeName === "NamespaceNotFound" ||
          (typeof indexErr?.message === "string" &&
            (indexErr.message.includes("ns does not exist") ||
              indexErr.message.includes("NamespaceNotFound")))
        ) {
          existingIndexes = [];
        } else {
          throw indexErr;
        }
      }

      // Check if an index with identical name exists
      const existingByName = findIndexByName(existingIndexes, def.options.name);
      if (existingByName) {
        const keysMatch = matchesKeySpecAndOrder(
          existingByName.key as Record<string, any>,
          def.spec
        );
        const uniqueMatch = !!existingByName.unique === !!def.options.unique;
        const partialMatch =
          JSON.stringify(existingByName.partialFilterExpression ?? undefined) ===
          JSON.stringify(def.options.partialFilterExpression ?? undefined);

        if (keysMatch && uniqueMatch && partialMatch) {
          results.push({
            collection: def.collection,
            name: def.options.name,
            status: "already_exists",
            details: "Index with identical name, key specification, unique, and partial-filter options already exists.",
          });
          continue;
        } else {
          results.push({
            collection: def.collection,
            name: def.options.name,
            status: "error",
            details: `Index exists with name "${def.options.name}" but has conflicting keys (${JSON.stringify(
              existingByName.key
            )}) or options (unique=${!!existingByName.unique}, partial=${JSON.stringify(
              existingByName.partialFilterExpression ?? undefined
            )}).`,
          });
          continue;
        }
      }

      // Check if an index with identical key specification already exists under another name
      const matchingKeyEntry = existingIndexes.find((idx) =>
        matchesKeySpecAndOrder(idx.key, def.spec)
      );
      if (matchingKeyEntry) {
        const uniqueMatch = !!matchingKeyEntry.unique === !!def.options.unique;
        const partialMatch =
          JSON.stringify(matchingKeyEntry.partialFilterExpression ?? undefined) ===
          JSON.stringify(def.options.partialFilterExpression ?? undefined);
        if (uniqueMatch && partialMatch) {
          results.push({
            collection: def.collection,
            name: def.options.name,
            status: "skipped_duplicate_keys",
            details: "Equivalent index keys already exist under a different name.",
          });
          continue;
        }
        results.push({
          collection: def.collection,
          name: def.options.name,
          status: "error",
          details: `Index exists with equivalent keys but conflicting options (unique=${!!matchingKeyEntry.unique}, partial=${JSON.stringify(
            matchingKeyEntry.partialFilterExpression ?? undefined
          )}). Resolve before applying required index ${def.options.name}.`,
        });
        continue;
      }

      // Pre-check for duplicate keys if index is unique
      if (def.options.unique) {
        const keyFields = Object.keys(def.spec);
        const groupId =
          keyFields.length === 1
            ? `$${keyFields[0]}`
            : Object.fromEntries(keyFields.map((k) => [k, `$${k}`]));

        const duplicateCheckPipeline: Document[] = [];
        if (def.options.partialFilterExpression) {
          duplicateCheckPipeline.push({ $match: def.options.partialFilterExpression });
        }
        duplicateCheckPipeline.push(
          { $group: { _id: groupId, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 1 }
        );

        let duplicates: any[] = [];
        try {
          duplicates = await collection.aggregate(duplicateCheckPipeline).toArray();
        } catch (aggErr: any) {
          if (
            aggErr?.code === 26 ||
            aggErr?.codeName === "NamespaceNotFound" ||
            (typeof aggErr?.message === "string" && aggErr.message.includes("ns does not exist"))
          ) {
            duplicates = [];
          } else {
            throw aggErr;
          }
        }

        if (duplicates.length > 0) {
          results.push({
            collection: def.collection,
            name: def.options.name,
            status: "error",
            details: `Duplicate keys detected prior to creation for spec ${JSON.stringify(def.spec)}: ${JSON.stringify(
              duplicates[0]
            )}`,
          });
          continue;
        }
      }

      // Create index safely
      await collection.createIndex(def.spec as any, def.options as any);
      results.push({
        collection: def.collection,
        name: def.options.name,
        status: "created",
        details: def.reason,
      });
    } catch (err: any) {
      results.push({
        collection: def.collection,
        name: def.options.name,
        status: "error",
        details: err?.message || String(err),
      });
    }
  }

  return results;
}
