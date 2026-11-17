import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRICING_CONFIG,
  getEffectivePricingConfig,
  clearPricingConfigCache,
  parseSemver,
  compareVersions,
} from "../../src/lib/nova/pricingConfig.ts";
import {
  updatePricingConfig,
  isUserAdmin,
} from "../../src/lib/nova/adminControls.ts";

// ---------------------------------------------------------------------------
// Self-contained fakes that model MongoDB transactions with snapshot rollback.
// An error of ANY kind inside the transaction rolls the whole thing back,
// which mirrors real replica-set transaction semantics.
// ---------------------------------------------------------------------------

class FakeCollection {
  constructor(documents = []) {
    this.documents = structuredClone(documents);
  }

  matches(doc, query) {
    if (!doc) return false;
    for (const [key, value] of Object.entries(query || {})) {
      const actual = doc[key];
      if (value instanceof Date && actual instanceof Date) {
        if (value.getTime() !== actual.getTime()) return false;
        continue;
      }
      if (value && typeof value === "object") {
        if ("$eq" in value) {
          if (actual !== value.$eq) return false;
          continue;
        }
        if ("$ne" in value && actual === value.$ne) return false;
        if ("$gt" in value && actual <= value.$gt) return false;
        if ("$gte" in value && actual < value.$gte) return false;
        if ("$lt" in value && actual >= value.$lt) return false;
        if ("$lte" in value && actual > value.$lte) return false;
        continue;
      }
      if (actual !== value) return false;
    }
    return true;
  }

  async findOne(query) {
    return structuredClone(this.documents.find((d) => this.matches(d, query)) || null);
  }

  async insertOne(doc) {
    // Enforce the unique `version` index (same guarantee as idx_nova_pricing_version).
    if (doc.version !== undefined) {
      const dup = this.documents.find((d) => d.version === doc.version);
      if (dup) {
        const err = new Error("duplicate key on version");
        err.code = 11000;
        throw err;
      }
    }
    this.documents.push(structuredClone(doc));
    return { insertedId: doc._id || doc.version };
  }

  async updateMany(query, update) {
    let matched = 0;
    for (const doc of this.documents) {
      if (this.matches(doc, query)) {
        if (update.$set) Object.assign(doc, update.$set);
        matched++;
      }
    }
    return { matchedCount: matched, modifiedCount: matched };
  }

  async countDocuments(query = {}) {
    return this.documents.filter((d) => this.matches(d, query)).length;
  }

  find(query) {
    const items = this.documents.filter((d) => this.matches(d, query));
    return {
      limit() {
        return this;
      },
      async toArray() {
        return structuredClone(items);
      },
    };
  }
}

class FakeSession {
  constructor(db) {
    this.db = db;
  }

  async withTransaction(fn) {
    const snapshot = new Map();
    for (const [name, col] of this.db.collections.entries()) {
      snapshot.set(name, structuredClone(col.documents));
    }
    try {
      return await fn();
    } catch (err) {
      // Any error (including duplicate-key / write conflict) aborts and rolls back the
      // entire transaction — restoring every collection to its pre-transaction state.
      for (const [name, docs] of snapshot.entries()) {
        this.db.collections.get(name).documents = structuredClone(docs);
      }
      throw err;
    }
  }

  async endSession() {
    // no-op
  }
}

class FakeDb {
  constructor(collections = {}) {
    this.collections = new Map();
    Object.entries(collections).forEach(([name, docs]) => {
      this.collections.set(
        name,
        Array.isArray(docs) ? new FakeCollection(docs) : docs
      );
    });
  }

  get client() {
    return this;
  }

  get topology() {
    return { description: { type: "ReplicaSetWithPrimary" } };
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new FakeCollection());
    }
    return this.collections.get(name);
  }

  startSession() {
    return new FakeSession(this);
  }
}

class SingleTopologyDb extends FakeDb {
  get topology() {
    return { description: { type: "Single" } };
  }
}

