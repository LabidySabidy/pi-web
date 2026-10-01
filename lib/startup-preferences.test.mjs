import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { persistExplicitStartupPreferences } = await createJiti(import.meta.url)
  .import("./startup-preferences.ts");

async function withSettings(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-startup-preferences-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);

  try {
    const settings = SettingsManager.create(cwd, agentDir);
    await run({ settings, settingsPath: join(agentDir, "settings.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("persists an explicit thinking level the session actually resolved to", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    const result = await persistExplicitStartupPreferences(
      settings,
      {
        model: { provider: "deepseek", modelId: "deepseek-chat" },
        thinkingLevel: "high",
      },
      {
        model: { provider: "deepseek", modelId: "deepseek-chat" },
        thinkingLevel: "high",
        supportsThinking: true,
      },
    );

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(
      {
        defaultProvider: saved.defaultProvider,
        defaultModel: saved.defaultModel,
        defaultThinkingLevel: saved.defaultThinkingLevel,
      },
      {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        defaultThinkingLevel: "high",
      },
    );
    assert.equal(result.modelDefaultChanged, true);
    assert.equal(result.thinkingLevelDiverged, undefined);
  });
});

// GL-033. The defect this guards against: the guard asked "did the caller choose this level?" and the
// write used the session's LIVE level, so a level moved after construction — by an extension, or by
// level cycling that happens with no user action — was written to the GLOBAL settings file as the
// user's default, and every later session started there.
test("REFUSES to persist when the requested level is not the one the session resolved to", async () => {
  await withSettings(async ({ settings, settingsPath }) => {
    settings.setDefaultThinkingLevel("medium");
    await settings.flush();

    const result = await persistExplicitStartupPreferences(
      settings,
      // The user asked for xhigh...
      { thinkingLevel: "xhigh" },
      // ...but construction resolved high. Persisting EITHER value would be a guess: "high" is right
      // if the request was clamped, "xhigh" is right if something moved the level. Refuse.
      { thinkingLevel: "high", supportsThinking: true },
    );

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(
      saved.defaultThinkingLevel,
      "medium",
      "neither the requested nor the resolved level may be written on divergence",
    );
    assert.equal(result.thinkingLevelDiverged, true);
  });
});

test("does not persist a level the session moved away from, even when it moved to 'off'", async () => {
  // The exact production shape: the browser explicitly asked for `high`, then an extension set the
  // live level to `off` (the harness's reasoning-level extension does this for read sweeps). The old
  // code wrote that `off` to settings.json, so the next session started with thinking disabled.
  await withSettings(async ({ settings, settingsPath }) => {
    settings.setDefaultThinkingLevel("high");
    await settings.flush();

    const result = await persistExplicitStartupPreferences(
      settings,
      { thinkingLevel: "high" },
      { thinkingLevel: "off", supportsThinking: true },
    );

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultThinkingLevel, "high", "a transient 'off' must never become the default");
    assert.equal(result.thinkingLevelDiverged, true);
  });
});

test("does not persist implicit scope selections", async () => {
  await withSettings(async ({ settings }) => {
    settings.setDefaultModelAndProvider("saved", "saved-model");
    settings.setDefaultThinkingLevel("medium");
    await settings.flush();

    const result = await persistExplicitStartupPreferences(
      settings,
      {},
      {
        model: { provider: "scoped", modelId: "scoped-model" },
        thinkingLevel: "high",
        supportsThinking: true,
      },
    );

    assert.equal(settings.getDefaultProvider(), "saved");
    assert.equal(settings.getDefaultModel(), "saved-model");
    assert.equal(settings.getDefaultThinkingLevel(), "medium");
    assert.equal(result.modelDefaultChanged, false);
  });
});

test("does not persist a model when startup resolved a different model", async () => {
  await withSettings(async ({ settings }) => {
    const result = await persistExplicitStartupPreferences(
      settings,
      { model: { provider: "requested", modelId: "requested-model" } },
      {
        model: { provider: "fallback", modelId: "fallback-model" },
        thinkingLevel: "off",
        supportsThinking: false,
      },
    );

    assert.equal(settings.getDefaultProvider(), undefined);
    assert.equal(settings.getDefaultModel(), undefined);
    assert.equal(result.modelDefaultChanged, false);
  });
});

test("does not replace a reasoning default with off for a non-thinking model", async () => {
  await withSettings(async ({ settings }) => {
    settings.setDefaultThinkingLevel("high");
    await settings.flush();

    await persistExplicitStartupPreferences(
      settings,
      { thinkingLevel: "off" },
      { thinkingLevel: "off", supportsThinking: false },
    );

    assert.equal(settings.getDefaultThinkingLevel(), "high");
  });
});
