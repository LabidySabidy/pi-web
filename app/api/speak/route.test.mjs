import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { buildSummarizePrompt, POST } = await jiti.import("./route.ts");

const HOST = "localhost:30141";

test("buildSummarizePrompt includes the message and plain-prose rules", () => {
  const prompt = buildSummarizePrompt("The server is down.");
  assert.ok(prompt.includes("The server is down."));
  assert.ok(prompt.includes("no markdown"));
  assert.ok(prompt.includes("conversational sentences"));
});

test("POST rejects missing text with 400", async () => {
  const res = await POST(new Request("http://localhost/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: HOST },
    body: JSON.stringify({}),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /text is required/);
});

test("POST rejects non-JSON content type with 415", async () => {
  const res = await POST(new Request("http://localhost/api/speak", {
    method: "POST",
    headers: { host: HOST, "Content-Type": "text/plain" },
    body: "hello",
  }));
  assert.equal(res.status, 415);
});

test("POST rejects oversized text with 400", async () => {
  const res = await POST(new Request("http://localhost/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: HOST },
    body: JSON.stringify({ text: "x".repeat(60_000) }),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /exceeds/);
});
