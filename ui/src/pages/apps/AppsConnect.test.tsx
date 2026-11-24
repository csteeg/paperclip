// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS, GOOGLE_WORKSPACE_CONNECTOR_PROFILES, getAppStoreDefinition, pluginAppDefinition, pluginAppSlug, setPluginAppDefinitions } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RequestOptions } from "@/api/client";
import { aiConnectionsApi } from "@/api/ai-connections";
import { queryKeys } from "@/lib/queryKeys";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { rememberSkillSourceReturn, skillSourceReturnPath } from "@/lib/skill-source-connect-return";
import { AppsConnect } from "./AppsConnect";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "board-user", settled: true, failed: false }), resolveAccountUserId: async () => "board-user" }));

const intentSetupMock = vi.hoisted(() => vi.fn());
const intentPhaseMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("@/api/connection-intents", () => ({ connectionIntentsApi: { setupOptions: intentSetupMock, setPhase: intentPhaseMock } }));

const listGalleryMock = vi.hoisted(() => vi.fn());
const experimentalMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: {
  getExperimental: experimentalMock,
  get: async () => ({ defaultEnvironmentId: "local-env" }),
  getGeneral: async () => ({}),
} }));
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listConnectionGrantsMock = vi.hoisted(() => vi.fn());
const getConnectionMock = vi.hoisted(() => vi.fn());
const getConnectionInstallsMock = vi.hoisted(() => vi.fn());
const connectAppMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const getAwsSetupMock = vi.hoisted(() => vi.fn());
const putConnectionInstallsMock = vi.hoisted(() => vi.fn());
const getCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const startCloudConnectorEnrollmentMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const openAggregatorTaskMock = vi.hoisted(() => vi.fn());
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: openAggregatorTaskMock }) }));
const navigateTopLevelMock = vi.hoisted(() => vi.fn());
const popupAssignMock = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => ({ value: "" }));
const mockParams = vi.hoisted(() => ({ appKey: undefined as string | undefined }));
const mockCompany = vi.hoisted(() => ({
  value: {
    selectedCompanyId: "company-1" as string | undefined,
    selectedCompany: { id: "company-1", name: "Paperclip" } as { id: string; name: string } | null,
  },
}));

const ZAPIER = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "zapier")!;
const GITHUB = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "github")!;
const GITHUB_COPILOT = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "github-copilot")!;
const GITHUB_MANAGED = {
  ...GITHUB,
  ownershipAvailability: {
    ...GITHUB.ownershipAvailability,
    platform_shared: true,
  },
};
const NOTION = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "notion")!;
const ASANA = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "asana")!;
const ASANA_MANAGED = {
  ...ASANA,
  ownershipAvailability: { ...ASANA.ownershipAvailability, platform_shared: true },
};
const BOX = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "box")!;
const AZURE_DEVOPS = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "azure-devops")!;
const POSTHOG = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "posthog")!;
const NEON = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "neon")!;
const SUPERAGENT = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "superagent")!;
const GAUGE = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "gauge")!;
const CIRCLEBACK = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "circleback")!;
const DITTO = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "ditto")!;
const BRAINTRUST = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "braintrust")!;
const POSTMAN = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "postman")!;
const SHOPIFY = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "shopify")!;
const GOOGLE_SHEETS = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-sheets")!;
const GOOGLE_CALENDAR = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-calendar")!;
const GOOGLE_DRIVE = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "google-drive")!;
const GMAIL = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "gmail")!;
const PAGERDUTY = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "pagerduty")!;
const AWS = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "aws")!;

