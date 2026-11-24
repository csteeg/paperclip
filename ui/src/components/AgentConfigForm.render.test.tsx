// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment } from "@paperclipai/shared";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm } from "./AgentConfigForm";
import { isBlockedFromReplay } from "@/lib/analytics/replay-recording.test-utils";
import { ApiError } from "../api/client";
import { CodexLocalConfigFields } from "../adapters/codex-local/config-fields";
import type { AdapterConfigFieldsProps } from "../adapters/types";

const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
  qualifyRunner: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  probe: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listProposals: vi.fn(),
  listUserSecretDefinitions: vi.fn(async () => [] as unknown[]),
}));

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(async () => [{ type: "codex_local", supportedRunners: ["legacy", "paperclip"], defaultRunner: "legacy" }]),
}));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/grokBot", () => ({
  grokBotApi: { connection: async () => ({ enabled: true, canConfigureConnection: true, binding: null }) },
}));
vi.mock("../api/adapters", () => ({ adaptersApi: mockAdaptersApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "CO" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "CO" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));
vi.mock("../adapters", () => ({
  getUIAdapter: (type: string) => ({
    type,
    label: "Codex",
    ConfigFields: (props: AdapterConfigFieldsProps) =>
      type === "paperclip_runner" ? <CodexLocalConfigFields {...props} /> : <div data-testid="adapter-config-fields" />,
    buildAdapterConfig: (values: { model?: string }) => ({ model: values.model || undefined }),
    parseStdoutLine: () => [],
  }),
}));
vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
    supportsAcp: true,
    login: { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" },
  }),
}));
vi.mock("../adapters/use-disabled-adapters", () => ({ useDisabledAdaptersSync: () => [] }));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
    <textarea aria-label={placeholder ?? "Markdown"} value={value} onChange={(event) => onChange(event.currentTarget.value)} />
  ),
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    role: "Engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function daytonaEnvironments() {
  return [
    makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    makeEnvironment({
      id: "sandbox-1",
      name: "Daytona",
      driver: "sandbox",
      config: { provider: "daytona" },
    }),
  ];
}

function e2bEnvironments() {
  return [
    makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    makeEnvironment({
      id: "sandbox-1",
      name: "E2B",
      driver: "sandbox",
      config: { provider: "e2b" },
    }),
  ];
}

function renderFormView(root: Root, queryClient: QueryClient, children: Parameters<Root["render"]>[0], wrapRouter = false) {
  root.render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <TooltipProvider>{wrapRouter ? <MemoryRouter>{children}</MemoryRouter> : children}</TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function createFormQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
  options: {
    showAdapterTestEnvironmentButton?: boolean;
    showAdapterTypeField?: boolean;
    compactTestFeedback?: boolean;
    hiddenSections?: readonly string[];
    sectionLayout?: "panels";
    content?: "configuration" | "secrets";
    environmentVariablesPlacement?: "configuration" | "secrets";
    hideInlineSave?: boolean;
    wrapRouter?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    onSaveActionChange?: (save: (() => void) | null) => void;
    onCancelActionChange?: (cancel: (() => void) | null) => void;
    cloud?: boolean;
  } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  const queryClient = createFormQueryClient();
  if (options.cloud) queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true, availableHarnesses: sampleHarnesses } });

  await act(async () => {
    renderFormView(root, queryClient,
      <AgentConfigForm
        mode="edit"
        agent={makeAgent(agentOverrides)}
        onSave={onSave}
        hidePromptTemplate
        compactTestFeedback={options.compactTestFeedback}
        hiddenSections={options.hiddenSections}
        sectionLayout={options.sectionLayout}
        content={options.content}
        environmentVariablesPlacement={options.environmentVariablesPlacement}
        hideInlineSave={options.hideInlineSave}
        onDirtyChange={options.onDirtyChange}
        onSaveActionChange={options.onSaveActionChange}
        onCancelActionChange={options.onCancelActionChange}
        showAdapterTypeField={options.showAdapterTypeField ?? false}
        showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
      />, options.wrapRouter
    );
  });

  await flushReact();
  return { container, root, onSave };
}

