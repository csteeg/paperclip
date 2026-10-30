import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let instanceHome: string | undefined;
let temporaryDirectory: string | undefined;

afterEach(async () => {
  vi.doUnmock("../home-paths.js");
  vi.resetModules();
  vi.unstubAllEnvs();
  if (instanceHome) await rm(instanceHome, { recursive: true, force: true });
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  instanceHome = undefined;
  temporaryDirectory = undefined;
});

it("reconstructs persisted temporary-directory cleanup after a server restart", async () => {
  instanceHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-home-"));
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-cleanup-"));
  vi.stubEnv("PAPERCLIP_HOME", instanceHome);

  const instanceRoot = path.join(instanceHome, "instances", "default");
  await mkdir(instanceRoot, { recursive: true });
  const ledger = path.join(instanceRoot, "pending-temporary-directory-cleanup.json");
  await writeFile(ledger, JSON.stringify([temporaryDirectory]), { mode: 0o600 });

  vi.doMock("../home-paths.js", () => ({
    resolvePaperclipInstanceRoot: () => instanceRoot,
  }));
  vi.resetModules();
  const cleanup = await import("./temporary-directory-cleanup.js");
  await cleanup.retryTemporaryDirectoryCleanupNow();

  expect(JSON.parse(await readFile(ledger, "utf8"))).toEqual([]);
  await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
