"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectState } from "@/lib/project-state";

export interface ProjectStateResponse extends ProjectState {
  projectRoot?: string;
}

export type ProjectStateResult =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; state: ProjectStateResponse }
  | { status: "error"; message: string };

/**
 * Fetch the project-at-a-glance state for a session's cwd. Re-fetches whenever
 * the cwd changes; no polling. `refreshKey` is an optional monotonic counter
 * callers can bump to force a re-fetch (e.g. after a run settles).
 */
export function useProjectState(
  cwd: string | null | undefined,
  refreshKey = 0,
): ProjectStateResult {
  const [result, setResult] = useState<ProjectStateResult>({ status: "idle" });
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!cwd) {
      setResult({ status: "idle" });
      return;
    }

    const id = ++requestIdRef.current;
    const controller = new AbortController();
    setResult({ status: "loading" });

    const url = `/api/project/state?cwd=${encodeURIComponent(cwd)}`;
    void fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          return { status: "error", message: `HTTP ${res.status}` } as const;
        }
        const state = (await res.json()) as ProjectStateResponse;
        return { status: "loaded", state } as const;
      })
      .then((next) => {
        if (id !== requestIdRef.current) return;
        setResult(next);
      })
      .catch((error) => {
        if (id !== requestIdRef.current || controller.signal.aborted) return;
        setResult({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => controller.abort();
  }, [cwd, refreshKey]);

  return result;
}
