import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWorkspaceFile,
  createWorkspaceFolder,
  deleteWorkspaceFile,
  listWorkspaceTree,
  readWorkspaceTextFile,
  renameWorkspaceFile,
  writeWorkspaceTextFile,
} from "../../src/lib/buildos/files.ts";
import { resolveWorkspaceFile } from "../../src/lib/buildos/workspacePath.ts";
import { validateWorkspaceDependencies } from "../../src/lib/buildos/validator.ts";
import { buildBuildOsPreviewHtml } from "../../src/lib/buildos/previewRuntime.ts";

function createTestWorkspace() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "buildos-ops-test-"));
  // Scaffold minimal valid workspace
  fs.mkdirSync(path.join(tmpRoot, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ name: "test-workspace", dependencies: { react: "^18.3.1" } }, null, 2)
  );
  fs.writeFileSync(
    path.join(tmpRoot, "app", "page.tsx"),
    'export default function Page() { return <h1>BuildOS Test</h1>; }'
  );
  fs.writeFileSync(
    path.join(tmpRoot, "app", "layout.tsx"),
    'export default function RootLayout({ children }: { children: any }) { return <html><body>{children}</body></html>; }'
  );
  return tmpRoot;
}

test("BuildOS: creates, reads, and updates workspace files correctly", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. Create file
  createWorkspaceFile(root, "components/Header.tsx", "export function Header() { return <header>Header</header>; }");
  assert.equal(fs.existsSync(path.join(root, "components", "Header.tsx")), true);

  // 2. Read file
  const readContent = readWorkspaceTextFile(root, "components/Header.tsx");
  assert.equal(readContent, "export function Header() { return <header>Header</header>; }");

  // 3. Update file
  writeWorkspaceTextFile(root, "components/Header.tsx", "export function Header() { return <header>Updated</header>; }");
  const updatedContent = readWorkspaceTextFile(root, "components/Header.tsx");
  assert.equal(updatedContent, "export function Header() { return <header>Updated</header>; }");
});

test("BuildOS Critical Regression: create -> add code -> save -> reopen preserves exact content", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const testPath = "components/UserProfileCard.tsx";
  const expectedCode = `import React from "react";

export function UserProfileCard({ name }: { name: string }) {
  return (
    <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
      <h2 className="text-white text-lg font-bold">{name}</h2>
      <p className="text-zinc-400 text-sm">Active BuildOS Learner</p>
    </div>
  );
}`;

  // 1. Create file with blank starter
  createWorkspaceFile(root, testPath, "// initial blank");

  // 2. Add full code & save
  writeWorkspaceTextFile(root, testPath, expectedCode);

  // 3. Reopen & verify exact match
  const loadedContent = readWorkspaceTextFile(root, testPath);
  assert.equal(loadedContent, expectedCode);
});

test("BuildOS: renames files safely and prevents renaming protected core files", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  createWorkspaceFile(root, "components/OldName.tsx", "export const v = 1;");

  // Normal rename
  renameWorkspaceFile(root, "components/OldName.tsx", "components/NewName.tsx");
  assert.equal(fs.existsSync(path.join(root, "components", "OldName.tsx")), false);
  assert.equal(fs.existsSync(path.join(root, "components", "NewName.tsx")), true);
  assert.equal(readWorkspaceTextFile(root, "components/NewName.tsx"), "export const v = 1;");

  // Cannot rename protected core files
  assert.throws(
    () => renameWorkspaceFile(root, "package.json", "package-old.json"),
    /This core file cannot be renamed/
  );
  assert.throws(
    () => renameWorkspaceFile(root, "app/page.tsx", "app/old-page.tsx"),
    /This core file cannot be renamed/
  );
  assert.throws(
    () => renameWorkspaceFile(root, "app/layout.tsx", "app/old-layout.tsx"),
    /This core file cannot be renamed/
  );

  // Cannot overwrite existing file
  createWorkspaceFile(root, "components/Target.tsx", "export const t = 2;");
  assert.throws(
    () => renameWorkspaceFile(root, "components/NewName.tsx", "components/Target.tsx"),
    /A file with the target name already exists/
  );
});

test("BuildOS: creates workspace folders safely and blocks path traversal", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Safe folder creation
  createWorkspaceFolder(root, "components/ui");
  assert.equal(fs.existsSync(path.join(root, "components", "ui")), true);

  // Path traversal attempts throw
  assert.throws(
    () => createWorkspaceFolder(root, "../outside-folder"),
    /Path traversal is not allowed/
  );
  assert.throws(
    () => createWorkspaceFolder(root, "components/../../escaped"),
    /Path traversal is not allowed/
  );

  // Forbidden folder names throw
  assert.throws(
    () => createWorkspaceFolder(root, "node_modules/hack"),
    /Folder name not allowed/
  );
  assert.throws(
    () => createWorkspaceFolder(root, ".next/cache"),
    /Folder name not allowed/
  );
});

test("BuildOS: deletes files safely and protects core entrypoints", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  createWorkspaceFile(root, "components/Temp.tsx", "export const t = 1;");
  assert.equal(fs.existsSync(path.join(root, "components", "Temp.tsx")), true);

  deleteWorkspaceFile(root, "components/Temp.tsx");
  assert.equal(fs.existsSync(path.join(root, "components", "Temp.tsx")), false);

  // Protected core files cannot be deleted
  assert.throws(
    () => deleteWorkspaceFile(root, "package.json"),
    /This core file cannot be deleted/
  );
  assert.throws(
    () => deleteWorkspaceFile(root, "app/page.tsx"),
    /This core file cannot be deleted/
  );
  assert.throws(
    () => deleteWorkspaceFile(root, "app/layout.tsx"),
    /This core file cannot be deleted/
  );
});

