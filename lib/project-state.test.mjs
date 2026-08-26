import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectState,
  formatProjectStateLine,
  parseDecisions,
  parsePlan,
  parseProgress,
  parseTasks,
  parseVision,
} from "./project-state.ts";

// ============================================================================
// Fixtures (faithful to the real EasyOBD / harness formats observed on disk)
// ============================================================================

const TASKS_FIXTURE = `# Tasks — Example

## Phase 1 — Core (remaining)

### Connection & Setup
- [x] T-001 — scaffold module
- [ ] T-002 — connection profiles
  Done when: profiles editable per-vehicle

## Phase 2 — The Moat

### GPS + Map
- [ ] T-003 — GPS map panel
- [ ] T-004 — bookmark markers — blocked on OSMDroid dependency

## Phase 3 — Ownership

- [ ] T-005 — service history
- [x] T-006 — maintenance entity
`;

const TASKS_CRLF = TASKS_FIXTURE.replace(/\n/g, "\r\n");

const PLAN_FIXTURE = `# Plan — Example

## Current state
Phase 1 ~80% complete.

### Phase 1 — Core (80% complete)
- connection profiles

### Phase 2 — Moat (40% complete)
- GPS map

### Phase 3 — Ownership (0% complete)
- service history

## Open questions
- Redis or Postgres for sessions?
- Migration rollback plan?

## Next actions
1. finish Phase 1
`;

const PLAN_NO_OPEN = `# Plan — Example

### Phase 1 — Core (100% complete)
- done

## Open questions

## Next actions
1. ship
`;

const PROGRESS_FIXTURE = `# Progress — Example

## 2026-07-10 18:00 — Real-car readiness: 4 blockers fixed
**Changed:** BleTransport.kt, CrashLogger.kt
**Next:** desk test with Veepeak adapter

<!-- session-in-progress:start=2026-07-10T21:42:57.013Z -->
## 2026-07-10 17:37 — Deploy (in progress)

### One-time setup (phone)

1 _(in progress)_
## Deploy instructions

nested ## inside a summary
<!-- end-session-in-progress -->

## 2026-07-09 12:00 — Older completed entry
**Changed:** Older.kt
`;

const DECISIONS_FIXTURE = `# Decisions — Example

## Template

\`\`\`
## YYYY-MM-DD — <Decision title>
**Status:** Accepted
\`\`\`

---

## 2026-07-01 — Use Redis for session store
**Context:** sessions outgrew memory.
**Decision:** chose Redis for sessions

## 2026-06-15 — Use PostgreSQL
**Decision:** chose Postgres for durable data
`;

const DECISIONS_TEMPLATE_ONLY = `# Decisions — Example

## Template

\`\`\`
## YYYY-MM-DD — <Decision title>
**Status:** Accepted
\`\`\`

---

_No decisions recorded yet._
`;

const STANDARD_PLAN_FIXTURE = `# Plan — Add /version endpoint

## Goal
Add a GET /version endpoint.

## Phases

1. **Route** — add the route to app.py
2. **Tests** — add integration tests

## Open questions

- None
`;

// ============================================================================
// Degradation cases (the explicit TDD matrix)
// ============================================================================

