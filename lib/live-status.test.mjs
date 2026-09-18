import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { describeActivity, describeSubagent, firstSentences, speakDuration, summariseStatus } =
  await jiti.import("./live-status.ts");

const idle = { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false };
const running = { ...idle, isStreaming: true, isPromptRunning: true };

// ---------------------------------------------------------------------------
// speakDuration
// ---------------------------------------------------------------------------

test("speakDuration uses seconds under 45s", () => {
  assert.equal(speakDuration(0), "0 seconds");
  assert.equal(speakDuration(1000), "1 second");
  assert.equal(speakDuration(8000), "8 seconds");
  assert.equal(speakDuration(44_000), "44 seconds");
});

test("speakDuration switches to minutes and hours", () => {
  assert.equal(speakDuration(60_000), "1 minute");
  assert.equal(speakDuration(150_000), "3 minutes");
  assert.equal(speakDuration(3_600_000), "1 hour");
  assert.equal(speakDuration(7_200_000), "2 hours");
});

test("speakDuration never emits a negative duration", () => {
  assert.equal(speakDuration(-5000), "0 seconds");
});

// ---------------------------------------------------------------------------
// describeActivity
// ---------------------------------------------------------------------------

test("describeActivity reports nothing when nothing is happening", () => {
  assert.equal(describeActivity(idle), null);
});

test("describeActivity prefers the most specific signal", () => {
  assert.equal(describeActivity({ ...running, isCompacting: true }), "tidying up its context");
  assert.equal(describeActivity({ ...running, isBashRunning: true }), "running a shell command");
  assert.equal(describeActivity(running), "working");
});

test("describeActivity includes elapsed time when given", () => {
  assert.equal(describeActivity({ ...running, turnElapsedMs: 8000 }), "working for 8 seconds");
});

// ---------------------------------------------------------------------------
// summariseStatus -- idle
// ---------------------------------------------------------------------------

test("an idle session with no history says so plainly", () => {
  const out = summariseStatus(idle);
  assert.equal(out, "Nothing's running right now.");
});

test("an idle session falls back to the last thing said", () => {
  const out = summariseStatus({ ...idle, lastAssistantText: "The build passes. I also fixed the lint error." });
  assert.match(out, /Last thing I said/);
  assert.match(out, /The build passes\./);
  assert.ok(!out.includes("lint error"), "only the first sentence should be spoken");
});

// ---------------------------------------------------------------------------
// summariseStatus -- running
// ---------------------------------------------------------------------------

test("a running turn is described with its duration", () => {
  const out = summariseStatus({ ...running, turnElapsedMs: 12_000 });
  assert.equal(out, "I'm working for 12 seconds.");
});

test("status output stays short and never drops a failure", () => {
  const out = summariseStatus({
    ...running,
    turnElapsedMs: 90_000,
    subagents: [
      { profile: "worker", description: "Refactoring the parser", status: "running" },
      { profile: "reviewer", description: "Reviewing the diff", status: "running" },
    ],
    steeringCount: 1,
    contextPercent: 85,
  });
  const sentences = out.split(/(?<=[.!?])\s+/).filter(Boolean);
  // Bounded, but the bound exists to keep speech short -- not to truncate.
  assert.ok(sentences.length <= 3, `too many sentences (${sentences.length}): ${out}`);
});

