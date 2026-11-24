import assert from "node:assert/strict";
import test from "node:test";
import { classifyDevDatabaseUrl } from "../../scripts/lib/devDatabaseUrl.mjs";

const ATLAS_DEV = "mongodb+srv://dev:pass@dev-cluster.mongodb.net/makemistakes_dev?retryWrites=true";
const LOCAL_DEV = "mongodb://127.0.0.1:27017/makemistakes_dev";

test("localhost development URL is accepted by default", () => {
  const info = classifyDevDatabaseUrl(LOCAL_DEV);
  assert.equal(info.devMode, true);
  assert.equal(info.localHost, true);
  assert.equal(info.dbName, "makemistakes_dev");
});

test("Atlas makemistakes_dev is accepted only with --allow-cloud-dev", () => {
  const noFlag = classifyDevDatabaseUrl(ATLAS_DEV);
  assert.equal(noFlag.devMode, false);
  assert.match(noFlag.reason, /flag-missing/);

  const withFlag = classifyDevDatabaseUrl(ATLAS_DEV, { allowCloud: true });
  assert.equal(withFlag.devMode, true);
  assert.equal(withFlag.cloud, true);
});

test("production database name is rejected even with the cloud flag", () => {
  const url = "mongodb+srv://app:pass@prod-cluster.mongodb.net/makemistakes?retryWrites=true";
  const info = classifyDevDatabaseUrl(url, { allowCloud: true });
  assert.equal(info.devMode, false);
  assert.match(info.reason, /non-dev-name/);
});

test("non-Atlas cloud URL is rejected even with the cloud flag", () => {
  const url = "mongodb+srv://dev:pass@db.example.com/makemistakes_dev";
  const info = classifyDevDatabaseUrl(url, { allowCloud: true });
  assert.equal(info.devMode, false);
  assert.equal(info.cloud, false);
  assert.match(info.reason, /unknown\/non-dev/);
});

test("invalid URL is rejected", () => {
  const info = classifyDevDatabaseUrl("not a url");
  assert.equal(info.devMode, false);
  assert.equal(info.reason, "invalid-url");
});

test("non-mongodb protocol is rejected", () => {
  const info = classifyDevDatabaseUrl("http://localhost/makemistakes_dev");
  assert.equal(info.devMode, false);
  assert.equal(info.reason, "invalid-protocol");
});