vi.mock("@/api/tools", () => ({
  toolsApi: {
    syncAggregatorApps: vi.fn().mockResolvedValue({ apps: [], sync: { status: "idle" }, discovery: { availability: "available" } }),
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string, options?: RequestOptions) => options ? listApplicationsMock(companyId, options) : listApplicationsMock(companyId),
    listConnections: (companyId: string, options?: RequestOptions) => options ? listConnectionsMock(companyId, options) : listConnectionsMock(companyId),
    listConnectionGrants: (connectionId: string) => listConnectionGrantsMock(connectionId),
    getConnection: (id: string) => getConnectionMock(id),
    getConnectionInstalls: (id: string) => getConnectionInstallsMock(id),
    connectApp: (companyId: string, input: unknown) => connectAppMock(companyId, input),
    getAwsSetup: (connectionId: string, accessLevel?: string) => getAwsSetupMock(connectionId, accessLevel),
    startOAuth: (connectionId: string, input?: unknown) => startOAuthMock(connectionId, input),
    finishApp: (companyId: string, connectionId: string, input: unknown) =>
      finishAppMock(companyId, connectionId, input),
    putConnectionInstalls: (connectionId: string, installs: unknown) =>
      putConnectionInstallsMock(connectionId, installs),
    getCloudConnectorEnrollment: () => getCloudConnectorEnrollmentMock(),
    startCloudConnectorEnrollment: (companyId: string, label?: string, returnTo?: string) =>
      startCloudConnectorEnrollmentMock(companyId, label, returnTo),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: (target: string) => navigateTopLevelMock(target),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockParams,
  useSearchParams: () => [new URLSearchParams(mockSearch.value), vi.fn()],
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompany.value,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function radioContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (button) => button.textContent?.includes(text),
  );
}

/** The wizard stepper's progress dots, one per step. */
function stepDots(): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[data-testid="wizard-step-dot"]'),
  );
}

function stepDotCount(): number {
  return stepDots().length;
}

/** The step names printed under the dots, e.g. "Access   ·   Sign in". */
function stepLabelsOnScreen(): string[] {
  const labelLine =
    document.body.querySelector('[data-testid="wizard-step-labels"]')?.textContent ?? "";
  return labelLine.split("·").map((label) => label.trim()).filter(Boolean);
}

/**
 * Open the Advanced disclosure that now holds the identity and agent-reach
 * controls the Access step used to own (PAP-659 C0). Closed by default and
 * unmounted while closed, so a test that asserts on those controls has to open
 * it first — which is itself the assertion that they are one click away.
 */
