import { LiveCaptureProbe } from "@/components/LiveCaptureProbe";

export const dynamic = "force-dynamic";

/**
 * Dev-only page for verifying the Live Conversation capture path in a browser.
 * Not linked from anywhere; delete alongside components/LiveCaptureProbe.tsx
 * once the Live toggle ships.
 */
export default function LiveProbePage() {
  return <LiveCaptureProbe />;
}