async function renderCreateForm(
  environments: Environment[],
  valueOverrides: Partial<typeof defaultCreateValues> = {},
  options: { showAdapterTestEnvironmentButton?: boolean } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createFormQueryClient();

  const values = {
    ...defaultCreateValues,
    adapterType: "codex_local",
    ...valueOverrides,
  };
  const onChange = vi.fn();

  await act(async () => {
    renderFormView(root, queryClient,
      <AgentConfigForm
        mode="create"
        values={values}
        onChange={onChange}
        hidePromptTemplate
        showAdapterTypeField={false}
        showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
      />
    );
  });

  await flushReact();
  return { container, root, onChange };
}

const AUTH_MISSING_RESULT = {
  adapterType: "codex_local",
  status: "fail",
  checks: [{ code: "adapter_auth_missing", level: "error", message: "The sandbox has no ready authentication." }],
  testedAt: new Date(0).toISOString(),
};

const SANDBOX_CAPABILITIES = getEnvironmentCapabilities(["claude_local", "codex_local"], {
  sandboxProviders: { daytona: { supportsLoginPty: true, displayName: "Daytona" } },
});

function noActiveSession() {
  return Promise.reject(
    new ApiError("Adapter login session not found", 404, { error: "Adapter login session not found" }),
  );
}

