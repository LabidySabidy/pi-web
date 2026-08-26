import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { readProjectStateFromDir } = await jiti.import("./route.ts");
const routeSrc = await readFile(new URL("./route.ts", import.meta.url), "utf8");

// ============================================================================
// Behavior: the read + status-mapping core (no auth, no project resolution)
// ============================================================================

test("readProjectStateFromDir maps present/absent/error per file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-web-project-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "PLAN.md"), "# Plan\n### Phase 1 — Core (50% complete)\n");
  await writeFile(path.join(dir, "TASKS.md"), "## Phase 1 — Core\n- [ ] T-001 — blocked on dep\n");
  await writeFile(path.join(dir, "VISION.md"), "x".repeat(300 * 1024)); // oversize -> error

  const { input, sources } = readProjectStateFromDir(dir);

  assert.equal(sources.plan, "present");
  assert.equal(sources.tasks, "present");
  assert.equal(sources.vision, "error");
  assert.equal(sources.decisions, "absent");
  assert.equal(sources.progress, "absent");

  assert.ok(input.plan);
  assert.ok(input.tasks);
  assert.equal(input.decisions, null);
  assert.equal(input.vision, null); // oversize file is not read into memory
});

test("readProjectStateFromDir returns all-absent for an empty directory", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-web-project-state-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { input, sources } = readProjectStateFromDir(dir);

  assert.deepEqual(sources, {
    plan: "absent",
    tasks: "absent",
    progress: "absent",
    decisions: "absent",
    vision: "absent",
  });
  assert.deepEqual(input, {
    plan: null,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
});

// ============================================================================
// Static: the route's security contract
// ============================================================================

test("route authorizes cwd + projectRoot and never self-allows", () => {
  assert.match(routeSrc, /getAllowedFileRoots\(\)/);
  assert.match(routeSrc, /isFilePathAllowed\(cwd, allowedRoots\)/);
  assert.match(routeSrc, /isExistingFilePathAllowed\(projectRoot, allowedRoots\)/);
  assert.match(routeSrc, /resolveProject\(cwd\)/);
  // Security: it must NOT call allowFileRoot — reading requires an existing root.
  assert.doesNotMatch(routeSrc, /allowFileRoot\(/);
});

test("route validates absolute cwd and streams no-store", () => {
  assert.match(routeSrc, /cwd must be an absolute path/);
  assert.match(routeSrc, /Access denied/);
  assert.match(routeSrc, /Cache-Control["']?\s*:\s*["']no-store["']/);
});
