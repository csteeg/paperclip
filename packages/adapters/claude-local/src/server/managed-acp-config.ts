import path from "node:path";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { prepareManagedClaudePluginRuntime } from "./claude-config.js";

/** Applies imported profile assets to a managed, local ACP invocation. */
export async function prepareManagedClaudeAcpConfig(input: {
  configEnv: unknown;
  managedAiHomeOverrides: unknown;
  processEnv: NodeJS.ProcessEnv;
  companyId: string;
  agentId: string;
  runId: string;
}): Promise<{ env: Record<string, unknown>; importMessage?: string }> {
  const env = parseObject(input.configEnv);
  const configDir = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR : "";
  const managedHomeOverrides = parseObject(input.managedAiHomeOverrides);
  const hasExplicitConfigDir = managedHomeOverrides.claudeConfigDir === true;
  const rawImportMode = typeof env.PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE === "string"
    ? env.PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE.trim().toLowerCase()
    : "off";
  if (!["off", "copy", "cache"].includes(rawImportMode)) {
    throw new Error("PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE must be off, copy, or cache");
  }
  const importMode = rawImportMode as "off" | "copy" | "cache";
  if (importMode !== "off" && hasExplicitConfigDir) {
    throw new Error(
      "Claude profile import cannot write into an explicitly configured CLAUDE_CONFIG_DIR. Disable profile import or remove the config directory override.",
    );
  }
  if (importMode === "copy" && managedHomeOverrides.home === true) {
    throw new Error("Claude profile copy mode requires Paperclip's temporary HOME. Choose cache mode or clear the HOME override.");
  }
  const managedPlugins = importMode === "off"
    ? { pluginRoot: null, skillCount: 0 }
    : await prepareManagedClaudePluginRuntime({
        env: input.processEnv,
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        configDir,
        sourceDir: typeof env.PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR === "string"
          ? env.PAPERCLIP_CLAUDE_PLUGIN_SOURCE_DIR
          : undefined,
        autoDiscoverSource: true,
        importMode,
      });

  return {
    env: {
      ...env,
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      CLAUDE_CODE_PLUGIN_CACHE_DIR: managedPlugins.pluginRoot ?? path.join(configDir, "plugins"),
    },
    ...(managedPlugins.pluginRoot || managedPlugins.skillCount > 0
      ? { importMessage: `[paperclip] Imported ${managedPlugins.skillCount} personal Claude skills using ${importMode} mode for local ACP.\n` }
      : {}),
  };
}
