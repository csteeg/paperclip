import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

function buildContext(config: Record<string, unknown> = {}) {
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
    context: {},
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

  it("keeps a selected Paperclip skill ahead of a same-named imported profile skill", async () => {
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
      vi.stubEnv("PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR", sourceDir);
      const ctx = buildContext({
        engine: "cli",
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

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