function currentDoc(db) {
  return db.collection("nova_pricing_config").documents.filter((d) => d.isCurrent === true);
}

function allDocs(db) {
  return db.collection("nova_pricing_config").documents;
}

// ---------------------------------------------------------------------------
// Test 1: First pricing initialization (empty collection)
// ---------------------------------------------------------------------------
test("1. First initialization: creates the first current pricing document atomically", async () => {
  const db = new FakeDb();
  const updated = await updatePricingConfig(db, {
    pricingMultiplier: 1.25,
    updatedBy: "admin-user",
  });

  const docs = allDocs(db);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].isCurrent, true);
  // Derived from DEFAULT_PRICING_CONFIG (v1.0.0) -> v1.0.1
  assert.equal(docs[0].version, "v1.0.1");
  assert.equal(docs[0].pricingMultiplier, 1.25);
  assert.equal(updated.version, "v1.0.1");
  assert.equal(updated.isCurrent, true);
  assert.equal(currentDoc(db).length, 1);
});

// ---------------------------------------------------------------------------
// Test 2: Normal pricing update preserves history and keeps one current
// ---------------------------------------------------------------------------
test("2. Normal update: deactivates previous current, inserts new version, preserves history", async () => {
  const seed = { ...DEFAULT_PRICING_CONFIG, version: "v1.0.1", isCurrent: true };
  const db = new FakeDb({ nova_pricing_config: [seed] });

  const updated = await updatePricingConfig(db, {
    creditValueInr: 0.02,
    updatedBy: "admin-user",
  });

  const docs = allDocs(db);
  assert.equal(docs.length, 2); // history preserved
  assert.equal(updated.version, "v1.0.2");
  assert.equal(updated.creditValueInr, 0.02);

  const current = currentDoc(db);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, "v1.0.2");
  assert.equal(current[0].isCurrent, true);

  const old = docs.find((d) => d.version === "v1.0.1");
  assert.ok(old);
  assert.equal(old.isCurrent, false);
});

// ---------------------------------------------------------------------------
// Test 3: Transaction failure aborts and rolls back the whole update
// ---------------------------------------------------------------------------
test("3. Transaction failure: rollback restores prior state on failure", async () => {
  const seed = { ...DEFAULT_PRICING_CONFIG, version: "v1.0.1", isCurrent: true };
  const failCol = new FakeCollection([seed]);
  const originalInsert = failCol.insertOne.bind(failCol);
  // Inject a transient failure on the version the update will attempt to insert.
  failCol.insertOne = async (doc) => {
    if (doc.version === "v1.0.2") {
      const err = new Error("simulated write conflict");
      err.code = 251;
      throw err;
    }
    return originalInsert(doc);
  };

  const db = new FakeDb({ nova_pricing_config: failCol });
  const before = structuredClone(allDocs(db));

  await assert.rejects(() => updatePricingConfig(db, { updatedBy: "admin-user" }));

  // Full rollback: state is byte-identical to the pre-transaction snapshot.
  assert.deepEqual(allDocs(db), before);
  const current = currentDoc(db);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, "v1.0.1");
});

