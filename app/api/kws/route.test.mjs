import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { POST } = await jiti.import("./route.ts");

const HOST = "localhost:30141";

test("POST rejects missing audio with 400", async () => {
  const res = await POST(new Request("http://localhost/api/kws", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: HOST },
    body: JSON.stringify({}),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /audio/);
});

test("POST rejects non-JSON content type with 415", async () => {
  const res = await POST(new Request("http://localhost/api/kws", {
    method: "POST",
    headers: { host: HOST, "Content-Type": "text/plain" },
    body: "hello",
  }));
  assert.equal(res.status, 415);
});

test("POST rejects an oversized audio chunk with 400", async () => {
  const res = await POST(new Request("http://localhost/api/kws", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: HOST },
    body: JSON.stringify({ audio: "x".repeat(300 * 1024) }),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too large/);
});