test("case 1: all inputs absent -> all unknowns, no phase, empty one-liner", () => {
  const state = buildProjectState({
    plan: null,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.equal(state.phase, null);
  assert.equal(state.blocked, null);
  assert.equal(state.openQuestions, null);
  assert.equal(state.lastDecision, null);
  assert.equal(state.movedSince, null);
  assert.deepEqual(state.sources, {
    plan: "absent",
    tasks: "absent",
    progress: "absent",
    decisions: "absent",
    vision: "absent",
  });
  assert.equal(formatProjectStateLine(state), "");
});

test("case 2: only PLAN.md -> phase from plan, open Qs from plan, blocked unknown", () => {
  const state = buildProjectState({
    plan: PLAN_FIXTURE,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
  // lowest-numbered incomplete plan phase is Phase 1 (80%)
  assert.deepEqual(state.phase, { current: 1, total: 3, title: "Core" });
  assert.equal(state.blocked, null); // no TASKS to judge from
  assert.equal(state.openQuestions.count, 2);
  assert.equal(state.lastDecision, null);
});

test("case 3: only TASKS.md -> phase from tasks, blocked from task lines, open Qs unknown", () => {
  const state = buildProjectState({
    plan: null,
    tasks: TASKS_FIXTURE,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.equal(state.phase.current, 1); // lowest incomplete phase
  assert.equal(state.phase.total, 3);
  assert.equal(state.blocked.count, 1); // "blocked on OSMDroid"
  assert.equal(state.openQuestions, null); // no PLAN to judge from
});

test("case 4: only PROGRESS.md -> latest progress, no phase/blocked/open", () => {
  const state = buildProjectState({
    plan: null,
    tasks: null,
    progress: PROGRESS_FIXTURE,
    decisions: null,
    vision: null,
  });
  assert.equal(state.phase, null);
  assert.equal(state.blocked, null);
  assert.equal(state.openQuestions, null);
  assert.equal(state.latestProgress.summary, "Real-car readiness: 4 blockers fixed");
});

test("case 5: only DECISIONS.md -> lastDecision set, everything else unknown", () => {
  const state = buildProjectState({
    plan: null,
    tasks: null,
    progress: null,
    decisions: DECISIONS_FIXTURE,
    vision: null,
  });
  assert.equal(state.lastDecision.title, "Use Redis for session store");
  assert.equal(state.lastDecision.summary, "chose Redis for sessions");
  assert.equal(state.phase, null);
  assert.equal(state.blocked, null);
});

test("case 6: TASKS.md with no '## Phase' headers -> phase null, blocked still judged", () => {
  const flat = `# Tasks
- [x] T-001 — a
- [ ] T-002 — b — blocked on dependency
- [ ] T-003 — c
`;
  const state = buildProjectState({
    plan: null,
    tasks: flat,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.equal(state.phase, null);
  assert.equal(state.blocked.count, 1);
});

test("case 7: PLAN.md open questions empty vs populated", () => {
  const empty = buildProjectState({
    plan: PLAN_NO_OPEN,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.equal(empty.openQuestions.count, 0);

  const populated = buildProjectState({
    plan: PLAN_FIXTURE,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.equal(populated.openQuestions.count, 2);
});

test("case 8: PROGRESS.md in-progress fence + nested ## -> top entry is last completed", () => {
  const { entries } = parseProgress(PROGRESS_FIXTURE);
  assert.equal(entries[0].summary, "Real-car readiness: 4 blockers fixed");
  assert.equal(entries[1].summary, "Older completed entry");
  // the in-progress fragment must never surface as an entry
  assert.ok(entries.every((e) => !e.summary.includes("Deploy")));
});

test("case 9: DECISIONS.md template-only -> lastDecision null, source present", () => {
  const state = buildProjectState({
    plan: null,
    tasks: null,
    progress: null,
    decisions: DECISIONS_TEMPLATE_ONLY,
    vision: null,
  });
  assert.equal(state.lastDecision, null);
  assert.equal(state.sources.decisions, "present");
});

test("case 10: CRLF line endings parse identically to LF", () => {
  const lf = parseTasks(TASKS_FIXTURE);
  const crlf = parseTasks(TASKS_CRLF);
  assert.deepEqual(crlf, lf);
});

test("case 11: malformed markdown never throws, degrades to partial parse", () => {
  // truncated frontmatter, no closing fence, odd nesting
  const malformed = "---\nfoo: [unclosed\n\n## Phase 1 — X\n- [ ] T-001 — a";
  const state = buildProjectState({
    plan: malformed,
    tasks: malformed,
    progress: malformed,
    decisions: malformed,
    vision: malformed,
  });
  // no throw is the assertion; spot-check a sane partial result
  assert.ok(Array.isArray(state.phases));
});

// ============================================================================
// Answer-1 addition: open questions and blocked are independent segments
// ============================================================================

test("answer1: open questions but nothing blocked -> distinct segments, not 'blocked'", () => {
  const state = buildProjectState({
    plan: PLAN_FIXTURE, // 2 open questions
    tasks: `## Phase 2 — Moat
- [ ] T-003 — GPS map panel
- [ ] T-004 — bookmark markers
`, // no blocker lines
    progress: null,
    decisions: DECISIONS_FIXTURE,
    vision: null,
  });
  assert.equal(state.blocked.count, 0); // known: nothing blocked
  assert.equal(state.openQuestions.count, 2);

  const line = formatProjectStateLine(state);
  assert.ok(line.includes("nothing blocked"), `line: ${line}`);
  assert.ok(line.includes("2 open Qs"), `line: ${line}`);
  assert.ok(!line.includes("2 blocked"), `line: ${line}`);
  // distinct segments: "nothing blocked" precedes "2 open Qs"
  assert.ok(
    line.indexOf("nothing blocked") < line.indexOf("2 open Qs"),
    `segment order wrong: ${line}`,
  );
});

test("answer1: blocked independent of open-questions presence (no PLAN)", () => {
  const state = buildProjectState({
    plan: null,
    tasks: `## Phase 1 — Core
- [ ] T-002 — blocked on dependency
`,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.equal(state.blocked.count, 1);
  assert.equal(state.openQuestions, null); // PLAN absent, still blocked=1
});

test("blocked detection: blocked/blocker/blocking/waiting-on matched; completed ignored", () => {
  const { blocked } = parseTasks(`## Phase 1 — Core
- [ ] T-001 — blocked on X
- [ ] T-002 — a blocker for Y
- [ ] T-003 — blocking issue
- [ ] T-004 — waiting on upstream
- [x] T-005 — blocked but already done
- [ ] T-006 — a plain block list item
`);
  assert.equal(blocked.count, 4);
  assert.ok(blocked.reasons.some((r) => r.includes("T-001")));
  assert.ok(blocked.reasons.some((r) => r.includes("T-004")));
  assert.ok(!blocked.reasons.some((r) => r.includes("T-005")), "done task not a blocker");
  assert.ok(!blocked.reasons.some((r) => r.includes("T-006")), "bare 'block' not a blocker");
});

test("phase numerator: lowest-numbered incomplete phase wins", () => {
  const { phases } = parseTasks(TASKS_FIXTURE);
  const state = buildProjectState({
    plan: null,
    tasks: TASKS_FIXTURE,
    progress: null,
    decisions: null,
    vision: null,
  });
  // Phase 1 has pending (T-002), Phases 2 and 3 also have pending -> current = 1
  assert.equal(state.phase.current, 1);
  assert.equal(state.phase.total, 3);
  assert.equal(phases.find((p) => p.number === 1).pending, 1);
});

test("format: full one-liner when all verdict sources present", () => {
  const state = buildProjectState({
    plan: PLAN_FIXTURE,
    tasks: TASKS_FIXTURE,
    progress: PROGRESS_FIXTURE,
    decisions: DECISIONS_FIXTURE,
    vision: null,
  });
  const line = formatProjectStateLine(state);
  assert.ok(line.includes("Phase 1/3"), `line: ${line}`);
  assert.ok(line.includes("1 blocked"), `line: ${line}`);
  assert.ok(line.includes("2 open Qs"), `line: ${line}`);
  assert.ok(line.includes("last: chose Redis for sessions"), `line: ${line}`);
  assert.ok(line.includes(" · "), `expected separators: ${line}`);
});

// ============================================================================
// Individual parser coverage
// ============================================================================

test("parseDecisions: latest = top real entry, template skipped, fences ignored", () => {
  const { latest } = parseDecisions(DECISIONS_FIXTURE);
  assert.equal(latest.title, "Use Redis for session store");
  assert.equal(latest.date, "2026-07-01");
  assert.equal(latest.summary, "chose Redis for sessions");
});

test("parsePlan: completion % and ✅ COMPLETE extracted", () => {
  const plan = `### Phase 0 — Foundations ✅ COMPLETE
- a
### Phase 1 — Core (80% complete)
- b
### Phase 2 — Moat (0% complete)
- c
`;
  const { phases } = parsePlan(plan);
  assert.equal(phases[0].completion, 100);
  assert.equal(phases[1].completion, 80);
  assert.equal(phases[2].completion, 0);
  assert.equal(phases[0].title, "Foundations");
});

test("standard ## Phases list: phase count known, current unknown -> 'N phases'", () => {
  const state = buildProjectState({
    plan: STANDARD_PLAN_FIXTURE,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
  assert.deepEqual(state.phase, { current: null, total: 2 });
  assert.equal(state.openQuestions.count, 0);
  const line = formatProjectStateLine(state);
  assert.ok(line.includes("2 phases"), `line: ${line}`);
  assert.ok(!line.includes("Phase "), `line: ${line}`);
});

test("standard ## Phases list with open questions renders both segments", () => {
  const withOpen = STANDARD_PLAN_FIXTURE.replace("- None", "- Redis or Postgres?");
  const state = buildProjectState({
    plan: withOpen,
    tasks: null,
    progress: null,
    decisions: null,
    vision: null,
  });
  const line = formatProjectStateLine(state);
  assert.ok(line.includes("2 phases"), `line: ${line}`);
  assert.ok(line.includes("1 open Qs"), `line: ${line}`);
});

test("open questions: bare 'None.' (trailing period, no bullet) is not a question", () => {
  const plan = `# Plan — X\n\n## Open questions\n\nNone.\n`;
  const { openQuestions } = parsePlan(plan);
  assert.deepEqual(openQuestions, []);
});

test("open questions: bulleted '- None.' is not a question", () => {
  const plan = `# Plan — X\n\n## Open questions\n\n- None.\n- Nothing\n`;
  const { openQuestions } = parsePlan(plan);
  assert.deepEqual(openQuestions, []);
});

test("parseVision: title + summary extracted, absent handled", () => {
  const { title, summary } = parseVision("# EasyOBD\n\nAn OBD2 dashboard app.\n");
  assert.equal(title, "EasyOBD");
  assert.ok(summary.includes("OBD2"));
});
