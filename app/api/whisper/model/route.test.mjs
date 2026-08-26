import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { POST } = await jiti.import("./route.ts");

test("POST rejects an invalid JSON body with 400", async () => {
  const req = new Request("http://localhost/api/whisper/model", {
    method: "POST",
    body: "not-json",
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid request body/);
});

test("POST rejects an unknown model name with 400", async () => {
  const req = new Request("http://localhost/api/whisper/model", {
    method: "POST",
    body: JSON.stringify({ model: "ggml-definitely-not-real.bin" }),
    headers: { "Content-Type": "application/json" },
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Unknown model/);
});

test("POST rejects a non-string model with 400", async () => {
  const req = new Request("http://localhost/api/whisper/model", {
    method: "POST",
    body: JSON.stringify({ model: 123 }),
    headers: { "Content-Type": "application/json" },
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid model/);
});