test("a failure is reported even when the sentence budget is spent", () => {
  // The budget is spent by activity + active + completed, so a naive slice
  // would drop the failure -- the one thing a user must not be told is "all OK".
  const out = summariseStatus({
    ...running,
    turnElapsedMs: 90_000,
    subagents: [
      { profile: "a", description: "first", status: "running" },
      { profile: "b", description: "second", status: "completed" },
      { profile: "c", description: "broken thing", status: "failed" },
    ],
    steeringCount: 1,
    contextPercent: 90,
  });
  assert.match(out, /didn't finish cleanly/, `failure was dropped: ${out}`);
  assert.match(out, /broken thing/);
});

// ---------------------------------------------------------------------------
// subagents
// ---------------------------------------------------------------------------

test("a single active helper is described by its label, not its profile", () => {
  const out = summariseStatus({
    ...running,
    subagents: [{ profile: "worker", description: "Refactoring the parser", status: "running" }],
  });
  assert.match(out, /Refactoring the parser/);
  assert.ok(!out.includes("worker"), "profile ids should not be spoken");
});

test("several active helpers are listed with a spoken conjunction", () => {
  const out = summariseStatus({
    ...running,
    subagents: [
      { profile: "worker", description: "refactoring the parser", status: "running" },
      { profile: "reviewer", description: "reviewing the diff", status: "running" },
    ],
  });
  assert.match(out, /2 helpers are still going/);
  assert.match(out, /refactoring the parser and reviewing the diff/);
});

test("three helpers use a comma list with a final and", () => {
  const out = summariseStatus({
    ...running,
    subagents: [
      { profile: "a", description: "one", status: "running" },
      { profile: "b", description: "two", status: "running" },
      { profile: "c", description: "three", status: "running" },
    ],
  });
  assert.match(out, /one, two and three/);
});

test("a completed helper is reported as finished", () => {
  const out = summariseStatus({
    ...running,
    subagents: [{ profile: "worker", description: "the migration", status: "completed" }],
  });
  assert.match(out, /finished/);
  assert.match(out, /the migration/);
});

test("a failed helper is reported with the problem leading", () => {
  const out = summariseStatus({
    ...running,
    subagents: [{ profile: "worker", description: "the migration", status: "failed" }],
  });
  assert.match(out, /didn't finish cleanly/);
  assert.match(out, /the migration/);
});

test("interrupted counts as not finishing cleanly", () => {
  const out = summariseStatus({
    ...running,
    subagents: [{ profile: "worker", description: "the migration", status: "interrupted" }],
  });
  assert.match(out, /didn't finish cleanly/);
});

test("active, completed and failed can coexist", () => {
  const out = summariseStatus({
    ...running,
    subagents: [
      { profile: "a", description: "first", status: "running" },
      { profile: "b", description: "second", status: "completed" },
      { profile: "c", description: "third", status: "failed" },
    ],
  });
  assert.match(out, /still going/);
  assert.match(out, /finished/);
  assert.match(out, /didn't finish cleanly/);
});

test("subagents alone, with no turn running, still report", () => {
  const out = summariseStatus({
    ...idle,
    subagents: [{ profile: "worker", description: "the migration", status: "running" }],
  });
  assert.match(out, /the migration/);
});

// ---------------------------------------------------------------------------
// queued messages and context pressure
// ---------------------------------------------------------------------------

test("queued messages are mentioned", () => {
  assert.match(summariseStatus({ ...running, steeringCount: 1 }), /One message is queued/);
  assert.match(summariseStatus({ ...running, steeringCount: 1, followUpCount: 1 }), /2 messages are queued/);
});

test("zero queued messages are not mentioned", () => {
  assert.ok(!summariseStatus({ ...running, steeringCount: 0, followUpCount: 0 }).includes("queued"));
});

test("context pressure warns only past the threshold", () => {
  assert.ok(!summariseStatus({ ...running, contextPercent: 40 }).includes("full"));
  assert.match(summariseStatus({ ...running, contextPercent: 85 }), /85 percent full/);
});

// ---------------------------------------------------------------------------
// describeSubagent
// ---------------------------------------------------------------------------

test("describeSubagent prefers the description and strips punctuation", () => {
  assert.equal(describeSubagent({ profile: "worker", description: "Refactoring the parser.", status: "running" }), "Refactoring the parser");
});

test("describeSubagent falls back to a de-hyphenated profile", () => {
  assert.equal(describeSubagent({ profile: "general-purpose", description: "", status: "running" }), "general purpose");
});

test("describeSubagent has a last-resort label", () => {
  assert.equal(describeSubagent({ profile: "", description: "", status: "running" }), "a helper");
});

// ---------------------------------------------------------------------------
// firstSentences
// ---------------------------------------------------------------------------

test("firstSentences takes the requested number of sentences", () => {
  assert.equal(firstSentences("One. Two. Three.", 1), "One.");
  assert.equal(firstSentences("One. Two. Three.", 2), "One. Two.");
});

test("firstSentences strips code blocks and markdown noise", () => {
  const text = "# Heading\n\nHere is the answer.\n\n```js\nconst x = 1;\n```\n\nDone.";
  const out = firstSentences(text, 1);
  assert.match(out, /Here is the answer\./);
  assert.ok(!out.includes("const x"), "code must not be read aloud");
  assert.ok(!out.includes("#"), "markdown markers must be stripped");
});

test("firstSentences handles text with no terminator", () => {
  assert.equal(firstSentences("no punctuation here", 1), "no punctuation here");
});

test("firstSentences bounds very long output", () => {
  const long = `${"a".repeat(500)}.`;
  const out = firstSentences(long, 1, 100);
  assert.ok(out.length <= 101, `unbounded output: ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("firstSentences returns empty for empty input", () => {
  assert.equal(firstSentences("", 1), "");
  assert.equal(firstSentences("   \n  ", 1), "");
});