async function clickByText(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

describe("AgentConfigForm session replay masking", () => {
  let roots: Root[] = [];

  it("keeps Claude execution policies reachable in the runtime panel", async () => {
    const result = await renderForm([], { adapterType: "claude_local", adapterConfig: { engine: "cli", timeoutSec: 42 } }, { sectionLayout: "panels", hiddenSections: ["identity", "run-policy"] });
    roots.push(result.root);
    const panel = result.container.querySelector('[data-config-section="configuration"]')!;
    const disclosure = [...panel.querySelectorAll("button")].find(button => button.textContent?.trim() === "Advanced Run Policy");
    expect(disclosure).toBeTruthy();
    await act(async () => disclosure!.click()); await flushReact();
    expect(panel.querySelector<HTMLInputElement>('[aria-label="Timeout (sec)"]')?.value).toBe("42");
    expect(result.container.querySelector('[data-config-section="run-policy"]')).toBeNull();
  });

  it("edits the shared Pool binding without exposing a direct account or model", async () => {
    const { harnessPoolsApi } = await import("../api/harness-pools");
    const list = vi.spyOn(harnessPoolsApi, "choices").mockResolvedValue([
      { id: "smart", revision: 1, name: "Smart", enabled: true },
      { id: "mid", revision: 1, name: "Mid", enabled: true },
    ]);
    try {
      const edited = await renderForm([], { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "inactive" }, runtimeConfig: { harnessPool: { poolId: "smart" } } }, { showAdapterTypeField: true, wrapRouter: true });
      roots.push(edited.root);
      expect(edited.container.querySelector('[aria-label="Harness"]')?.textContent).toContain("Pool");
      expect(edited.container.querySelector('[aria-label="Harness pool"]')).not.toBeNull();
      expect(edited.container.textContent).toContain("Runners, models and accounts come from the pool.");
      expect(edited.container.querySelector('[aria-label="Connection"]')).toBeNull();
      expect(edited.container.querySelector('[aria-label="Model"]')).toBeNull();
      await act(async () => { const select = edited.container.querySelector<HTMLSelectElement>('[aria-label="Harness pool"]')!; select.value = "mid"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      await clickByText(edited.container, "Save");
      expect(edited.onSave).toHaveBeenCalledWith(expect.objectContaining({ runtimeConfig: expect.objectContaining({ harnessPool: { poolId: "mid" } }) }));
    } finally { list.mockRestore(); }
  });

  it.each(["shared-pool", "legacy-router", "both"])("saves a direct account after leaving %s without restoring its pool", async savedBinding => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const { harnessPoolsApi } = await import("../api/harness-pools");
    const pools = vi.spyOn(harnessPoolsApi, "choices").mockResolvedValue([{ id: "smart", revision: 1, name: "Smart", enabled: true }]);
    const accounts = vi.spyOn(aiConnectionsApi, "list").mockResolvedValue({ currentUserId: "you", canManageConnections: true, connections: [{
      id: "78306e75-506c-4240-981e-31d8508e33f2", grantId: "93587692-5e38-433e-bc06-7b98957009b2", companyId: "company-1", provider: "openai", method: "subscription", name: "Direct Codex",
      ownership: "shared", isDefault: false, status: "connected",
    }] });
    try {
      const edited = await renderForm([], { adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: {
        ...(savedBinding !== "legacy-router" ? { harnessPool: { poolId: "smart" } } : {}),
        ...(savedBinding !== "shared-pool" ? { aiConnection: { mode: "router", connectionId: "a8d3a9a3-9866-49d8-93d6-c497ae090d05" } } : {}),
        heartbeat: { enabled: true, intervalSec: 300 }, debug: { diagnostic: true },
      } }, { showAdapterTypeField: true, wrapRouter: true });
      roots.push(edited.root);
      if (savedBinding === "legacy-router") {
        const routing = Array.from(edited.container.querySelectorAll("select")).find(select => select.textContent?.includes("Individual account"))!;
        await act(async () => { routing.value = ""; routing.dispatchEvent(new Event("change", { bubbles: true })); });
      } else {
        await clickElement(edited.container.querySelector('[aria-label="Harness"]'));
        await clickElement(document.querySelector('[role="option"][data-value="codex_local"]'));
      }
      await flushReact();
      const adoption = findButton(edited.container, "Choose a managed connection");
      if (adoption) await clickElement(adoption);
      // Legacy router bindings must also stop hiding the direct account picker.
      const connection = edited.container.querySelector('[aria-label="Connection"]');
      expect(connection).not.toBeNull();
      await act(async () => { connection!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
      await flushReact();
      await clickElement(Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.textContent?.includes("Direct Codex")) ?? null);
      await flushReact();
      const adopt = findButton(document.body, "Use this binding when saved");
      if (adopt) await clickElement(adopt);
      await clickByText(edited.container, "Save");
      const patch = edited.onSave.mock.calls[0]?.[0];
      expect(JSON.parse(JSON.stringify(patch.runtimeConfig))).toEqual({
        aiConnection: { mode: "shared", provider: "openai", method: "subscription", connectionId: "78306e75-506c-4240-981e-31d8508e33f2", grantId: "93587692-5e38-433e-bc06-7b98957009b2" },
        heartbeat: { enabled: true, intervalSec: 300 }, debug: { diagnostic: true },
      });
    } finally { pools.mockRestore(); accounts.mockRestore(); }
  });

  it.each(["paperclip_runner", "codex_local"])("restores the saved %s Codex draft after a harness round trip", async adapterType => {
    const dirty = vi.fn();
    const adapterConfig = adapterType === "paperclip_runner"
      ? {provider:"codex",model:"saved-codex-model",reasoningEffort:"high",timeoutSec:37}
      : {engine:"cli",model:"saved-codex-model",search:true,fastMode:true,timeoutSec:37};
    const result = await renderForm([], {adapterType,adapterConfig,runtimeConfig:{aiConnection:{mode:"responsible_user",provider:"openai",method:"subscription"}}}, {showAdapterTypeField:true,onDirtyChange:dirty}); roots.push(result.root);
    const modelBefore = result.container.querySelector('[aria-label="Model"]')!.textContent;
    const hasEngineBefore = Boolean(result.container.querySelector('[aria-label="Execution engine"]'));
    for (const choice of ["claude_local","codex_local"]) {
      await clickElement(result.container.querySelector('[aria-label="Harness"]'));
      const option = document.querySelector(`[role="option"][data-value="${choice}"]`);expect(option).toBeTruthy();
      await clickElement(option);await flushReact();
    }
    expect(result.container.querySelector('[aria-label="Model"]')!.textContent).toBe(modelBefore);
    expect(Boolean(result.container.querySelector('[aria-label="Execution engine"]'))).toBe(hasEngineBefore);
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(result.onSave).not.toHaveBeenCalled();
  });

  it("keeps an edited Codex draft and account when returning from another harness", async () => {
    let save: (() => void) | null = null;
    const binding = {mode:"responsible_user",provider:"openai",method:"subscription"} as const;
    const result = await renderForm([], {adapterType:"codex_local",adapterConfig:{engine:"cli",model:DEFAULT_CODEX_LOCAL_MODEL,modelReasoningEffort:"high"},runtimeConfig:{aiConnection:binding}}, {showAdapterTypeField:true,onSaveActionChange:action=>{save=action;}}); roots.push(result.root);
    await clickElement(result.container.querySelector('[aria-label="Thinking effort"]'));
    const low=document.querySelector('[role="option"][data-value="low"]');expect(low).toBeTruthy();await clickElement(low);
    for (const choice of ["claude_local","codex_local"]) {
      await clickElement(result.container.querySelector('[aria-label="Harness"]'));
      const option=document.querySelector(`[role="option"][data-value="${choice}"]`);expect(option).toBeTruthy();await clickElement(option);
    }
    expect(result.container.querySelector('[aria-label="Thinking effort"]')?.textContent).toContain("Low");
    expect(save).toBeTypeOf("function");await act(async()=>save!());
    expect(result.onSave).toHaveBeenCalledWith({replaceAdapterConfig:true,adapterConfig:expect.objectContaining({engine:"cli",model:DEFAULT_CODEX_LOCAL_MODEL,modelReasoningEffort:"low"})});
  });

  it.each(["grok_local", "cursor_cloud"])("preserves the native runner when switching Codex to %s", async target => {
    mockAdaptersApi.list.mockResolvedValue([
      {type:"codex_local",supportedRunners:["legacy","paperclip"],defaultRunner:"legacy"},
      {type:target,supportedRunners:["legacy","paperclip"],defaultRunner:"legacy"},
    ]);
    const result=await renderForm([], {adapterType:"paperclip_runner",adapterConfig:{provider:"codex",model:DEFAULT_CODEX_LOCAL_MODEL}}, {showAdapterTypeField:true});roots.push(result.root);
    await clickElement(result.container.querySelector('[aria-label="Harness"]'));
    const option=document.querySelector(`[role="option"][data-value="${target}"]`);expect(option).toBeTruthy();await clickElement(option);
    await clickByText(result.container,"Save");
    expect(result.onSave).toHaveBeenCalledWith(expect.objectContaining({adapterType:target,runner:"paperclip"}));
  });

  it("drops cached harness drafts when the operator discards changes", async () => {
    let discard: (() => void) | null = null;
    const result = await renderForm([], {adapterType:"codex_local",adapterConfig:{engine:"cli",model:"saved-codex-model"}}, {showAdapterTypeField:true,onCancelActionChange:action=>{discard=action;}});roots.push(result.root);
    const choose = async (choice:string) => {
      await clickElement(result.container.querySelector('[aria-label="Harness"]'));
      await clickElement(document.querySelector(`[role="option"][data-value="${choice}"]`));
    };
    await choose("claude_local");
    const permission = () => result.container.querySelector('[aria-label="Skip permissions"]')!;
    expect(permission().getAttribute("aria-checked")).toBe("true");await clickElement(permission());
    expect(permission().getAttribute("aria-checked")).toBe("false");
    await choose("codex_local");await choose("claude_local");
    expect(permission().getAttribute("aria-checked")).toBe("false");
    await act(async()=>discard!());await flushReact();
    await choose("claude_local");expect(permission().getAttribute("aria-checked")).toBe("true");
    expect(result.onSave).not.toHaveBeenCalled();
  });

  it.each([
    ["paperclip_runner", "claude_local"], ["paperclip_runner", "pool"],
    ["codex_local", "claude_local"], ["codex_local", "pool"],
  ])("restores the saved %s Codex draft after switching through %s", async (adapterType, intermediate) => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const { harnessPoolsApi } = await import("../api/harness-pools");
    const pools = vi.spyOn(harnessPoolsApi, "choices").mockResolvedValue([]);
    const dirty = vi.fn();
    const adapterConfig = adapterType === "paperclip_runner"
      ? { provider:"codex", model:"gpt-6.1-sol", reasoningEffort:"high", timeoutSec:37 }
      : { engine:"cli", model:"gpt-6.1-sol", search:true, fastMode:true, timeoutSec:37 };
    try {
      const result = await renderForm([], { adapterType, adapterConfig, runtimeConfig:{aiConnection:{mode:"responsible_user",provider:"openai",method:"subscription"}} }, {showAdapterTypeField:true,wrapRouter:true,onDirtyChange:dirty});roots.push(result.root);
      const configuration = () => result.container.querySelector('[data-config-section="configuration"]')!.textContent;
      const original = configuration();
      for (const choice of [intermediate,"codex_local"]) {
        await clickElement(result.container.querySelector('[aria-label="Harness"]'));
        await clickElement(document.querySelector(`[role="option"][data-value="${choice}"]`));await flushReact();
      }
      expect(configuration()).toBe(original);
      expect(dirty).toHaveBeenLastCalledWith(false);
      expect(result.onSave).not.toHaveBeenCalled();
    }finally{pools.mockRestore();}
  });

  it.each(["codex_local", "claude_local"])("selects a pool from a directly configured %s agent without losing policy or workspace", async adapterType => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const { harnessPoolsApi } = await import("../api/harness-pools");
    const pools = vi.spyOn(harnessPoolsApi, "choices").mockResolvedValue([{ id: "chosen", name: "Claude first", revision: 1, enabled: true }]);
    const source = { engine: "cli", cwd: "/existing-workspace", instructionsFilePath: "/agent/AGENTS.md", ...(adapterType === "codex_local" ? { dangerouslyBypassApprovalsAndSandbox: false } : { dangerouslySkipPermissions: true }) };
    try {
      const result = await renderForm([], { adapterType, adapterConfig: source, runtimeConfig: { aiConnection: { mode: "responsible_user", provider: adapterType === "codex_local" ? "openai" : "anthropic", method: "subscription" } } }, { showAdapterTypeField: true, wrapRouter: true }); roots.push(result.root);
      await clickElement(result.container.querySelector('[aria-label="Harness"]'));
      const pool = document.querySelector('[role="option"][data-value="pool"]'); expect(pool).toBeTruthy(); await clickElement(pool); await flushReact();
      expect(result.onSave).not.toHaveBeenCalled();
      const choice = result.container.querySelector<HTMLSelectElement>('[aria-label="Harness pool"]')!; expect(choice).toBeTruthy();
      expect(result.container.querySelector('[aria-label="Connection"]')).toBeNull();
      await act(async () => { choice.value = "chosen"; choice.dispatchEvent(new Event("change", { bubbles: true })); }); await clickByText(result.container, "Save");
      expect(result.onSave).toHaveBeenCalledWith(expect.objectContaining({ adapterType: "paperclip_runner", runner: "paperclip", adapterConfig: expect.objectContaining({ ...source, provider: adapterType === "codex_local" ? "codex" : "acpx" }), runtimeConfig: expect.objectContaining({ aiConnection: undefined, harnessPool: { poolId: "chosen" } }) }));
    } finally { pools.mockRestore(); }
  });

  it.each([
    ["claude_local", { dangerouslySkipPermissions: false }],
    ["claude_local", { permissionMode: "deny-all" }],
    ["opencode_local", { model: "openrouter/deepseek/deepseek-v4-flash-0731", dangerouslySkipPermissions: false }],
  ] as const)("refuses Pool for a %s agent whose local permission rules Runner cannot keep: %j", async (adapterType, policy) => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const result = await renderForm([], { adapterType, adapterConfig: { cwd: "/existing-workspace", ...policy } }, { showAdapterTypeField: true, wrapRouter: true }); roots.push(result.root);
    await clickElement(result.container.querySelector('[aria-label="Harness"]'));
    await clickElement(document.querySelector('[role="option"][data-value="pool"]')); await flushReact();
    expect(result.container.querySelector('[aria-label="Harness pool"]')).toBeNull();
    expect(result.container.querySelector('[role="alert"]')?.textContent).toContain("Pool cannot keep this harness's local permission rules");
    expect(result.onSave).not.toHaveBeenCalled();
  });

  it("retains the native source policy when selecting Pool", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const { harnessPoolsApi } = await import("../api/harness-pools");
    const list = vi.spyOn(harnessPoolsApi, "choices").mockResolvedValue([{ id: "smart", name: "Smart", revision: 1, enabled: true }]);
    const source = { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5", acpxPermissionMode: "deny-all" };
    try {
      const result = await renderForm([], { adapterType: "paperclip_runner", adapterConfig: source, runtimeConfig: {} }, { showAdapterTypeField: true, wrapRouter: true }); roots.push(result.root);
      await clickElement(result.container.querySelector('[aria-label="Harness"]'));
      await clickElement(document.querySelector('[role="option"][data-value="pool"]'));
      await flushReact();
      await act(async () => { const select = result.container.querySelector<HTMLSelectElement>('[aria-label="Harness pool"]')!; select.value = "smart"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      await clickByText(result.container, "Save");
      const patch = result.onSave.mock.calls[0]![0];
      expect(patch.replaceAdapterConfig).toBe(true);
      expect(patch.adapterConfig).toEqual(source);
      expect(patch.runtimeConfig.harnessPool).toEqual({ poolId: "smart" });
    } finally { list.mockRestore(); }
  });

  it.each([false, true])("gates Pool separately from concrete harnesses when enableNativeRunner is %s", async enabled => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: enabled });
    const result = await renderForm([], { adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } }, { showAdapterTypeField: true });
    roots.push(result.root);
    await clickElement(result.container.querySelector('[aria-label="Harness"]'));
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.some(element => element.getAttribute("data-value") === "pool")).toBe(enabled);
    expect(options.some(element => element.getAttribute("data-value") === "paperclip_runner")).toBe(false);
  });

  beforeEach(() => {
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({ id: "sandbox-1", name: "Daytona", driver: "sandbox", config: { provider: "daytona" } }),
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue(AUTH_MISSING_RESULT);
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(noActiveSession);
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(noActiveSession);
    mockAgentsApi.startAdapterAuthLogin.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
      prompt: { url: "https://auth.example.test/device", code: "WXYZ-1234" },
    });
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => root.unmount());
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it.each([
    ["Codex", "codex_local"],
    ["Claude Code", "claude_local"],
  ])("clears OpenCode model settings when choosing %s while preserving the Paperclip runner", async (_label, adapterType) => {
    const accountList = vi.spyOn(aiConnectionsApi, "list").mockResolvedValue({
      currentUserId: "you",
      canManageConnections: true,
      connections: [],
    });
    try {
      const result = await renderForm([], {
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.6" },
        runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "openrouter", method: "api_key" } },
      }, { showAdapterTypeField: true });
      roots.push(result.root);
      await clickElement(result.container.querySelector('[aria-label="Harness"]'));
      await flushReact();
      const option = document.querySelector<HTMLElement>(`[role="option"][data-value="${adapterType}"]`);
      expect(option).toBeTruthy();
      await clickElement(option);
      await flushReact();
      await clickByText(result.container, "Save");
      expect(result.onSave).toHaveBeenCalledWith(expect.objectContaining({
        adapterType,
        runner: "paperclip",
        replaceAdapterConfig: true,
        adapterConfig: expect.objectContaining({ model: "" }),
      }));
    } finally {
      accountList.mockRestore();
    }
  });

  it("requests Codex models for the selected account", async () => {
    const binding = { provider: "openai", method: "subscription", mode: "responsible_user" } as const;
    const accounts = vi.spyOn(aiConnectionsApi, "list").mockResolvedValue({ currentUserId: "you", canManageConnections: true, connections: [{
      id: "codex-account", grantId: "codex-grant", companyId: "company-1", provider: "openai", method: "subscription", name: "Codex",
      ownership: "personal", ownerUserId: "you", isDefault: true, status: "connected",
    }] });
    mockAgentsApi.adapterModels.mockResolvedValue([{ id: "gpt-6.1-terra", label: "Terra" }]);
    try {
      const result = await renderForm([makeEnvironment({ id: "local-1", name: "Local", driver: "local" })], {
        adapterType: "codex_local", adapterConfig: { model: "gpt-6.1-terra" }, runtimeConfig: { aiConnection: binding },
      });
      roots.push(result.root);
      await vi.waitFor(() => expect(mockAgentsApi.adapterModels).toHaveBeenCalledWith("company-1", "codex_local", expect.objectContaining({ aiConnection: binding, agentId: "agent-1" })));
      expect(result.container.textContent).toContain("Terra");
    } finally { accounts.mockRestore(); }
  });

  it("blocks the displayed login code from session replay", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TooltipProvider>
              <AgentConfigForm
                mode="edit"
                agent={makeAgent({ defaultEnvironmentId: "sandbox-1" })}
                onSave={vi.fn()}
                hidePromptTemplate
                showAdapterTypeField={false}
                showAdapterTestEnvironmentButton
              />
            </TooltipProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await clickByText(container, "Test");
    await clickByText(container, "Sign in");
    await flushReact();

    expect(isBlockedFromReplay("WXYZ-1234", document.body)).toBe(true);
  });
});
