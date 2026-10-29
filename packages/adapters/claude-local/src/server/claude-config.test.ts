import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers.
const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
  };
});

import {
  prepareClaudeConfigSeed,
  prepareManagedClaudePluginRuntime,
  prepareSandboxClaudeProbeRuntime,
  resolveManagedClaudeRuntimeStateDir,
} from "./claude-config.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("prepareManagedClaudePluginRuntime", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("imports enabled plugins and skills into per-agent cache without copying credentials or marketplace config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-plugins-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "personal-claude");
    const sourcePlugin = path.join(sourceDir, "plugins", "cache", "superpowers", "superpowers", "1.0.0");
    const sourceSkill = path.join(sourceDir, "skills", "careconnections");
    const sourceGuidance = path.join(sourceDir, "skills", "company-guidance");
    const trashedSkill = path.join(sourceDir, "skills", ".trash", "removed-skill");
    const configDir = path.join(root, "managed-run", "provider");
    await fs.mkdir(sourcePlugin, { recursive: true });
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.mkdir(sourceGuidance, { recursive: true });
    await fs.mkdir(trashedSkill, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(path.join(configDir, "skills", "careconnections"), { recursive: true });
    await fs.writeFile(path.join(configDir, "skills", "careconnections", "SKILL.md"), "Paperclip selected skill\n");
    await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify({
      permissions: { defaultMode: "acceptEdits" },
      enabledPlugins: { "existing@local": true },
      hooks: { PreToolUse: [{ command: "agent-owned-hook" }] },
    }));
    await fs.writeFile(path.join(sourcePlugin, "plugin.js"), "trusted plugin code\n");
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "CareConnections workflow\n");
    await fs.writeFile(path.join(sourceSkill, ".config.json"), '{"profile":"careconnections"}');
    await fs.writeFile(path.join(sourceGuidance, "SKILL.md"), "Company guidance\n");
    await fs.writeFile(path.join(sourceGuidance, ".config.json"), '{"version":1}');
    await fs.writeFile(path.join(trashedSkill, "SKILL.md"), "Removed skill\n");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), '{"token":"must-not-copy"}');
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      enabledPlugins: { "superpowers@superpowers": true, "disabled@market": false },
      hooks: { PreToolUse: [{ command: "personal-hook" }] },
      mcpServers: { personal: { command: "personal-mcp" } },
      extraKnownMarketplaces: { secret: { source: { url: "https://user:secret@example.invalid/plugins" } } },
    }));
    await fs.writeFile(path.join(sourceDir, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "superpowers@superpowers": [{ scope: "user", installPath: sourcePlugin, version: "1.0.0" }] },
    }));

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: path.join(root, "paperclip-data"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR: sourceDir,
    };
    const result = await prepareManagedClaudePluginRuntime({ env, companyId: "company-1", agentId: "agent-1", configDir });

    expect(result.pluginRoot).not.toBeNull();
    expect(result.skillCount).toBe(2);
    await expect(fs.readFile(path.join(result.pluginRoot!, "cache", "superpowers", "superpowers", "1.0.0", "plugin.js"), "utf8"))
      .resolves.toBe("trusted plugin code\n");
    await expect(fs.readFile(path.join(configDir, "skills", "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("Paperclip selected skill\n");
    await expect(fs.readFile(path.join(configDir, "skills", "company-guidance", ".config.json"), "utf8"))
      .resolves.toBe('{"version":1}');
    await expect(fs.access(path.join(configDir, "skills", ".trash")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const settings = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
    expect(settings).toEqual({
      permissions: { defaultMode: "acceptEdits" },
      enabledPlugins: {
        "disabled@market": false,
        "existing@local": true,
        "superpowers@superpowers": true,
      },
      hooks: { PreToolUse: [{ command: "agent-owned-hook" }] },
    });
    const installed = JSON.parse(await fs.readFile(path.join(result.pluginRoot!, "installed_plugins.json"), "utf8"));
    expect(installed.plugins["superpowers@superpowers"][0].installPath)
      .toBe(path.join(result.pluginRoot!, "cache", "superpowers", "superpowers", "1.0.0"));
    expect(JSON.stringify(installed)).not.toContain(sourceDir);
    await expect(fs.access(path.join(result.pluginRoot!, "known_marketplaces.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(configDir, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(sourceDir, ".credentials.json"), "utf8"))
      .resolves.toBe('{"token":"must-not-copy"}');

    const [secondRun, otherAgent] = await Promise.all([
      prepareManagedClaudePluginRuntime({ env, companyId: "company-1", agentId: "agent-1", configDir }),
      prepareManagedClaudePluginRuntime({ env, companyId: "company-1", agentId: "agent-2", configDir: path.join(root, "other-run", "provider") }),
    ]);
    expect(secondRun.pluginRoot).toBe(result.pluginRoot);
    expect(otherAgent.pluginRoot).not.toBe(result.pluginRoot);

    await fs.writeFile(path.join(sourceGuidance, ".config.json"), '{"version":2}');
    const changedRun = await prepareManagedClaudePluginRuntime({
      env,
      companyId: "company-1",
      agentId: "agent-1",
      configDir: path.join(root, "changed-run", "provider"),
    });
    expect(changedRun.pluginRoot).not.toBe(result.pluginRoot);
    await expect(fs.readFile(path.join(root, "changed-run", "provider", "skills", "company-guidance", ".config.json"), "utf8"))
      .resolves.toBe('{"version":2}');
  });

  it("copies the selected profile once per run without modifying the source profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-copy-"));
    cleanupDirs.push(root);
    const serverSource = path.join(root, "server-profile");
    const agentSource = path.join(root, "agent-profile");
    const pluginDir = path.join(agentSource, "plugins", "cache", "trusted", "superpowers", "1.0.0");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(path.join(agentSource, "skills", "careconnections"), { recursive: true });
    await fs.writeFile(path.join(pluginDir, "plugin.js"), "agent-selected payload");
    await fs.writeFile(path.join(agentSource, "skills", "careconnections", "SKILL.md"), "selected profile skill");
    await fs.writeFile(path.join(agentSource, "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@trusted": true } }));
    await fs.writeFile(path.join(agentSource, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "superpowers@trusted": [{ scope: "user", installPath: pluginDir, version: "1.0.0" }] },
    }));
    const env = {
      PAPERCLIP_HOME: path.join(root, "paperclip-data"),
      PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR: serverSource,
    };
    const firstConfig = path.join(root, "runs", "first", "provider");
    const secondConfig = path.join(root, "runs", "second", "provider");
    const first = await prepareManagedClaudePluginRuntime({
      env, companyId: "company-1", agentId: "agent-1", runId: "first-run",
      configDir: firstConfig, sourceDir: agentSource, importMode: "copy",
    });
    const second = await prepareManagedClaudePluginRuntime({
      env, companyId: "company-1", agentId: "agent-1", runId: "second-run",
      configDir: secondConfig, sourceDir: agentSource, importMode: "copy",
    });

    expect(first.pluginRoot).not.toBe(second.pluginRoot);
    expect(first.pluginRoot).toContain(path.join(firstConfig, ".paperclip-profile-import"));
    await expect(fs.readFile(path.join(first.pluginRoot!, "cache", "trusted", "superpowers", "1.0.0", "plugin.js"), "utf8"))
      .resolves.toBe("agent-selected payload");
    await expect(fs.readFile(path.join(firstConfig, "skills", "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("selected profile skill");
    await expect(fs.readFile(path.join(agentSource, "skills", "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("selected profile skill");
    await expect(fs.access(serverSource)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes only imported skills in a persistent managed config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-skill-refresh-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "personal-claude");
    const managedSkill = path.join(sourceDir, "skills", "careconnections");
    const managedScript = path.join(managedSkill, "scripts", "helper.js");
    const removedSkill = path.join(sourceDir, "skills", "retired");
    const targetSkills = path.join(root, "agent-home", "provider", "skills");
    const agentOwnedSkill = path.join(targetSkills, "agent-owned");
    const configDir = path.dirname(targetSkills);
    await fs.mkdir(managedSkill, { recursive: true });
    await fs.mkdir(path.dirname(managedScript), { recursive: true });
    await fs.mkdir(removedSkill, { recursive: true });
    await fs.mkdir(agentOwnedSkill, { recursive: true });
    await fs.writeFile(path.join(managedSkill, "SKILL.md"), "CareConnections v1");
    await fs.writeFile(managedScript, "helper v1");
    await fs.writeFile(path.join(removedSkill, "SKILL.md"), "Retired skill");
    await fs.writeFile(path.join(agentOwnedSkill, "SKILL.md"), "Agent-owned skill");
    const env = { PAPERCLIP_HOME: path.join(root, "paperclip-data") };
    const prepare = () => prepareManagedClaudePluginRuntime({
      env,
      companyId: "company-1",
      agentId: "agent-1",
      configDir,
      sourceDir,
      importMode: "cache",
    });

    await prepare();
    await expect(fs.readFile(path.join(targetSkills, "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("CareConnections v1");
    await expect(fs.readFile(path.join(targetSkills, "careconnections", "scripts", "helper.js"), "utf8"))
      .resolves.toBe("helper v1");

    const manifestDir = path.join(resolveManagedClaudeRuntimeStateDir(env, "company-1", "agent-1"), "managed-plugin-cache", "skill-imports");
    const [manifestName] = await fs.readdir(manifestDir);
    const manifestPath = path.join(manifestDir, manifestName);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.skills.careconnections.complete = false;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.rm(path.join(targetSkills, "careconnections", "scripts", "helper.js"));
    await prepare();
    await expect(fs.readFile(path.join(targetSkills, "careconnections", "scripts", "helper.js"), "utf8"))
      .resolves.toBe("helper v1");

    await fs.writeFile(path.join(targetSkills, "careconnections", "SKILL.md"), "Cached skill remains in place");
    await prepare();
    await expect(fs.readFile(path.join(targetSkills, "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("Cached skill remains in place");

    await fs.writeFile(path.join(managedSkill, "SKILL.md"), "CareConnections v2");
    await fs.rm(removedSkill, { recursive: true, force: true });
    const addedSkill = path.join(sourceDir, "skills", "new-skill");
    await fs.mkdir(addedSkill, { recursive: true });
    await fs.writeFile(path.join(addedSkill, "SKILL.md"), "New skill");

    await prepare();

    await expect(fs.readFile(path.join(targetSkills, "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("CareConnections v2");
    await expect(fs.access(path.join(targetSkills, "retired")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(targetSkills, "new-skill", "SKILL.md"), "utf8"))
      .resolves.toBe("New skill");
    await fs.writeFile(managedScript, "helper v2");
    await prepare();
    await expect(fs.readFile(path.join(targetSkills, "careconnections", "scripts", "helper.js"), "utf8"))
      .resolves.toBe("helper v2");
    await expect(fs.readFile(path.join(agentOwnedSkill, "SKILL.md"), "utf8"))
      .resolves.toBe("Agent-owned skill");
  });

  it("preserves an agent-owned skill symlink that collides with an imported skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-skill-link-"));
    cleanupDirs.push(root);
    const sourceSkill = path.join(root, "personal-claude", "skills", "careconnections");
    const linkedSkill = path.join(root, "agent-owned", "careconnections");
    const configDir = path.join(root, "agent-home", "provider");
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.mkdir(path.dirname(linkedSkill), { recursive: true });
    await fs.mkdir(linkedSkill, { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "Personal skill");
    await fs.writeFile(path.join(linkedSkill, "SKILL.md"), "Agent-owned skill");
    await fs.mkdir(path.join(configDir, "skills"), { recursive: true });
    await fs.symlink(linkedSkill, path.join(configDir, "skills", "careconnections"), "junction");

    await expect(prepareManagedClaudePluginRuntime({
      env: { PAPERCLIP_HOME: path.join(root, "paperclip-data") },
      companyId: "company-1",
      agentId: "agent-1",
      configDir,
      sourceDir: path.join(root, "personal-claude"),
      importMode: "cache",
    })).resolves.toMatchObject({ skillCount: 1 });

    await expect(fs.readFile(path.join(linkedSkill, "SKILL.md"), "utf8"))
      .resolves.toBe("Agent-owned skill");
  }, 10_000);

  it("does not create an empty skills directory when every imported skill is excluded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-excluded-skill-"));
    cleanupDirs.push(root);
    const sourceSkill = path.join(root, "personal-claude", "skills", "careconnections");
    const configDir = path.join(root, "agent-home", "provider");
    await fs.mkdir(sourceSkill, { recursive: true });
    await fs.writeFile(path.join(sourceSkill, "SKILL.md"), "Excluded skill");

    await prepareManagedClaudePluginRuntime({
      env: { PAPERCLIP_HOME: path.join(root, "paperclip-data") },
      companyId: "company-1",
      agentId: "agent-1",
      configDir,
      sourceDir: path.join(root, "personal-claude"),
      importMode: "cache",
      excludedSkillNames: ["careconnections"],
    });

    await expect(fs.access(path.join(configDir, "skills")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-discovers the active Claude config directory when profile import is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-autodiscover-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "signed-in-user-claude");
    const configDir = path.join(root, "managed-run", "provider");
    await fs.mkdir(path.join(sourceDir, "skills", "careconnections"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "skills", "careconnections", "SKILL.md"), "user profile skill");

    const result = await prepareManagedClaudePluginRuntime({
      env: {
        CLAUDE_CONFIG_DIR: sourceDir,
        PAPERCLIP_HOME: path.join(root, "paperclip-data"),
      },
      companyId: "company-1",
      agentId: "agent-1",
      configDir,
      autoDiscoverSource: true,
      importMode: "cache",
    });

    expect(result.skillCount).toBe(1);
    await expect(fs.readFile(path.join(configDir, "skills", "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("user profile skill");
    await expect(fs.readFile(path.join(sourceDir, "skills", "careconnections", "SKILL.md"), "utf8"))
      .resolves.toBe("user profile skill");
  });

  it("skips auto-discovery when the signed-in user's Claude config does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-autodiscover-missing-"));
    cleanupDirs.push(root);
    const result = await prepareManagedClaudePluginRuntime({
      env: {
        CLAUDE_CONFIG_DIR: path.join(root, "missing-profile"),
        PAPERCLIP_HOME: path.join(root, "paperclip-data"),
      },
      companyId: "company-1",
      agentId: "agent-1",
      configDir: path.join(root, "managed-run", "provider"),
      autoDiscoverSource: true,
      importMode: "cache",
    });

    expect(result).toEqual({ pluginRoot: null, skillCount: 0 });
    await expect(fs.access(path.join(root, "paperclip-data"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does nothing when no plugin source is explicitly configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-claude-plugins-optout-"));
    cleanupDirs.push(root);
    const result = await prepareManagedClaudePluginRuntime({
      env: { PAPERCLIP_HOME: path.join(root, "paperclip-data") },
      companyId: "company-1",
      agentId: "agent-1",
      configDir: path.join(root, "managed-run", "provider"),
    });
    expect(result).toEqual({ pluginRoot: null, skillCount: 0 });
    await expect(fs.access(path.join(root, "paperclip-data"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
});
