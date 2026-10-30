import { describe, expect, it, vi } from "vitest";

const { prepareManagedClaudePluginRuntime } = vi.hoisted(() => ({
  prepareManagedClaudePluginRuntime: vi.fn(async () => ({ pluginRoot: null, skillCount: 0 })),
}));

vi.mock("./claude-config.js", () => ({ prepareManagedClaudePluginRuntime }));

import { prepareManagedClaudeAcpConfig } from "./managed-acp-config.js";

describe("prepareManagedClaudeAcpConfig", () => {
  it("preserves Paperclip's default ACP environment when profile import is off", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: "C:/managed/provider",
      CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/existing/plugin-cache",
    };

    const result = await prepareManagedClaudeAcpConfig({
      configEnv: env,
      managedAiHomeOverrides: {},
      processEnv: {},
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result.env).toEqual(env);
    expect(prepareManagedClaudePluginRuntime).not.toHaveBeenCalled();
  });

  it("excludes skills already selected by Paperclip from imported personal skills", async () => {
    prepareManagedClaudePluginRuntime.mockClear();

    await prepareManagedClaudeAcpConfig({
      configEnv: {
        CLAUDE_CONFIG_DIR: "C:/managed/provider",
        PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "cache",
      },
      managedAiHomeOverrides: {},
      processEnv: {},
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      excludedSkillNames: ["careconnections"],
    });

    expect(prepareManagedClaudePluginRuntime).toHaveBeenCalledWith(expect.objectContaining({
      excludedSkillNames: ["careconnections"],
      importMode: "cache",
    }));
  });
});
