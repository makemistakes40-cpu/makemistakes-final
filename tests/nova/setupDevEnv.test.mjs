import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/setup_dev_env.mjs");

function runWith({ databaseUrl, allowCloud = false, cwd }) {
  const args = [SCRIPT];
  if (allowCloud) args.push("--allow-cloud-dev");
  const res = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_ENV: "development", DEV_DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "setup-env-test-"));
}

test("localhost development URL is accepted", () => {
  const cwd = tempDir();
  const { status, stderr } = runWith({
    databaseUrl: "mongodb://127.0.0.1:27017/makemistakes_dev",
    cwd,
  });
  assert.equal(status, 0, stderr);
});

test("Atlas makemistakes_dev is accepted only with the explicit flag", () => {
  const url = "mongodb+srv://dev:pass@dev-cluster.mongodb.net/makemistakes_dev?retryWrites=true";

  const noFlag = runWith({ databaseUrl: url, cwd: tempDir() });
  assert.notEqual(noFlag.status, 0, "must reject Atlas without --allow-cloud-dev");
  assert.match(noFlag.stderr, /--allow-cloud-dev/i);

  const withFlag = runWith({ databaseUrl: url, allowCloud: true, cwd: tempDir() });
  assert.equal(withFlag.status, 0, withFlag.stderr);
});

test("production database name is rejected even with the cloud flag", () => {
  const { status, stderr } = runWith({
    databaseUrl: "mongodb+srv://app:pass@prod-cluster.mongodb.net/makemistakes?retryWrites=true",
    allowCloud: true,
    cwd: tempDir(),
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /makemistakes_dev/);
});

test("non-Atlas cloud URL is rejected", () => {
  const url = "mongodb+srv://dev:pass@db.example.com/makemistakes_dev";
  const { status, stderr } = runWith({ databaseUrl: url, allowCloud: true, cwd: tempDir() });
  assert.notEqual(status, 0);
  assert.match(stderr, /SRV hostname/i);
});
