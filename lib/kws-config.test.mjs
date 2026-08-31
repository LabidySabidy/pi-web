import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { resolveKwsConfig } = await jiti.import("./kws-config.ts");

const isWin = process.platform === "win32";

test("resolveKwsConfig defaults to the piper venv python + repo helper", () => {
  const base = isWin ? "C:\\dev\\pi-web" : "/dev/pi-web";
  const cfg = resolveKwsConfig({}, base);
  assert.equal(cfg.python, path.join(base, "piper", "venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python"));
  assert.equal(cfg.helper, path.join(base, "scripts", "kws-helper.py"));
});

test("resolveKwsConfig honors env overrides", () => {
  const cfg = resolveKwsConfig({ KWS_PYTHON: "C:\\py\\python.exe", KWS_HELPER: "D:\\kws.py" }, "C:\\dev");
  assert.equal(cfg.python, "C:\\py\\python.exe");
  assert.equal(cfg.helper, "D:\\kws.py");
});
