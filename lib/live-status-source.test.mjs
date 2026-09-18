import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { buildStatusSnapshot, collectSubagents } = await jiti.import("./live-status-source.ts");

function session(overrides = {}) {
  return {
    isStreaming: false,
    pendingMessageCount: 0,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// collectSubagents
// ---------------------------------------------------------------------------

test("collectSubagents keeps only children of the given parent", () => {
  const sessions = [
    { id: "child-1", relation: { kind: "subagent", parentSessionId: "parent", profile: "worker", description: "doing a thing", status: "running" } },
    { id: "child-2", relation: { kind: "subagent", parentSessionId: "other-parent", profile: "worker", description: "not mine", status: "running" } },
    { id: "unrelated" },
  ];
  const runs = collectSubagents(sessions, "parent");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].description, "doing a thing");
});

test("collectSubagents falls back to the top-level parentSessionId", () => {
  const sessions = [
    { id: "child", parentSessionId: "parent", relation: { kind: "subagent", profile: "worker" } },
  ];
  assert.equal(collectSubagents(sessions, "parent").length, 1);
});

test("collectSubagents ignores non-subagent relations", () => {
  const sessions = [{ id: "fork", relation: { kind: "fork", parentSessionId: "parent" } }];
  assert.deepEqual(collectSubagents(sessions, "parent"), []);
});

test("collectSubagents normalises an unknown status to running", () => {
  const sessions = [
    { id: "child", relation: { kind: "subagent", parentSessionId: "parent", status: "weird-status" } },
  ];
  assert.equal(collectSubagents(sessions, "parent")[0].status, "running");
});

test("collectSubagents handles a missing status", () => {
  const sessions = [{ id: "child", relation: { kind: "subagent", parentSessionId: "parent" } }];
  assert.equal(collectSubagents(sessions, "parent")[0].status, "running");
});

// ---------------------------------------------------------------------------
// buildStatusSnapshot
// ---------------------------------------------------------------------------

test("an idle session produces an idle snapshot", () => {
  const snap = buildStatusSnapshot({ session: session(), sessionId: "s1" });
  assert.equal(snap.isStreaming, false);
  assert.equal(snap.isPromptRunning, false);
  assert.deepEqual(snap.subagents, []);
  assert.equal(snap.turnElapsedMs, undefined);
});

test("a streaming session reports elapsed time from the turn start", () => {
  const snap = buildStatusSnapshot({
    session: session({ isStreaming: true }),
    sessionId: "s1",
    turnStartedAtMs: 1_000,
    now: 9_000,
  });
  assert.equal(snap.isStreaming, true);
  assert.equal(snap.turnElapsedMs, 8_000);
});

test("no elapsed time when the turn start is unknown", () => {
  const snap = buildStatusSnapshot({ session: session({ isStreaming: true }), sessionId: "s1", now: 9_000 });
  assert.equal(snap.turnElapsedMs, undefined);
});

test("a future turn start never yields a negative elapsed", () => {
  const snap = buildStatusSnapshot({
    session: session({ isStreaming: true }),
    sessionId: "s1",
    turnStartedAtMs: 20_000,
    now: 9_000,
  });
  assert.equal(snap.turnElapsedMs, 0);
});

test("a pending prompt counts as work in flight", () => {
  // Work was accepted but has not settled; reporting "nothing's running"
  // here would contradict what the user just did.
  const snap = buildStatusSnapshot({
    session: session({ isStreaming: false, pendingMessageCount: 1 }),
    sessionId: "s1",
  });
  assert.equal(snap.isPromptRunning, true);
});

test("queued message counts are read from the session", () => {
  const snap = buildStatusSnapshot({
    session: session({ getSteeringMessages: () => ["a", "b"], getFollowUpMessages: () => ["c"] }),
    sessionId: "s1",
  });
  assert.equal(snap.steeringCount, 2);
  assert.equal(snap.followUpCount, 1);
});

test("bash and compaction flags are carried through", () => {
  const snap = buildStatusSnapshot({
    session: session({ isBashRunning: true, isCompacting: true }),
    sessionId: "s1",
  });
  assert.equal(snap.isBashRunning, true);
  assert.equal(snap.isCompacting, true);
});

test("context percent is carried when available", () => {
  const snap = buildStatusSnapshot({
    session: session({ getContextUsage: () => ({ percent: 82 }) }),
    sessionId: "s1",
  });
  assert.equal(snap.contextPercent, 82);
});

test("a null context percent is omitted rather than reported as zero", () => {
  // After compaction the percentage is genuinely unknown; reporting 0 would
  // read as "plenty of room" and suppress the warning.
  const snap = buildStatusSnapshot({
    session: session({ getContextUsage: () => ({ percent: null }) }),
    sessionId: "s1",
  });
  assert.equal(snap.contextPercent, undefined);
});

test("subagents belonging to the session are included", () => {
  const snap = buildStatusSnapshot({
    session: session(),
    sessionId: "parent",
    sessions: [
      { id: "c1", relation: { kind: "subagent", parentSessionId: "parent", profile: "worker", description: "the migration", status: "running" } },
    ],
  });
  assert.equal(snap.subagents?.length, 1);
  assert.equal(snap.subagents?.[0].description, "the migration");
});

test("last assistant text is included only when non-empty", () => {
  assert.equal(buildStatusSnapshot({ session: session(), sessionId: "s", lastAssistantText: "  " }).lastAssistantText, undefined);
  assert.equal(buildStatusSnapshot({ session: session(), sessionId: "s", lastAssistantText: "hi" }).lastAssistantText, "hi");
});

// ---------------------------------------------------------------------------
// robustness -- a status reply must survive a hostile runtime
// ---------------------------------------------------------------------------

test("a throwing accessor does not break the snapshot", () => {
  const snap = buildStatusSnapshot({
    session: session({
      getSteeringMessages: () => { throw new Error("boom"); },
      getContextUsage: () => { throw new Error("boom"); },
    }),
    sessionId: "s1",
  });
  assert.equal(snap.steeringCount, 0);
  assert.equal(snap.contextPercent, undefined);
  assert.equal(snap.isStreaming, false);
});

test("missing accessors are tolerated", () => {
  const snap = buildStatusSnapshot({
    session: { isStreaming: false },
    sessionId: "s1",
  });
  assert.equal(snap.steeringCount, 0);
  assert.equal(snap.followUpCount, 0);
  assert.deepEqual(snap.subagents, []);
});

test("a non-array accessor result degrades to zero rather than throwing", () => {
  const snap = buildStatusSnapshot({
    // A misbehaving runtime could return undefined where an array is expected.
    session: session({ getSteeringMessages: () => undefined }),
    sessionId: "s1",
  });
  assert.equal(snap.steeringCount, 0);
});