async function openAccessAdvanced() {
  const change = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Change"
      && b.getAttribute("aria-expanded") === "false"
      // A pasted MCP server also states its sign-in with a Change link.
      && b.dataset.testid !== "generic-mcp-sign-in-toggle",
  );
  if (!change) return;
  await act(async () => {
    change.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

/**
 * PAP-659 deleted the Access step: picking a connector now opens its connect
 * screen directly, and identity/agent reach are a stated default with an
 * Advanced disclosure rather than a screen to pass.
 *
 * What remains is the one-click handoff the Access step used to perform for
 * automatic-OAuth definitions, which is now the primary action of the sign-in
 * screen itself. Everywhere else this is a no-op, so the call sites keep
 * reading as "get to the part this test is about".
 */
async function passAccessStep() {
  const onOAuthEntryScreen = Boolean(
    document.body.textContent?.includes("Paperclip will open")
      || document.body.textContent?.includes("Your connection is saved."),
  );
  if (onOAuthEntryScreen) {
    const handoff = Array.from(document.body.querySelectorAll("button")).find((b) => {
      const label = b.textContent?.trim() ?? "";
      return label.startsWith("Continue to") || label.startsWith("Finish with");
    });
    await act(async () => {
      handoff?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    return;
  }
  // The remote-MCP aggregator setup (arcade, composio, executor, zapier) keeps
  // its own Access step until PAP-659's no-auth pass replaces it. Recognise it
  // by its own stepper rather than by any control the shared flow also has.
  if (!stepLabelsOnScreen().includes("Access")) {
    await flushReact();
    return;
  }
  const anyAgent = Array.from(document.body.querySelectorAll('[role="radio"]'))
    .find((option) => option.textContent?.includes("Any agent"));
  if (anyAgent) {
    await act(async () => {
      anyAgent.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }
  const submit = Array.from(document.body.querySelectorAll("button")).find((b) => {
    const label = b.textContent?.trim() ?? "";
    return label === "Save and continue" || label === "Continue";
  });
  await act(async () => {
    submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

/** Submit the curated setup screen after Access for OAuth methods that also
 * expose customer-owned client details. Browser sign-in remains the default
 * when the optional client ID is left empty. */
async function submitCuratedOAuthSetup() {
  const submit = buttonByText("Continue to sign in");
  // Automatic OAuth definitions hand off directly from Access. Definitions
  // with required provider configuration still render the setup submit.
  if (!submit) {
    await flushReact();
    return;
  }
  await act(async () => {
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function gotoLinkFrame(container: HTMLDivElement, url: string) {
  const linkInput = Array.from(
    container.querySelectorAll<HTMLInputElement>("input"),
  ).find((i) => i.getAttribute("placeholder")?.startsWith("https://"));
  expect(linkInput).toBeTruthy();
  await act(async () => setInputValue(linkInput!, url));
  await flushReact();
  await act(async () => {
    buttonByText("Continue")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
  await passAccessStep();
}

function notionConnection(id: string, credentialPolicy: string, status: string) {
  return {
    id: id,
    applicationId: "app-notion",
    authKind: "oauth",
    credentialPolicy: credentialPolicy,
    status: status,
    config: { sourceTemplateKey: "notion" },
    transportConfig: {},
  };
}

function notionApplication(status: string) {
  return {
    id: "app-notion",
    status: status,
    metadata: { sourceTemplateKey: "notion" },
  };
}

function oauthStartResponse(connectionId: string, provider: string, authorizationUrl: string) {
  return {
    connectionId: connectionId,
    provider: provider,
    authorizationUrl: authorizationUrl,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function activeConnectorEnrollment() {
  return {
    configured: true,
    status: "active",
    brokerBaseUrl: "https://my-staging.paperclip.app",
    instanceId: "inst-test",
    environment: "staging",
    origins: ["https://paperclip.example.test"],
  };
}

function unconfiguredConnectorEnrollment() {
  return {
    configured: false,
    status: "not_configured",
    brokerBaseUrl: "https://my-staging.paperclip.app",
    instanceId: null,
    environment: "staging",
    origins: [],
  };
}

function customerOwnedApp(app: typeof GMAIL) {
  return {
    ...app,
    methods: app.methods.filter((method) => !method.oauthStrategy),
    ownershipAvailability: { platform_shared: false, customer: true, dcr: true },
  };
}

describe("AppsConnect — Connect with a link (M4 frame)", () => {
  let container: HTMLDivElement;
  let mountedRoot: Root | null;

  beforeEach(() => {
    vi.resetAllMocks();
    popupAssignMock.mockReset();
    vi.spyOn(window, "open").mockReturnValue({ closed: false, location: { assign: popupAssignMock, href: "about:blank" }, focus: vi.fn(), close: vi.fn(), sessionStorage: window.sessionStorage } as unknown as Window);

    experimentalMock.mockResolvedValue({ enableChatConnectors: false });
    window.sessionStorage.clear();
    mockCompany.value = {
      selectedCompanyId: "company-1",
      selectedCompany: { id: "company-1", name: "Paperclip" },
    };
    mockSearch.value = "";
    mockParams.appKey = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    mountedRoot = null;
    listGalleryMock.mockResolvedValue({
      apps: [
        ZAPIER,
        GITHUB,
      ],
      capabilities: {
        canCreateOrganizationGrant: true,
        organizationGrantReason: null,
        canSetCompanyInstall: true,
        companyInstallReason: null,
      },
    });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    getConnectionInstallsMock.mockResolvedValue({ installs: [{ targetType: "company", targetId: "company-1" }] });
    startOAuthMock.mockResolvedValue(oauthStartResponse("conn-notion", "notion", "https://mcp.notion.com/authorize?state=resumed"));
    finishAppMock.mockResolvedValue({});
    putConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    getCloudConnectorEnrollmentMock.mockResolvedValue(activeConnectorEnrollment());
    startCloudConnectorEnrollmentMock.mockResolvedValue({
      configured: false,
      status: "pending",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: "inst-test",
      environment: "staging",
      origins: [],
      verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-test",
    });
    connectAppMock.mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "example.com" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
    });
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Ada", title: "CTO", status: "active", icon: "Bot" },
      { id: "agent-2", name: "Grace", title: "Engineer", status: "active", icon: "Code" },
    ]);
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => mountedRoot?.unmount());
    }
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render(queryClient?: QueryClient, byoOnly = false, content?: ReactNode) {
    const root = createRoot(container);
    mountedRoot = root;
    const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>{content ?? <AppsConnect byoOnly={byoOnly} />}</TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  // -------------------------------------------------------------------------
  // Access step (PAP-17835). Identity and agent reach are chosen before any
  // credential is entered.
  // -------------------------------------------------------------------------

  /**
   * Company-wide is a default, not a restriction. Flexible API-key and OAuth
   * methods must still let the operator deliberately choose a personal identity.
   */

  it("keeps Azure personal by default and offers explicit organization sharing", async () => {
    listGalleryMock.mockResolvedValue({ apps: [AZURE_DEVOPS] });
    mockParams.appKey = "azure-devops";
    await render();
    await openAccessAdvanced();
    expect(radioContaining("Just me")?.getAttribute("aria-checked")).toBe("true");
    const shared = radioContaining("Any human in the organization");
    expect(shared?.getAttribute("aria-checked")).toBe("false");
    expect(shared?.textContent).toContain("Limit it to selected members in the connection permissions after setup");
    await act(async () => shared!.click());
    expect(shared?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers Azure DevOps app registration instructions beside the callback URL", async () => {
    listGalleryMock.mockResolvedValue({
      apps: [{ ...AZURE_DEVOPS, methods: AZURE_DEVOPS.methods.filter((method) => method.key === "entra") }],
      oauthCallbackUrl: "https://paperclip.example.test/api/tools/oauth/callback",
    });
    mockParams.appKey = "azure-devops";
    await render();
    await passAccessStep();

    const details = container.querySelector<HTMLDetailsElement>("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("How to register the app");
    expect(details?.querySelector('a[href^="https://entra.microsoft.com/"]')).toBeTruthy();
    await act(async () => details!.querySelector("summary")!.click());
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain("Application (client) ID");
    expect(container.textContent).toContain("https://paperclip.example.test/api/tools/oauth/callback");
  });

  it("connects GitHub with a PAT without enrolling the instance in Cloud", async () => {
    mockParams.appKey = "github";
    listGalleryMock.mockResolvedValue({ apps: [customerOwnedApp(GITHUB)] });
    getCloudConnectorEnrollmentMock.mockResolvedValue(unconfiguredConnectorEnrollment());

    await render();
    await act(async () => { buttonByText("Use a GitHub personal access token")!.click(); });
    await flushReact();

    expect(container.textContent).not.toContain("Connect with Paperclip");
    const token = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(token).not.toBeNull();
    await act(async () => { setInputValue(token!, "github_pat_test"); });
    await flushReact();
    await act(async () => { buttonByText("Connect")!.click(); });
    await flushReact();

    expect(startCloudConnectorEnrollmentMock).not.toHaveBeenCalled();
    expect(connectAppMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      galleryKey: "github", connectionMethodKey: "mcp-key",
      credentialValues: { "credentials.authorization": "github_pat_test" },
    }));
  });

  it("closes the enrollment popup and ignores a late enrollment response when switching to a PAT", async () => {
    mockParams.appKey = "github";
    listGalleryMock.mockResolvedValue({ apps: [customerOwnedApp(GITHUB)] });
    getCloudConnectorEnrollmentMock.mockResolvedValue(unconfiguredConnectorEnrollment());
    let finishEnrollment!: (value: { verificationUrl: string }) => void;
    startCloudConnectorEnrollmentMock.mockReturnValue(new Promise((resolve) => { finishEnrollment = resolve; }));
    const popup = { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await render();
    await act(async () => { buttonByText("Connect with Paperclip")!.click(); });
    await act(async () => { buttonByText("Use a GitHub personal access token")!.click(); });
    expect(popup.close).toHaveBeenCalledOnce();
    await act(async () => { finishEnrollment({ verificationUrl: "https://my.paperclip.app/connections/enroll?id=test" }); });
    await flushReact();
    expect(popup.location.assign).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("offers a PAT when the managed GitHub profile is unavailable", async () => {
    mockSearch.value = "source=github&stage=setup&cloud_connector=enrolled";
    listGalleryMock.mockResolvedValue({ apps: [customerOwnedApp(GITHUB)] });

    await render();
    expect(container.textContent).toContain("GitHub sign-in is unavailable");
    await act(async () => { buttonByText("Use a GitHub personal access token")!.click(); });
    await flushReact();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(startCloudConnectorEnrollmentMock).not.toHaveBeenCalled();
  });

  it("preserves the chosen GitHub PAT when a pending gallery refresh enables managed sign-in", async () => {
    mockSearch.value = "source=github&stage=setup&cloud_connector=enrolled";
    listGalleryMock.mockResolvedValue({ apps: [customerOwnedApp(GITHUB)] });
    await render();
    let finishRefresh!: (value: { apps: typeof GITHUB_MANAGED[] }) => void;
    listGalleryMock.mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    await act(async () => { buttonByText("Try again")!.click(); });
    await act(async () => { buttonByText("Use a GitHub personal access token")!.click(); });
    await flushReact();
    const token = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(token).not.toBeNull();
    await act(async () => { setInputValue(token!, "github_pat_test"); });
    await act(async () => { finishRefresh({ apps: [GITHUB_MANAGED] }); });
    await flushReact();
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("github_pat_test");
    expect(container.textContent).not.toContain("Continue to GitHub");
  });

  /**
   * Design §"Question 2": a member who may create a personal grant but cannot
   * configure a company-wide install sees **Any agent** disabled with the
   * reason — not hidden. Disabling it is only half the job; Continue has to
   * refuse it too, or the forbidden choice is still submittable by keyboard.
   *
   * Driven through AppsConnect so this proves the pre-connection capability
   * returned with the gallery reaches the real create flow.
   */

  it("does not treat a mismatched active connection as completed from the URL stage", async () => {
    const connectionId = "22222222-2222-4222-8222-222222222222";
    mockSearch.value = `source=clickup&stage=complete&resume=${connectionId}&oauth=failed`;
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [{
        id: "app-monday",
        companyId: "company-1",
        status: "active",
        metadata: { sourceTemplateKey: "monday" },
      }],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [{
        id: connectionId,
        companyId: "company-1",
        applicationId: "app-monday",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "active",
        config: { sourceTemplateKey: "clickup" },
        transportConfig: { sourceTemplateKey: "clickup" },
      }],
    });

    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("This setup can’t be resumed"));

    expect(mockNavigate).not.toHaveBeenCalledWith(`/apps/${connectionId}/permissions`, { replace: true });
    expect(connectAppMock).not.toHaveBeenCalled();
    expect(finishAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).not.toHaveBeenCalled();
  });

  it("opens the existing connection when OAuth completed but post-sign-in setup failed", async () => {
    const connectionId = "22222222-2222-4222-8222-222222222222";
    mockSearch.value = `source=azure-devops&resume=${connectionId}&oauth=failed`;
    listGalleryMock.mockResolvedValueOnce({ apps: [AZURE_DEVOPS] });
    listApplicationsMock.mockResolvedValueOnce({ applications: [{ id: "app-azure", companyId: "company-1", status: "active", metadata: { sourceTemplateKey: "azure-devops" } }] });
    listConnectionsMock.mockResolvedValueOnce({ connections: [{ id: connectionId, companyId: "company-1", applicationId: "app-azure", authKind: "oauth", credentialPolicy: "per_user", status: "active", config: { sourceTemplateKey: "azure-devops" }, transportConfig: {} }] });
    await render();
    await vi.waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(`/apps/${connectionId}/permissions?oauth=failed`, { replace: true }));
    expect(connectAppMock).not.toHaveBeenCalled();
    expect(startOAuthMock).not.toHaveBeenCalled();
  });

    mockSearch.value = "source=notion";
    listGalleryMock.mockResolvedValueOnce({ apps: [NOTION] });
    listApplicationsMock.mockResolvedValueOnce({
      applications: [notionApplication("active")],
    });
    listConnectionsMock.mockResolvedValueOnce({
      connections: [notionConnection("conn-existing", credentialPolicy, "active")],
    });
    startOAuthMock.mockResolvedValueOnce(oauthStartResponse("conn-existing", "notion", "https://mcp.notion.com/authorize?state=existing"));

    await render();
    expect(container.textContent).toContain(
      credentialPolicy === "per_user" ? "Connects as you" : "Connects for everyone in your organization",
    );
    expect(container.textContent).toContain("agent access stays as it is");
    await passAccessStep();
    await submitCuratedOAuthSetup();

    expect(startOAuthMock).toHaveBeenCalledWith("conn-existing", {
      asCurrentUser,
    });
  });

  // PAP-11091: discoverability copy for remote MCP URLs — the link field
  // advertises that any remote tool URL (incl. a local MCP server) works. Per
  // the UX re-review, the localhost example lives in the body copy (legible at
  // every viewport) rather than the placeholder, which truncated on mobile.

  // Reconnect from the app page: ?link/?name/?applicationId prefill skips the
  // gallery and re-attaches the connection to the existing application.

});

/**
 * PAP-17087 — the BYO URL card is now the guided universal flow. What matters is
 * that the simple path stayed simple, that each failure mode names the thing the
 * operator has to change, and that a pasted endpoint that needs sign-in actually
 * gets there instead of a "coming soon" toast.
 */
