import fs from "fs";
import { scanWorkspaceTreeBounded } from "./boundedWorkspaceTree";
import path from "path";
import {
  ensureDir,
  isEditableRelativePath,
  resolveWorkspaceFile,
  resolveTemplateDir,
} from "./paths";
import type { BuildLevel } from "./levels";

const SKIP_COPY = new Set(["node_modules", ".next", ".git"]);
const SKIP_TREE = new Set(["node_modules", ".next", ".git", ".buildos-meta.json"]);

export function assertTemplateExists(level: BuildLevel = "Beginner") {
  const dir = resolveTemplateDir(level);
  const pkg = path.join(dir, "package.json");
  if (!fs.existsSync(pkg)) {
    throw new Error(`${level} template package.json missing`);
  }
}

/** Recursively copy level template into a fresh workspace (no node_modules). */
export function copyTemplateToWorkspace(destRoot: string, level: BuildLevel = "Beginner") {
  assertTemplateExists(level);
  ensureDir(destRoot);
  copyDir(resolveTemplateDir(level), destRoot);
}

function copyDir(src: string, dest: string) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

export type WorkspaceFileNode =
  | { type: "file"; name: string; path: string }
  | { type: "dir"; name: string; path: string; children: WorkspaceFileNode[] };

export type WorkspaceTreeLimits = {
  maxDepth: number;
  maxFiles: number;
  maxEntries: number;
};

export type BoundedWorkspaceTree = {
  tree: WorkspaceFileNode[];
  fileCount: number;
  truncated: boolean;
};

export function listWorkspaceTree(root: string): WorkspaceFileNode[] {
  return readDirNodes(root, "");
}

export function listWorkspaceTreeBounded(
  root: string,
  limits: WorkspaceTreeLimits
): BoundedWorkspaceTree {
  const result = scanWorkspaceTreeBounded(root, limits, isEditableRelativePath, SKIP_TREE);
  return {
    tree: result.tree,
    fileCount: result.fileCount,
    truncated: result.truncated,
  };
}

function readDirNodes(absDir: string, rel: string): WorkspaceFileNode[] {
  if (!fs.existsSync(absDir)) return [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const nodes: WorkspaceFileNode[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_TREE.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        type: "dir",
        name: entry.name,
        path: childRel,
        children: readDirNodes(childAbs, childRel),
      });
    } else if (entry.isFile() && isEditableRelativePath(childRel)) {
      nodes.push({ type: "file", name: entry.name, path: childRel });
    }
  }
  return nodes;
}

export function readWorkspaceTextFile(
  root: string,
  relativePath: string,
  maxBytes?: number
): string {
  if (!isEditableRelativePath(relativePath)) {
    throw new Error("File type not allowed");
  }
  const abs = resolveWorkspaceFile(root, relativePath);
  if (!fs.existsSync(abs)) throw new Error("File not found");
  if (maxBytes !== undefined) {
    const byteLimit = Math.max(0, Math.min(Math.floor(maxBytes), 1_000_000));
    const descriptor = fs.openSync(abs, "r");
    try {
      const buffer = Buffer.alloc(byteLimit);
      const bytesRead = fs.readSync(descriptor, buffer, 0, byteLimit, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return fs.readFileSync(abs, "utf8");
}

export function writeWorkspaceTextFile(
  root: string,
  relativePath: string,
  content: string,
  level: BuildLevel = "Beginner"
) {
  if (!isEditableRelativePath(relativePath)) {
    throw new Error("File type not allowed");
  }
  const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
  if (content.length > MAX_FILE_SIZE_BYTES) {
    throw new Error("File content exceeds maximum allowed size (2MB)");
  }
  const abs = resolveWorkspaceFile(root, relativePath);
  ensureDir(path.dirname(abs));
  let finalContent = content;
  if (relativePath.replace(/\\/g, "/") === "package.json") {
    finalContent = lockApprovedPackageJson(content, level);
  }
  fs.writeFileSync(abs, finalContent, "utf8");
}

export function createWorkspaceFile(
  root: string,
  relativePath: string,
  content = "",
  level: BuildLevel = "Beginner"
) {
  writeWorkspaceTextFile(root, relativePath, content, level);
}

export function createWorkspaceFolder(root: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Invalid folder path");
  }
  if (normalized.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error("Path traversal is not allowed");
  }
  if (
    normalized.startsWith("node_modules") ||
    normalized.startsWith(".next") ||
    normalized.startsWith(".git")
  ) {
    throw new Error("Folder name not allowed");
  }
  const abs = resolveWorkspaceFile(root, normalized);
  ensureDir(abs);
}

export function renameWorkspaceFile(
  root: string,
  oldRelativePath: string,
  newRelativePath: string
) {
  if (!isEditableRelativePath(oldRelativePath) || !isEditableRelativePath(newRelativePath)) {
    throw new Error("File type not allowed");
  }
  const protectedFiles = new Set(["package.json", "app/page.tsx", "app/layout.tsx"]);
  if (protectedFiles.has(oldRelativePath.replace(/\\/g, "/"))) {
    throw new Error("This core file cannot be renamed");
  }
  if (protectedFiles.has(newRelativePath.replace(/\\/g, "/"))) {
    throw new Error("Cannot rename to a protected core file name");
  }
  const oldAbs = resolveWorkspaceFile(root, oldRelativePath);
  const newAbs = resolveWorkspaceFile(root, newRelativePath);

  if (!fs.existsSync(oldAbs)) {
    throw new Error("File not found");
  }
  if (fs.existsSync(newAbs)) {
    throw new Error("A file with the target name already exists");
  }

  ensureDir(path.dirname(newAbs));
  fs.renameSync(oldAbs, newAbs);
}

export function deleteWorkspaceFile(root: string, relativePath: string) {
  if (!isEditableRelativePath(relativePath)) {
    throw new Error("File type not allowed");
  }
  const protectedFiles = new Set(["package.json", "app/page.tsx", "app/layout.tsx"]);
  if (protectedFiles.has(relativePath.replace(/\\/g, "/"))) {
    throw new Error("This core file cannot be deleted");
  }
  const abs = resolveWorkspaceFile(root, relativePath);
  if (!fs.existsSync(abs)) throw new Error("File not found");
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
}

export function readAllEditableFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (nodes: WorkspaceFileNode[]) => {
    for (const n of nodes) {
      if (n.type === "file") {
        out[n.path] = readWorkspaceTextFile(root, n.path);
      } else {
        walk(n.children);
      }
    }
  };
  walk(listWorkspaceTree(root));
  return out;
}

/** Students cannot change the approved dependency set for their level. */
export function lockApprovedPackageJson(
  incoming: string,
  level: BuildLevel = "Beginner"
): string {
  const templatePkg = JSON.parse(
    fs.readFileSync(path.join(resolveTemplateDir(level), "package.json"), "utf8")
  );
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(incoming);
  } catch {
    return JSON.stringify(templatePkg, null, 2) + "\n";
  }
  return (
    JSON.stringify(
      {
        ...parsed,
        name: typeof parsed.name === "string" ? parsed.name : templatePkg.name,
        private: true,
        scripts: templatePkg.scripts,
        dependencies: templatePkg.dependencies,
        devDependencies: templatePkg.devDependencies,
      },
      null,
      2
    ) + "\n"
  );
}
