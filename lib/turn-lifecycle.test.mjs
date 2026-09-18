import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { TurnLifecycle } = await jiti.import("./turn-lifecycle.ts");

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test("a fresh lifecycle is inactive with nothing pending", () => {
  const t = new TurnLifecycle();
  assert.equal(t.isActive, false);
  assert.equal(t.pending, 0);
});

test("begin activates the turn", () => {
  const t = new TurnLifecycle();
  t.begin();
  assert.equal(t.isActive, true);
  assert.equal(t.pending, 0);
});

test("a natural end is reported as natural", () => {
  const t = new TurnLifecycle();
  t.begin();
  assert.equal(t.end(), "natural");
});

test("end does not deactivate, so a late delta is still forwarded", () => {
  // Constraint 1: a stray end that cleared `active` would silently drop every
  // subsequent delta -- the "stuck in thinking" bug.
  const t = new TurnLifecycle();
  t.begin();
  t.end();
  assert.equal(t.isActive, true, "active must survive end()");
});

test("an end with nothing active and nothing pending is idle", () => {
  const t = new TurnLifecycle();
  assert.equal(t.end(), "idle");
});

// ---------------------------------------------------------------------------
// the abort race -- what this class exists for
// ---------------------------------------------------------------------------

test("beginning while active expects one stale end and stops forwarding", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.begin(); // a new utterance arrived mid-turn
  assert.equal(t.pending, 1);
  assert.equal(t.isActive, false, "forwarding pauses until rearm");
});

test("rearm re-asserts the turn and decays the stale expectation", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.begin();
  t.rearm();
  assert.equal(t.isActive, true);
  assert.equal(t.pending, 0);
});

test("the drained end arriving during the abort window is cancelled", () => {
  // The ordering that matters: cancel() opens the suppression window, and the
  // drained end must arrive BEFORE rearm() consumes it. rearm() runs when the
  // next prompt is submitted, not immediately after cancel.
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();

  // Drains here, while the expectation is still live.
  assert.equal(t.end(), "cancelled", "stale end must be suppressed");
  assert.equal(t.pending, 0, "the expectation is consumed");

  // Only now does the new turn begin.
  t.rearm();
  assert.equal(t.isActive, true);
});

test("cancel stops forwarding immediately", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();
  assert.equal(t.isActive, false);
  assert.equal(t.pending, 1);
});

test("cancel while inactive is a no-op", () => {
  const t = new TurnLifecycle();
  t.cancel();
  assert.equal(t.pending, 0);
  assert.equal(t.isActive, false);
});

test("cancelling twice does not expect two stale ends", () => {
  // A second cancel with no turn running should not queue a phantom end,
  // which would later swallow a real completion.
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();
  t.cancel();
  assert.equal(t.pending, 1);
});

// ---------------------------------------------------------------------------
// rearm forfeits suppression rather than misclassifying the real end
// ---------------------------------------------------------------------------

test("a late drained end arriving after rearm is forwarded, not swallowed", () => {
  // This is a deliberate trade, not a bug. rearm() runs when the next prompt is
  // submitted; if the stale drain has not arrived by then we forfeit suppression
  // rather than risk misclassifying the new turn's REAL end as cancelled (which
  // would leave the UI stuck in "thinking" forever). The client's
  // turn-activity guard is what suppresses the resulting phantom placeholder.
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();
  t.rearm(); // expectation decayed; the drained end never came
  assert.equal(t.pending, 0);
  assert.equal(t.end(), "natural", "forfeited suppression forwards rather than drops");
});

test("keeping the expectation would misclassify the real end", () => {
  // Guards the reasoning above: if rearm() did NOT decay, the new turn's real
  // end would be reported cancelled and the UI would never leave "thinking".
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();
  // Deliberately not rearming, to show what the alternative would look like.
  assert.equal(t.end(), "cancelled");
  assert.equal(t.end(), "idle", "the real end has nothing left to consume it");
});

// ---------------------------------------------------------------------------
// revert -- empty STT
// ---------------------------------------------------------------------------

test("revert undoes a begin that created a stale expectation", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.begin(); // pending = 1, inactive
  t.revert(); // STT came back empty: no turn actually started
  assert.equal(t.pending, 0, "phantom stale end must not survive");
  assert.equal(t.isActive, true, "the prior turn resumes");
});

test("revert on a simple begin deactivates", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.revert();
  assert.equal(t.isActive, false);
});

test("revert never drives pending below zero", () => {
  const t = new TurnLifecycle();
  t.revert();
  assert.equal(t.pending, 0);
});

// ---------------------------------------------------------------------------
// sequences
// ---------------------------------------------------------------------------

test("two consecutive barge-ins are each suppressed in their own window", () => {
  const t = new TurnLifecycle();

  t.begin();
  t.cancel();
  assert.equal(t.end(), "cancelled", "first stale end, inside its window");
  t.rearm();

  t.begin();
  t.cancel();
  assert.equal(t.end(), "cancelled", "second stale end, inside its window");
  t.rearm();

  assert.equal(t.end(), "natural", "a clean completion afterwards");
});

test("a full clean turn is unaffected by the machinery", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.rearm();
  assert.equal(t.end(), "natural");
  assert.equal(t.isActive, true, "still active for the next turn's deltas");
});

test("reset clears everything", () => {
  const t = new TurnLifecycle();
  t.begin();
  t.cancel();
  t.reset();
  assert.equal(t.isActive, false);
  assert.equal(t.pending, 0);
});

test("the stuck-thinking regression: active survives many ends", () => {
  // Guard the exact failure this class exists to prevent. If end() cleared
  // `active`, a second end would report idle and drop the turn.
  const t = new TurnLifecycle();
  t.begin();
  for (let i = 0; i < 5; i++) {
    assert.equal(t.end(), "natural");
    assert.equal(t.isActive, true);
  }
});