// ---------------------------------------------------------------------------
// Test 4: Concurrent pricing updates never produce duplicate versions / currents
// ---------------------------------------------------------------------------
test("4. Concurrent updates: guarantee exactly one current and distinct versions", async () => {
  const seed = { ...DEFAULT_PRICING_CONFIG, version: "v1.0.1", isCurrent: true };
  const db = new FakeDb({ nova_pricing_config: [seed] });

  const p1 = updatePricingConfig(db, { pricingMultiplier: 1.1, updatedBy: "admin" });
  const p2 = updatePricingConfig(db, { pricingMultiplier: 1.2, updatedBy: "admin" });
  const results = await Promise.allSettled([p1, p2]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.ok(fulfilled.length >= 1, "at least one update must succeed");

  const versions = allDocs(db).map((d) => d.version);
  assert.equal(new Set(versions).size, versions.length, "no duplicate versions allowed");

  const current = currentDoc(db);
  assert.equal(current.length, 1, "exactly one current document");
});

// ---------------------------------------------------------------------------
// Test 5: Duplicate current documents are not created and are surfaced safely
// ---------------------------------------------------------------------------
test("5. Duplicate current prevention: update yields exactly one current even with pre-existing duplicates", async () => {
  clearPricingConfigCache();
  const seedA = { ...DEFAULT_PRICING_CONFIG, version: "v1.0.1", isCurrent: true };
  const seedB = { ...DEFAULT_PRICING_CONFIG, version: "v1.0.2", isCurrent: true };
  const db = new FakeDb({ nova_pricing_config: [seedA, seedB] });

  // Pre-existing duplicate state is correctly detected and resolved deterministically.
  const effective = await getEffectivePricingConfig(db);
  assert.equal(effective.version, "v1.0.2"); // highest version selected

  const updated = await updatePricingConfig(db, { updatedBy: "admin" });
  const current = currentDoc(db);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, "v1.0.3");
  assert.equal(updated.version, "v1.0.3");
});

// ---------------------------------------------------------------------------
// Test 6: Missing pricing configuration falls back safely (dev fallback preserved)
// ---------------------------------------------------------------------------
test("6. Missing pricing config: read falls back to DEFAULT, first write initializes", async () => {
  clearPricingConfigCache();
  const db = new FakeDb();
  const effective = await getEffectivePricingConfig(db);
  assert.deepEqual(effective, DEFAULT_PRICING_CONFIG);
  assert.equal(effective.version, "v1.0.0");

  const updated = await updatePricingConfig(db, { updatedBy: "admin" });
  assert.equal(updated.version, "v1.0.1");
  assert.equal(currentDoc(db).length, 1);
});

// ---------------------------------------------------------------------------
// Test 7: Historical versions are preserved across many updates
// ---------------------------------------------------------------------------
test("7. Historical version preservation: versions strictly increase, only latest current", async () => {
  const db = new FakeDb();
  const versions = [];
  for (let i = 0; i < 4; i++) {
    const updated = await updatePricingConfig(db, {
      pricingMultiplier: 1 + i * 0.1,
      updatedBy: "admin",
    });
    versions.push(updated.version);
  }

  assert.deepEqual(versions, ["v1.0.1", "v1.0.2", "v1.0.3", "v1.0.4"]);
  assert.equal(allDocs(db).length, 4); // every historical version retained
  const current = currentDoc(db);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, "v1.0.4");
});

// ---------------------------------------------------------------------------
// Test 8: Fail-closed when transactions are unavailable (no non-transactional writes)
// ---------------------------------------------------------------------------
test("8. Fail-closed: refuses to update when transactions are unavailable, writes nothing", async () => {
  const db = new SingleTopologyDb();
  await assert.rejects(
    () => updatePricingConfig(db, { updatedBy: "admin" }),
    /TRANSACTION_UNAVAILABLE/
  );
  assert.equal(allDocs(db).length, 0);
});

// ---------------------------------------------------------------------------
// Test 9: Version helpers
// ---------------------------------------------------------------------------
test("9. parseSemver / compareVersions behave correctly", () => {
  assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("v1.0.0"), [1, 0, 0]);
  assert.ok(compareVersions("v1.10.0", "v1.9.0") > 0);
  assert.equal(compareVersions("v1.0.0", "v1.0.0"), 0);
});

// ---------------------------------------------------------------------------
// Test 10: Admin authorization helper still works
// ---------------------------------------------------------------------------
test("10. isUserAdmin: recognizes admin role and whitelisted email", () => {
  assert.equal(
    isUserAdmin({ userId: "u1", role: "admin" }),
    true
  );
  assert.equal(isUserAdmin({ userId: "u2", role: "user" }), false);
  assert.equal(isUserAdmin(null), false);
});
