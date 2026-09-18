/**
 * The dispatch table is the part of Live mode that must not be wrong, so it is
 * extracted from the React hook and tested directly: given an intent, which
 * callbacks fire and which must NOT.
 *
 * The load-bearing rule is that `status` touches nothing -- no prompt, no
 * steer, no abort. A status query that dispatched anything would defeat the
 * point of the whole design, since the user asks precisely so as not to
 * interrupt.
 */

export type LiveRoute = "status" | "abort" | "steer" | "follow_up" | "prompt";

export interface RouteCallbacks {
  onPrompt: (text: string) => void;
  onSteer: (text: string) => void;
  onFollowUp: (text: string) => void;
  onAbort: () => void;
}

export interface RoutedAction {
  /** Which callback to invoke, or null for a status query (nothing dispatched). */
  action: keyof RouteCallbacks | null;
  /** Text to pass, when the callback takes one. */
  text?: string;
  /**
   * Whether this intent starts or ends a turn, which the caller uses to drive
   * the turn lifecycle. `status` does neither.
   */
  lifecycle: "begin" | "cancel" | "none";
}

/**
 * Map a classified intent onto a concrete action.
 *
 * Pure: no fetching, no state. The caller performs the side effect and manages
 * the turn lifecycle from `lifecycle`.
 */
export function routeIntent(intent: LiveRoute, text: string): RoutedAction {
  switch (intent) {
    case "status":
      // Deliberately dispatches nothing. Answered from live state by the caller.
      return { action: null, lifecycle: "none" };
    case "abort":
      // cancel() rather than end(): the interrupted turn's drained events must
      // classify as cancelled so they are suppressed, not replayed.
      return { action: "onAbort", lifecycle: "cancel" };
    case "steer":
      return { action: "onSteer", text, lifecycle: "none" };
    case "follow_up":
      return { action: "onFollowUp", text, lifecycle: "none" };
    case "prompt":
    default:
      return { action: "onPrompt", text, lifecycle: "begin" };
  }
}
