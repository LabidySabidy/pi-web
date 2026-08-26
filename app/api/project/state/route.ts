import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import {
  buildProjectState,
  type MemorySource,
  type ProjectState,
  type ProjectStateInput,
  type SourceStatus,
} from "@/lib/project-state";
import { resolveProject } from "@/lib/worktree";

const MAX_MEMORY_FILE_BYTES = 256 * 1024; // matches /api/files text preview bound

const MEMORY_FILES: Array<{ source: MemorySource; fileName: string }> = [
  { source: "plan", fileName: "PLAN.md" },
  { source: "tasks", fileName: "TASKS.md" },
  { source: "progress", fileName: "PROGRESS.md" },
  { source: "decisions", fileName: "DECISIONS.md" },
  { source: "vision", fileName: "VISION.md" },
];

/**
 * Read the five harness memory files from a project root and map each to
 * `present` / `absent` / `error`. Pure filesystem + status mapping — no auth,
 * no project resolution — so it is unit-testable in isolation.
 */
export function readProjectStateFromDir(
  projectRoot: string,
  options: { maxBytes?: number } = {},
): { input: ProjectStateInput; sources: Record<MemorySource, SourceStatus> } {
  const maxBytes = options.maxBytes ?? MAX_MEMORY_FILE_BYTES;
  const input: ProjectStateInput = {
    plan: null,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  };
  const sources: Record<MemorySource, SourceStatus> = {
    plan: "absent",
    tasks: "absent",
    progress: "absent",
    decisions: "absent",
    vision: "absent",
  };

  for (const { source, fileName } of MEMORY_FILES) {
    const filePath = path.join(projectRoot, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      sources[source] = "absent";
      continue;
    }
    if (!stat.isFile() || stat.size > maxBytes) {
      sources[source] = "error";
      continue;
    }
    try {
      input[source] = fs.readFileSync(filePath, "utf8");
      sources[source] = "present";
    } catch {
      sources[source] = "error";
    }
  }

  return { input, sources };
}

export const dynamic = "force-dynamic";

// GET /api/project/state?cwd=<absolute path> - project-at-a-glance state.
//
// The cwd must already be an allowed root (a session cwd or resolved project
// root) — this route deliberately does NOT call allowFileRoot, so it can never
// be used to browse arbitrary directories.
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Resolve the project root (collapses linked worktrees to the main repo)
    // and confirm it exists and is authorized before reading.
    const project = await resolveProject(cwd);
    const projectRoot = project.projectRoot;
    if (!isExistingFilePathAllowed(projectRoot, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { input, sources } = readProjectStateFromDir(projectRoot);
    const state = buildProjectState(input);

    const result: ProjectState & { projectRoot: string } = {
      ...state,
      sources,
      projectRoot,
    };

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
