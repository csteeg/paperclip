import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLocalProcessSandboxSpawnTarget, type LocalProcessSandboxOptions } from "@paperclipai/adapter-utils/local-process-sandbox";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

async function filesystemConfinementRuns(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const workspace = os.tmpdir();
  try {
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", ""],
      cwd: workspace,
      options: { workspaceDir: workspace, filesystemScope: "workspace" },
    });
    const status = spawnSync(target.command, target.args, { cwd: target.cwd }).status;
    await target.cleanup?.();
    return status === 0;
  } catch {
    return false;
  }
}

const confinementRuns = await filesystemConfinementRuns();

function buildContext(config: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { model: "claude-opus-5", ...config },
    context,
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("preserves the managed CLI marketplace environment when profile import is off", async () => {
    const ctx = buildContext({
      engine: "cli",
      managedAiConnection: { provider: "anthropic", method: "subscription" },
      env: {
        CLAUDE_CONFIG_DIR: "C:/managed/provider",
        CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/existing/plugin-cache",
      },
    });

    await execute(ctx as never);

    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string, unknown, string, string[], { env: NodeJS.ProcessEnv },
    ] | undefined;
    expect(call?.[4].env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBeUndefined();
    expect(call?.[4].env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe("C:/existing/plugin-cache");
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("mounts the imported managed plugin cache read-only for workspace-scoped CLI runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-sandbox-"));
    try {
      const sourceDir = path.join(root, "profile");
      const installDir = path.join(sourceDir, "plugins", "cache", "example", "1.0.0");
      const configDir = path.join(root, "run-config");
      await fs.mkdir(installDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
        enabledPlugins: { "example@test-marketplace": true },
      }));
      await fs.writeFile(path.join(sourceDir, "plugins", "installed_plugins.json"), JSON.stringify({
        version: 2,
        plugins: {
          "example@test-marketplace": [{ installPath: installDir, version: "1.0.0" }],
        },
      }));
      await fs.writeFile(path.join(installDir, "plugin.json"), "{}");

      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
      vi.stubEnv("PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR", sourceDir);
      const ctx = buildContext({
        engine: "cli",
        filesystemScope: "workspace",
        managedAiConnection: true,
        env: { CLAUDE_CONFIG_DIR: configDir, PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "cache" },
      });

      await execute(ctx as never);

      const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
        string,
        unknown,
        string,
        string[],
        { env: NodeJS.ProcessEnv; localProcessSandbox: { managedPaths: Array<{ path: string; access: string }> } },
      ] | undefined;
      const options = call?.[4];
      const pluginRoot = options?.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
      expect(pluginRoot).toBeTruthy();
      expect(options?.localProcessSandbox?.managedPaths).toContainEqual({ path: pluginRoot, access: "ro" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, ""])("keeps selected skills ahead of imported skills with source override %s", async (profileSourceDir) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-skill-collision-"));
    try {
      const sourceDir = path.join(root, "profile");
      const selectedSkillDir = path.join(root, "selected-skills", "careconnections");
      const configDir = path.join(root, "run-config");
      await fs.mkdir(path.join(sourceDir, "skills", "careconnections"), { recursive: true });
      await fs.mkdir(path.join(sourceDir, "skills", "personal-only"), { recursive: true });
      await fs.mkdir(selectedSkillDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "skills", "careconnections", "SKILL.md"), "Personal CareConnections skill\n");
      await fs.writeFile(path.join(sourceDir, "skills", "personal-only", "SKILL.md"), "Personal-only skill\n");
      await fs.writeFile(path.join(selectedSkillDir, "SKILL.md"), "Paperclip selected CareConnections skill\n");

      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
      vi.stubEnv("PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR", profileSourceDir === "" ? path.join(root, "absent-server-override") : sourceDir);
      vi.stubEnv("CLAUDE_CONFIG_DIR", sourceDir);
      const ctx = buildContext({
        engine: "cli",
        profileSourceDir,
        managedAiConnection: true,
        env: { CLAUDE_CONFIG_DIR: configDir, PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "cache" },
        paperclipRuntimeSkills: [{
          key: "careconnections",
          runtimeName: "careconnections",
          source: selectedSkillDir,
        }],
        paperclipSkillSync: { desiredSkills: ["careconnections"] },
      });

      await execute(ctx as never);

      const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
        string,
        unknown,
        string,
        string[],
        unknown,
      ] | undefined;
      const args = call?.[3] ?? [];
      const addDirIndex = args.indexOf("--add-dir");
      expect(addDirIndex).toBeGreaterThanOrEqual(0);
      const addDir = args[addDirIndex + 1];
      expect(await fs.readFile(path.join(addDir!, ".claude", "skills", "careconnections", "SKILL.md"), "utf8"))
        .toBe("Paperclip selected CareConnections skill\n");
      await expect(fs.access(path.join(configDir, "skills", "careconnections")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(configDir, "skills", "personal-only", "SKILL.md"), "utf8"))
        .resolves.toBe("Personal-only skill\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("mounts the durable transcript directory a managed connection links into the Claude config dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-confined-transcripts-"));
    try {
      const providerHome = path.join(root, "home", "provider");
      const durableTranscripts = path.join(root, "companies", "company-1", "agents", "agent-1", "claude-transcripts", "scope");
      await fs.mkdir(providerHome, { recursive: true });
      await fs.mkdir(durableTranscripts, { recursive: true });
      await fs.symlink(durableTranscripts, path.join(providerHome, "projects"));
      const managedConfig = {
        engine: "cli",
        managedAiConnection: { provider: "anthropic", method: "subscription" },
        env: { CLAUDE_CONFIG_DIR: providerHome },
      };
      const transcriptMount = { path: durableTranscripts, access: "rw" };
      const sandboxPaths = () => runAdapterExecutionTargetProcess.mock.calls
        .map((call) => (call as unknown[])[4] as { localProcessSandbox?: { managedPaths: unknown[] } })
        .find((options) => options?.localProcessSandbox)?.localProcessSandbox?.managedPaths;

      await execute(buildContext({ ...managedConfig, filesystemScope: "workspace" }, {
        managedAiTranscriptDir: durableTranscripts,
      }) as never);
      expect(sandboxPaths()).toContainEqual(transcriptMount);
      const siblingTranscripts = path.join(path.dirname(await fs.realpath(durableTranscripts)), "other-task");
      for (const mount of sandboxPaths() as Array<{ path: string }>) {
        expect(siblingTranscripts.startsWith(`${mount.path}${path.sep}`)).toBe(false);
      }

      vi.clearAllMocks();
      await execute(buildContext({ ...managedConfig, filesystemScope: "workspace" }) as never);
      expect(sandboxPaths()).not.toContainEqual(transcriptMount);

      vi.clearAllMocks();
      await execute(buildContext({ ...managedConfig, networkScope: "allowlist" }) as never);
      expect(sandboxPaths()).not.toContainEqual(transcriptMount);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(confinementRuns)("lets a confined run read its own transcripts but not another task's or agent's", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-transcript-isolation-")));
    try {
      const providerHome = path.join(root, "home", "provider");
      const transcriptsDir = path.join(root, "companies", "company-1", "agents", "agent-1", "claude-transcripts");
      const own = path.join(transcriptsDir, "own", "projects");
      const other = path.join(transcriptsDir, "other", "projects");
      const otherAgent = path.join(root, "companies", "company-1", "agents", "agent-2", "claude-transcripts", "own", "projects");
      for (const dir of [providerHome, own, other, otherAgent]) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(own, "session.jsonl"), "own");
      await fs.writeFile(path.join(other, "session.jsonl"), "other");
      await fs.writeFile(path.join(otherAgent, "session.jsonl"), "other agent");
      await fs.symlink(own, path.join(providerHome, "projects"));

      await execute(buildContext({
        engine: "cli",
        managedAiConnection: { provider: "anthropic", method: "subscription" },
        env: { CLAUDE_CONFIG_DIR: providerHome },
        filesystemScope: "workspace",
      }, { managedAiTranscriptDir: own }) as never);
      const sandbox = runAdapterExecutionTargetProcess.mock.calls
        .map((call) => (call as unknown[])[4] as { localProcessSandbox?: LocalProcessSandboxOptions })
        .find((options) => options?.localProcessSandbox)!.localProcessSandbox!;
      const read = (file: string) =>
        `try{process.stdout.write(require("fs").readFileSync(${JSON.stringify(file)},"utf8"))}catch(e){process.stdout.write(e.code)}`;
      const target = await buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", `${read(path.join(providerHome, "projects", "session.jsonl"))};process.stdout.write("|");${read(path.join(other, "session.jsonl"))};process.stdout.write("|");${read(path.join(otherAgent, "session.jsonl"))}`],
        cwd: sandbox.workspaceDir,
        options: sandbox,
      });
      try {
        const output = execFileSync(target.command, target.args, { cwd: target.cwd, env: { ...process.env, ...target.env }, encoding: "utf8" });
        expect(output).toBe("own|ENOENT|ENOENT");
      } finally {
        await target.cleanup?.();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("makes the selected skill available in the isolated managed Claude user directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const source = path.join(root, "source");
      const configDir = path.join(root, "provider");
      await mkdir(source); await mkdir(configDir);
      await writeFile(path.join(source, "SKILL.md"), "---\nname: probe-skill\ndescription: Test skill\n---\nExpected contents\n");
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await execute(ctx as never);
      expect(await readFile(path.join(configDir, "skills", "probe-skill", "SKILL.md"), "utf8")).toContain("Expected contents");
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      const args = calls[0]![3];
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refreshes a Paperclip-owned skill in a retained managed home on a later run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const source = path.join(root, "source"); const configDir = path.join(root, "provider");
      await mkdir(source); await mkdir(configDir);
      await writeFile(path.join(source, "SKILL.md"), "first");
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await execute(ctx as never);
      await writeFile(path.join(source, "SKILL.md"), "second");
      await execute(ctx as never);
      expect(await readFile(path.join(configDir, "skills", "probe-skill", "SKILL.md"), "utf8")).toBe("second");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not write selected skills into an explicitly configured Claude directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-user-home-test-"));
    try {
      const source = path.join(root, "source"); const configDir = path.join(root, "custom");
      await mkdir(source); await mkdir(configDir);
      await writeFile(path.join(source, "SKILL.md"), "test");
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, managedAiHomeOverrides: { claudeConfigDir: true },
        env: { CLAUDE_CONFIG_DIR: configDir }, paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await execute(ctx as never);
      expect(await fs.stat(path.join(configDir, "skills")).then(() => true, () => false)).toBe(false);
      expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not overwrite an existing managed skill", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const source = path.join(root, "source");
      const configDir = path.join(root, "provider");
      const existing = path.join(configDir, "skills", "probe-skill");
      await mkdir(source);
      await mkdir(existing, { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "new");
      await writeFile(path.join(existing, "SKILL.md"), "existing");
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await execute(ctx as never);
      expect(await readFile(path.join(existing, "SKILL.md"), "utf8")).toBe("existing");
      expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("loads project settings only when the prepared workspace explicitly permits it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const configDir = path.join(root, "provider");
      await mkdir(configDir);
      const ctx = buildContext({ engine: "cli", managedAiConnection: { provider: "anthropic" }, env: {
        CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: "https://trusted.invalid", ANTHROPIC_API_KEY: "synthetic-key",
      },
        paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } });
      ctx.context = { paperclipWorkspace: { claudeProjectSettingsAllowed: true } };
      let settingsPath = "";
      const implementation = runAdapterExecutionTargetProcess.getMockImplementation()!;
      runAdapterExecutionTargetProcess.mockImplementationOnce((async (...args: unknown[]) => {
        const cliArgs = args[3] as string[];
        settingsPath = cliArgs[cliArgs.indexOf("--settings") + 1]!;
        const protectedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
        expect(protectedSettings.env.ANTHROPIC_BASE_URL).toBe("https://trusted.invalid");
        expect(protectedSettings.env.ANTHROPIC_API_KEY).toBe("synthetic-key");
        expect(protectedSettings.apiKeyHelper).toBe("");
        return implementation();
      }) as never);
      await execute(ctx as never);
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      const args = calls[0]![3];
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project");
      expect(await stat(settingsPath).then(() => true, () => false)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([[true, false], [false, true]])("starts a fresh session when project trust changes from %s to %s", async (before, after) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const configDir = path.join(root, "provider");
      await mkdir(configDir);
      const ctx = buildContext({ engine: "cli", cwd: root, managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } });
      Object.assign(ctx.runtime, { sessionId: "00000000-0000-4000-8000-000000000001", sessionParams: {
        sessionId: "00000000-0000-4000-8000-000000000001", cwd: root, claudeProjectSettingsAllowed: before,
      } });
      ctx.context = { paperclipWorkspace: { claudeProjectSettingsAllowed: after } };
      await execute(ctx as never);
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      expect(calls[0]![3]).not.toContain("--resume");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([["source-a", "source-b", false], [undefined, "source-a", false], ["source-a", "source-a", true]] as const)("resumes trusted sessions only for the same approved source (%s -> %s)", async (before, after, resume) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const configDir = path.join(root, "provider");
      await mkdir(configDir);
      const transcriptDir = path.join(configDir, "projects", (process.platform === "win32" ? root : await fs.realpath(root)).replace(/[^a-zA-Z0-9-]/g, "-"));
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(path.join(transcriptDir, "00000000-0000-4000-8000-000000000001.jsonl"), `${JSON.stringify({ type: "result", session_id: "00000000-0000-4000-8000-000000000001" })}\n`);
      const ctx = buildContext({ engine: "cli", cwd: root, managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } });
      Object.assign(ctx.runtime, { sessionId: "00000000-0000-4000-8000-000000000001", sessionParams: {
        sessionId: "00000000-0000-4000-8000-000000000001", cwd: root, claudeProjectSettingsAllowed: true, claudeProjectTrustIdentity: before,
        repoUrl: "https://example.invalid/original", repoRef: "main",
      } });
      ctx.context = { paperclipWorkspace: { claudeProjectSettingsAllowed: true, claudeProjectTrustIdentity: after,
        repoUrl: before === after ? "https://example.invalid/original" : "https://example.invalid/replacement", repoRef: before === after ? "main" : "changed" } };
      const result = await execute(ctx as never);
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      expect(calls[0]![3].includes("--resume")).toBe(resume);
      expect(sessionCodec.deserialize(sessionCodec.serialize(result.sessionParams ?? null))).toMatchObject({ claudeProjectTrustIdentity: after });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves project trust in saved Claude session parameters", () => {
    const params = { sessionId: "00000000-0000-4000-8000-000000000001", claudeProjectSettingsAllowed: true };
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toMatchObject(params);
  });

  it("refuses to write skills into a non-managed Claude configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-unmanaged-test-"));
    try {
      const source = path.join(root, "source");
      const configDir = path.join(root, "provider");
      await mkdir(source);
      await mkdir(configDir);
      await writeFile(path.join(source, "SKILL.md"), "test");
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await execute(ctx as never);
      expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();
      expect(await fs.stat(path.join(configDir, "skills")).then(() => true, () => false)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