test("BuildOS: enforces 2MB maximum file size limit", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hugeContent = "A".repeat(2.5 * 1024 * 1024);
  assert.throws(
    () => writeWorkspaceTextFile(root, "components/Huge.tsx", hugeContent),
    /exceeds maximum allowed size/
  );
});

test("BuildOS: listWorkspaceTree filters internal directories and sorts entries", (t) => {
  const root = createTestWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Add dummy node_modules and .next directories
  fs.mkdirSync(path.join(root, "node_modules", "some-pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "some-pkg", "index.js"), "// node module");
  fs.mkdirSync(path.join(root, ".next", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, ".next", "cache", "data.json"), "{}");

  createWorkspaceFile(root, "components/Navbar.tsx", "export function Navbar() {}");

  const tree = listWorkspaceTree(root);
  const flattened = [];
  function walk(nodes) {
    for (const n of nodes) {
      flattened.push(n.path);
      if (n.type === "dir") walk(n.children);
    }
  }
  walk(tree);

  assert.equal(flattened.includes("app/page.tsx"), true);
  assert.equal(flattened.includes("components/Navbar.tsx"), true);
  assert.equal(flattened.some((p) => p.startsWith("node_modules")), false);
  assert.equal(flattened.some((p) => p.startsWith(".next")), false);
});

test("BuildOS Validator: validates dependency graph and detects missing imports / casing issues", () => {
  // 1. Valid workspace
  const validFiles = {
    "app/page.tsx": `import { Navbar } from "./Navbar";
export default function Page() { return <Navbar />; }`,
    "app/Navbar.tsx": `export function Navbar() { return <nav>Nav</nav>; }`,
  };
  const validResult = validateWorkspaceDependencies(validFiles, "Beginner");
  assert.equal(validResult.valid, true);
  assert.equal(validResult.errors.length, 0);

  // 2. Missing entrypoint
  const noEntrypointResult = validateWorkspaceDependencies({
    "components/Card.tsx": "export function Card() {}",
  }, "Beginner");
  assert.equal(noEntrypointResult.valid, false);
  assert.equal(noEntrypointResult.errors[0].type, "MISSING_ENTRYPOINT");

  // 3. Missing local file
  const missingImportResult = validateWorkspaceDependencies({
    "app/page.tsx": `import { Sidebar } from "./Sidebar";
export default function Page() { return <Sidebar />; }`,
  }, "Beginner");
  assert.equal(missingImportResult.valid, false);
  assert.equal(missingImportResult.errors[0].type, "MISSING_LOCAL_FILE");

  // 4. Path casing mismatch
  const casingResult = validateWorkspaceDependencies({
    "app/page.tsx": `import { hero } from "./hero";
export default function Page() { return <hero />; }`,
    "app/Hero.tsx": `export function hero() { return <div />; }`,
  }, "Beginner");
  assert.equal(casingResult.valid, false);
  assert.equal(casingResult.errors.some((e) => e.type === "PATH_CASING_MISMATCH"), true);

  // 5. Unapproved package
  const unapprovedResult = validateWorkspaceDependencies({
    "app/page.tsx": `import axios from "axios";
export default function Page() { return <div />; }`,
  }, "Beginner");
  assert.equal(unapprovedResult.valid, false);
  assert.equal(unapprovedResult.errors.some((e) => e.type === "MISSING_PACKAGE"), true);
});

test("BuildOS Preview Runtime: builds sandboxed HTML payload with error boundary and postMessage bridge", () => {
  const files = {
    "app/page.tsx": `export default function Page() { return <h1>Hello Preview</h1>; }`,
    "app/globals.css": "body { background: #000; }",
  };
  const html = buildBuildOsPreviewHtml(files, { problemId: "P000001", runId: 12345 });

  assert.equal(typeof html, "string");
  assert.equal(html.includes("react@18.3.1"), true);
  assert.equal(html.includes("@babel/standalone"), true);
  assert.equal(html.includes("makemistakes-buildos-preview"), true);
  assert.equal(html.includes("PreviewErrorBoundary"), true);
  assert.equal(html.includes("runId:12345"), true);
});

test("BuildOS Preview Runtime: handles arrow function and variable page exports", () => {
  // Arrow function with default export
  const arrowDefaultFiles = {
    "app/page.tsx": `const Page = () => { return <div>Arrow Page</div>; }; export default Page;`,
  };
  const html1 = buildBuildOsPreviewHtml(arrowDefaultFiles, { problemId: "P000001", runId: 101 });
  assert.equal(html1.includes('window.__BUILDOS_PAGE_APP__ = (typeof Page !== \\"undefined\\" ? Page : window.Page)'), true);

  // Arrow function with named export
  const arrowConstFiles = {
    "app/page.tsx": `export const Page = () => <div>Exported Const</div>;`,
  };
  const html2 = buildBuildOsPreviewHtml(arrowConstFiles, { problemId: "P000001", runId: 102 });
  assert.equal(html2.includes("window.__BUILDOS_PAGE_APP__ = Page"), true);

  // Fallback checks include Page and App
  assert.equal(html1.includes('typeof Page !== \\"undefined\\"'), true);
  assert.equal(html1.includes('typeof App !== \\"undefined\\"'), true);
});

