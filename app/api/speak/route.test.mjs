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

// Read-aloud synthesizes in two stages: a DeepSeek summary, then Piper. The model id is a plain
// string resolved through ModelRuntime, so a rename in the catalog invalidates it SILENTLY — the
// route keeps compiling, and the failure only appears when someone clicks read-aloud and gets a 500.
//
// That is precisely how `deepseek-v4-flash` shipped: it appears in neither agent/models.json nor
// agent/models-store.json, so POST /api/speak returned
//   {"error":"Summarizer model not found: deepseek/deepseek-v4-flash"}
// while Piper itself was healthy (voices endpoint 200, `available: true`) and the whole UI chain was
// wired. The symptom named the feature, not the half that was broken.
//
// This asserts the id resolves in the REAL catalog rather than against a hardcoded list, which would
// only move the staleness from the route into the test. A rename now fails here.
test("the summarizer model id resolves in the real catalog", async () => {
  const { createModelRuntimeWithExtensions } = await jiti.import("@/lib/model-runtime.ts");
  const routeSource = await (await import("node:fs/promises")).readFile(
    new URL("./route.ts", import.meta.url),
    "utf8",
  );
  const provider = /SUMMARIZER_PROVIDER = "([^"]+)"/.exec(routeSource)?.[1];
  const model = /SUMMARIZER_MODEL = "([^"]+)"/.exec(routeSource)?.[1];
  assert.ok(provider && model, "the route must still declare a summarizer provider and model");

  const runtime = await createModelRuntimeWithExtensions();
  assert.ok(
    runtime.getModel(provider, model),
    `read-aloud would 500: ${provider}/${model} is not in the resolved catalog. ` +
      `Pick an id that exists, or the summarizer stage fails before Piper ever runs.`,
  );
});
