import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "journey-active-test-secret-0123456789";
process.env.DATABASE_URL = "mongodb://journey-active-test.invalid/test";

const [{ GET }, { signSessionToken }, { DEFAULT_PROBLEM_ID }] = await Promise.all([
  import("../../src/app/api/journey/active/route.ts"),
  import("../../src/lib/authSession.ts"),
  import("../../src/lib/problemId.ts"),
]);

/**
 * Minimal faithful fake collection. Mirrors the MongoDB native driver's rule
 * that a top-level operator (e.g. `{ $in: [...] }`) is invalid: if a query key
 * starts with "$", it throws the exact production error we are guarding
 * against (`unknown top level operator: $in`). This reproduces the bug when the
 * filter is malformed, and accepts the corrected `{ userId: { $in: [...] } }`
 * form.
 */
class StrictCollection {
  constructor(documents = []) {
    this.documents = documents;
  }

  matches(document, query) {
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith("$")) {
        throw new Error(`unknown top level operator: ${key}`);
      }
      const actual = document[key];
      if (value && typeof value === "object") {
        if ("$in" in value) {
          const list = Array.isArray(actual) ? actual : [actual];
          if (!list.some((item) => value.$in.includes(item))) return false;
          continue;
        }
      }
      if (Array.isArray(actual)) {
        if (!actual.includes(value)) return false;
        continue;
      }
      if (actual !== value) return false;
    }
    return true;
  }

  find(query) {
    let docs = this.documents.filter((d) => this.matches(d, query));
    const cursor = {
      sort(spec) {
        for (const [key, direction] of Object.entries(spec)) {
          docs = [...docs].sort((a, b) => ((a[key] ?? 0) < (b[key] ?? 0) ? -1 : 1) * direction);
        }
        return cursor;
      },
      async toArray() {
        return structuredClone(docs);
      },
    };
    return cursor;
  }
}

class StrictDb {
  constructor() {
    this.collections = new Map();
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new StrictCollection());
    return this.collections.get(name);
  }
}

function installDb(docsByCollection) {
  const db = new StrictDb();
  for (const [name, docs] of Object.entries(docsByCollection || {})) {
    db.collection(name).documents = docs;
  }
  globalThis.__novaChatRouteTestDb = db;
  return db;
}

function authRequest(userId) {
  const token = signSessionToken({ userId, email: userId });
  return new Request("http://localhost/api/journey/active", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function problem(problemId, title) {
  return { problemId, title, category: "Product Challenge", learning: { level: 2 }, difficulty: 2 };
}

test.after(() => {
  delete globalThis.__novaChatRouteTestDb;
});

test("active journey route returns the user's in-progress journey (ownership-scoped $in)", async () => {
  const userId = `journey-active-${crypto.randomUUID()}@example.test`;
  installDb({
    problems: [problem(DEFAULT_PROBLEM_ID, "Canonical Challenge"), problem("P000100", "Building a Checkout")],
    user_journeys: [{
      userId,
      problemId: "P000100",
      status: "in_progress",
      currentPhase: 2,
      updatedAt: new Date("2026-11-26T10:00:00Z"),
      lastActivityAt: new Date("2026-11-26T09:00:00Z"),
    }],
  });

  const res = await GET(authRequest(userId));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.empty, false);
  assert.equal(body.problemId, "P000100");
  assert.equal(body.isUnfinished, true);
  assert.equal(body.status, "in_progress");
});

test("user with no unfinished journey falls back to canonical single problem", async () => {
  const userId = `journey-empty-${crypto.randomUUID()}@example.test`;
  installDb({
    problems: [problem(DEFAULT_PROBLEM_ID, "Canonical Challenge")],
    user_journeys: [],
    problem_completions: [],
  });

  const res = await GET(authRequest(userId));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.empty, false);
  assert.equal(body.problemId, DEFAULT_PROBLEM_ID);
  assert.equal(body.isUnfinished, false);
  assert.equal(body.status, "not_started");
});

test("completed journey is skipped in favour of an unfinished one", async () => {
  const userId = `journey-completed-${crypto.randomUUID()}@example.test`;
  installDb({
    problems: [
      problem(DEFAULT_PROBLEM_ID, "Canonical Challenge"),
      problem("P000200", "Deploy an API"),
      problem("P000300", "Build a Dashboard"),
    ],
    problem_completions: [{ userId, problemId: "P000200" }],
    user_journeys: [
      { userId, problemId: "P000200", status: "completed", updatedAt: new Date("2026-11-26T08:00:00Z") },
      { userId, problemId: "P000300", status: "in_progress", currentPhase: 3, updatedAt: new Date("2026-11-26T09:00:00Z") },
    ],
  });

  const res = await GET(authRequest(userId));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.problemId, "P000300");
  assert.equal(body.isUnfinished, true);
});

test("unauthenticated request is rejected with 401", async () => {
  installDb({ problems: [] });
  const res = await GET(new Request("http://localhost/api/journey/active"));
  assert.equal(res.status, 401);
});
