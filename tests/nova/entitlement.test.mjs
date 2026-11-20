import assert from "node:assert/strict";
import test from "node:test";
import { resolveProblemAccess } from "../../src/lib/problemAccess.ts";

// --- fixtures -------------------------------------------------------------

function makeDb(journeyDocs = []) {
  return {
    collection(name) {
      assert.equal(name, "user_journeys");
      return {
        find(query, _projection) {
          const userIds = query?.userId?.$in ?? [];
          const docs = journeyDocs.filter((d) => userIds.includes(d.userId));
          return {
            sort(spec) {
              // Apply the same order the production query uses: createdAt ASC,
              // then _id ASC, then first document wins.
              const order = Object.keys(spec);
              const sorted = [...docs].sort((a, b) => {
                for (const key of order) {
                  const av = a[key];
                  const bv = b[key];
                  if (av === bv) continue;
                  if (av === undefined) return 1;
                  if (bv === undefined) return -1;
                  return av < bv ? -1 : 1;
                }
                return 0;
              });
              return {
                limit() {
                  return { next: async () => sorted[0] ?? null };
                },
              };
            },
          };
        },
      };
    },
  };
}

function setPrismaMock(handlers) {
  globalThis.__novaPrismaMock = handlers;
}

test("new student without journeys is entitled to P000001", async () => {
  setPrismaMock({
    subscription: { findUnique: async () => null },
    user: {
      findUnique: async () => null, // no persisted entitlement
      updateMany: async () => ({ count: 1 }),
    },
  });
  const db = makeDb([]);
  const { freeAccessible, isPaid } = await resolveProblemAccess({
    db,
    userIds: ["user-1"],
    sessionUserId: "user-1",
  });
  assert.equal(isPaid, false);
  assert.deepEqual([...freeAccessible], ["P000001"]);
});

test("legacy student with earliest P000005 journey is entitled to P000005", async () => {
  setPrismaMock({
    subscription: { findUnique: async () => null },
    user: {
      findUnique: async () => null,
      updateMany: async () => ({ count: 1 }),
    },
  });
  const db = makeDb([{ userId: "u1", problemId: "P000005" }]);
  const { freeAccessible } = await resolveProblemAccess({
    db,
    userIds: ["u1"],
    sessionUserId: "u1",
  });
  assert.deepEqual([...freeAccessible], ["P000005"]);
});

test("multiple journeys resolve to the earliest by createdAt, then _id", async () => {
  setPrismaMock({
    subscription: { findUnique: async () => null },
    user: {
      findUnique: async () => null,
      updateMany: async () => ({ count: 1 }),
    },
  });
  // Query sorts by createdAt ASC, _id ASC and takes first; fixture applies the
  // same ordering so the earliest (P000002) wins.
  const db = makeDb([
    { userId: "u1", problemId: "P000005", createdAt: new Date("2025-01-02") },
    { userId: "u1", problemId: "P000002", createdAt: new Date("2025-01-01") },
  ]);
  const { freeAccessible } = await resolveProblemAccess({
    db,
    userIds: ["u1"],
    sessionUserId: "u1",
  });
  assert.deepEqual([...freeAccessible], ["P000002"]);
});

test("concurrent requests: loser re-reads the winner's persisted entitlement", async () => {
  let persisted = null;
  let updateCalls = 0;
  setPrismaMock({
    subscription: { findUnique: async () => null },
    user: {
      findUnique: async () => ({ entitledProblemId: persisted }),
      updateMany: async () => {
        updateCalls += 1;
        if (updateCalls === 1) {
          persisted = "P000005"; // first writer wins
          return { count: 1 };
        }
        return { count: 0 }; // subsequent writers lose the race
      },
    },
  });
  const db = makeDb([{ userId: "u1", problemId: "P000005" }]);
  const results = await Promise.all([
    resolveProblemAccess({ db, userIds: ["u1"], sessionUserId: "u1" }),
    resolveProblemAccess({ db, userIds: ["u1"], sessionUserId: "u1" }),
    resolveProblemAccess({ db, userIds: ["u1"], sessionUserId: "u1" }),
  ]);
  for (const r of results) {
    assert.deepEqual([...r.freeAccessible], ["P000005"]);
  }
  assert.equal(persisted, "P000005");
});

test("existing entitlement is never overwritten", async () => {
  let persisted = "P000007";
  let updateCalls = 0;
  setPrismaMock({
    subscription: { findUnique: async () => null },
    user: {
      findUnique: async () => ({ entitledProblemId: persisted }),
      updateMany: async () => {
        updateCalls += 1;
        return { count: 0 };
      },
    },
  });
  const db = makeDb([{ userId: "u1", problemId: "P000005" }]);
  const { freeAccessible } = await resolveProblemAccess({
    db,
    userIds: ["u1"],
    sessionUserId: "u1",
  });
  assert.deepEqual([...freeAccessible], ["P000007"]);
  assert.equal(updateCalls, 0); // never attempted to overwrite
});

test("paid student ignores free-tier single-problem entitlement", async () => {
  setPrismaMock({
    subscription: {
      findUnique: async () => ({
        plan: "PRO",
        status: "ACTIVE",
        expiryDate: null,
      }),
    },
  });
  const db = makeDb([{ userId: "u1", problemId: "P000005" }]);
  const { freeAccessible, isPaid } = await resolveProblemAccess({
    db,
    userIds: ["u1"],
    sessionUserId: "u1",
  });
  assert.equal(isPaid, true);
  assert.equal(freeAccessible.size, 0);
});
