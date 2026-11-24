// @vitest-environment jsdom
import { sampleHarnesses } from "@/test-support/harness-availability";

import { webcrypto } from "node:crypto";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRunnerChoice, CompanyPortabilityImportResult, CompanyPortabilityPreviewResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { CompanyImportJobAccepted } from "../api/companies";
import { CompanyImport } from "./CompanyImport";
import { queryKeys } from "@/lib/queryKeys";

// jsdom's crypto has no SubtleCrypto; the chunked transfer path hashes parts
// with WebCrypto, so back the global with Node's implementation.
if (!globalThis.crypto?.subtle) {
  vi.stubGlobal("crypto", webcrypto);
}

const mockCompaniesApi = vi.hoisted(() => ({
  importPreview: vi.fn(),
  importPreviewPackage: vi.fn(),
  importBundle: vi.fn(),
  importBundleAsync: vi.fn(),
  importBundlePackageAsync: vi.fn(),
  importTransferCreate: vi.fn(),
  importTransferUploadPart: vi.fn(),
  importTransferStatus: vi.fn(),
  importTransferPreview: vi.fn(),
  importTransferApply: vi.fn(),
  getImportJob: vi.fn(),
  get: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  resume: vi.fn(),
}));
const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  get: vi.fn(),
}));
const mockRoutinesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  updateProjectOrder: vi.fn(),
}));
const mockSkillSourcesApi = vi.hoisted(() => ({ projectRepositories: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockOptionalCompany = vi.hoisted(() => vi.fn());
const mockReadZipArchive = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

// Keep the real sessionStorage bookkeeping so reload-resume is exercised, but
// make the poll delay instant so tests never wait the real 3s interval.
vi.mock("../lib/import-job-watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/import-job-watch")>();
  return { ...actual, waitForNextImportJobPoll: () => Promise.resolve() };
});

vi.mock("../lib/zip", () => ({
  readZipArchive: mockReadZipArchive,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/routines", () => ({
  routinesApi: mockRoutinesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));
vi.mock("../api/skillSources", () => ({ skillSourcesApi: mockSkillSourcesApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
  useOptionalCompany: mockOptionalCompany,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// MarkdownEditor pulls in @mdxeditor/editor, whose sandpack dependency inserts
// CSS rules jsdom cannot parse; the editor is never exercised by these tests.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value?: string }) => <textarea readOnly value={value ?? ""} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

// The async import runs submit → poll → onSuccess, several awaits deep. Drain a
// handful of macrotask turns so the outcome/activation panels have committed.
async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await flushReact();
  }
}

const previewFiles = {
  ".paperclip.yaml": 'schema: "paperclip/v1"\n',
  "agents/coder/AGENTS.md": "---\nname: Coder\n---\n\nYou write code.\n",
  "tasks/weekly-report/TASK.md": "---\nname: Weekly Report\nrecurring: true\n---\n\nSend the report.\n",
};

function buildPreviewResult(): CompanyPortabilityPreviewResult {
  return {
    include: { company: true, agents: true, projects: true, issues: true },
    targetCompanyId: null,
    targetCompanyName: null,
    collisionStrategy: "rename",
    selectedAgentSlugs: ["coder"],
    plan: {
      companyAction: "create",
      agentPlans: [{ slug: "coder", action: "create", plannedName: "Coder", existingAgentId: null, reason: null }],
      projectPlans: [],
      issuePlans: [{ slug: "weekly-report", action: "create", plannedTitle: "Weekly Report", reason: "Recurring task will be imported as a routine." }],
    },
    manifest: {
      agents: [{ slug: "coder", name: "Coder", path: "agents/coder/AGENTS.md", adapterType: "claude_local" }],
      projects: [],
      issues: [{ slug: "weekly-report", title: "Weekly Report", path: "tasks/weekly-report/TASK.md" }],
      skills: [],
      company: null,
    },
    files: previewFiles,
    envInputs: [],
    warnings: [],
    errors: [],
  } as unknown as CompanyPortabilityPreviewResult;
}

/** Preview whose manifest mixes adapters: one claude_local agent and one codex_local agent. */
function buildMixedAdapterPreviewResult(): CompanyPortabilityPreviewResult {
  return {
    include: { company: true, agents: true, projects: true, issues: true },
    targetCompanyId: null,
    targetCompanyName: null,
    collisionStrategy: "rename",
    selectedAgentSlugs: ["coder", "researcher"],
    plan: {
      companyAction: "create",
      agentPlans: [
        { slug: "coder", action: "create", plannedName: "Coder", existingAgentId: null, reason: null },
        { slug: "researcher", action: "create", plannedName: "Researcher", existingAgentId: null, reason: null },
      ],
      projectPlans: [],
      issuePlans: [],
    },
    manifest: {
      agents: [
        { slug: "coder", name: "Coder", path: "agents/coder/AGENTS.md", adapterType: "claude_local" },
        { slug: "researcher", name: "Researcher", path: "agents/researcher/AGENTS.md", adapterType: "codex_local" },
      ],
      projects: [],
      issues: [],
      skills: [],
      company: null,
    },
    files: {
      ".paperclip.yaml": 'schema: "paperclip/v1"\n',
      "agents/coder/AGENTS.md": "---\nname: Coder\n---\n\nYou write code.\n",
      "agents/researcher/AGENTS.md": "---\nname: Researcher\n---\n\nYou research.\n",
    },
    envInputs: [],
    warnings: [],
    errors: [],
  } as unknown as CompanyPortabilityPreviewResult;
}

function buildImportResult(): CompanyPortabilityImportResult {
  return {
    company: { id: "company-2", name: "Imported Test", action: "created" },
    agents: [{ slug: "coder", id: "agent-1", action: "created", name: "Coder", reason: null }],
    skills: [],
    projects: [],
    routines: [{ slug: "weekly-report", id: "routine-1", action: "created", title: "Weekly Report", status: "paused" }],
    envInputs: [],
    warnings: [],
  };
}

function buildAccepted(id = "job-1"): CompanyImportJobAccepted {
  return { job: { id, status: "running" }, statusUrl: `/companies/import/jobs/${id}` };
}

function buildTransferCreated(missingParts: number[], alreadyCompleted = false) {
  return {
    transferId: "transfer-1",
    status: "running",
    alreadyCompleted,
    totalParts: 2,
    missingParts,
  };
}

const TRANSFER_PART_SIZE = 32 * 1024 * 1024;

/**
 * A zip whose declared size crosses the 48 MB chunked-transfer threshold. Its
 * real content is one full part plus a 1 KB tail so the manifest slices into
 * two parts without allocating 48 MB in the test.
 */
function buildLargeZipFile(): File {
  const bytes = new Uint8Array(TRANSFER_PART_SIZE + 1024);
  const file = new File([bytes], "big-package.zip", { type: "application/zip" });
  Object.defineProperty(file, "size", { value: 49 * 1024 * 1024 });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}

function buildSucceededJob(id = "job-1") {
  return { job: { id, status: "succeeded" as const, importResult: buildImportResult() } };
}

describe("CompanyImport", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockOptionalCompany.mockReturnValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableNativeRunner: false, enableOpenAiDot: false });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({});
    mockInstanceSettingsApi.get.mockResolvedValue({});
    mockAdaptersApi.list.mockResolvedValue([
      { type: "claude_local", disabled: false },
      { type: "codex_local", disabled: false },
    ]);
    mockAgentsApi.resume.mockResolvedValue({ id: "agent-1", status: "idle" });
    mockRoutinesApi.update.mockResolvedValue({ id: "routine-1", status: "active" });
    mockCompaniesApi.importPreview.mockResolvedValue(buildPreviewResult());
    mockCompaniesApi.importPreviewPackage.mockResolvedValue(buildPreviewResult());
    // Default async flow: the submit is accepted (202) and the first poll finds
    // the job already finished with the full result. Individual tests override.
    mockCompaniesApi.importBundleAsync.mockResolvedValue(buildAccepted());
    mockCompaniesApi.importBundlePackageAsync.mockResolvedValue(buildAccepted());
    mockCompaniesApi.importTransferCreate.mockResolvedValue(buildTransferCreated([0, 1]));
    mockCompaniesApi.importTransferUploadPart.mockResolvedValue({ ok: true, index: 0, alreadyCompleted: false });
    mockCompaniesApi.importTransferPreview.mockResolvedValue(buildPreviewResult());
    mockCompaniesApi.importTransferApply.mockResolvedValue(buildAccepted());
    mockCompaniesApi.getImportJob.mockResolvedValue(buildSucceededJob());
    mockCompaniesApi.get.mockResolvedValue({ id: "company-2", name: "Imported Test", issuePrefix: "IMP" });
    mockSidebarPreferencesApi.updateProjectOrder.mockResolvedValue(undefined);
    mockSkillSourcesApi.projectRepositories.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      await act(async () => {
        currentRoot.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  function findButton(matches: (text: string) => boolean) {
    return Array.from(container.querySelectorAll("button"))
      .find((button) => matches(button.textContent?.trim() ?? "")) as HTMLButtonElement | undefined;
  }

  async function clickButton(matches: (text: string) => boolean) {
    const button = findButton(matches);
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();
  }

  async function renderPage(cloud = false) {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (cloud) queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true, availableHarnesses: sampleHarnesses } });
    const currentRoot = root;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <CompanyImport />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function enterGithubUrl(url = "https://github.com/acme/starter/tree/main/company") {
    const urlInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://github.com/owner/repo/tree/main/company"]',
    );
    expect(urlInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(urlInput!, url);
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  async function chooseLocalZip(file: File) {
    await clickButton((text) => text.includes("Local zip"));
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
  }

  async function renderPageAndImport() {
    await renderPage();
    await enterGithubUrl();

    await clickButton((text) => text === "Preview import");

    // Paused-import checkbox is present and checked by default.
    const pauseLabel = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Start imported agents and routines paused"));
    expect(pauseLabel).toBeTruthy();
    expect(pauseLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);

    await clickButton((text) => text.startsWith("Import 3 file"));
    await settle();
  }

  it("previews and imports an Azure DevOps project repository source", async () => {
    mockSkillSourcesApi.projectRepositories.mockResolvedValue([
      {
        projectId: "project-1", projectName: "Platform", projectVisibility: "private",
        workspaceId: "workspace-1", repositoryUrl: "https://dev.azure.com/acme/Platform/_git/company-kit",
        trackingRef: "refs/heads/main", bindingId: "binding-1", sourceId: null, status: "available", lastError: null,
      },
      {
        projectId: "project-2", projectName: "GitHub", projectVisibility: "open",
        workspaceId: "workspace-2", repositoryUrl: "https://github.com/acme/other",
        trackingRef: "main", bindingId: "binding-2", sourceId: null, status: "available", lastError: null,
      },
      {
        projectId: "project-3", projectName: "Legacy Azure", projectVisibility: "private",
        workspaceId: "workspace-3", repositoryUrl: "https://acme.visualstudio.com/Platform/_git/legacy",
        trackingRef: "main", bindingId: "binding-3", sourceId: null, status: "available", lastError: null,
      },
    ]);
    await renderPage();
    await clickButton((text) => text.includes("Azure DevOps project"));
    const select = container.querySelector<HTMLSelectElement>('select');
    expect(select?.textContent).toContain("Platform");
    expect(select?.textContent).not.toContain("GitHub");
    expect(select?.textContent).not.toContain("Legacy Azure");
    await act(async () => {
      select!.value = "workspace-1";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await clickButton((text) => text === "Preview import");
    expect(mockCompaniesApi.importPreview).toHaveBeenCalledWith(expect.objectContaining({
      source: { type: "project_repository", companyId: "company-1", workspaceId: "workspace-1" },
    }));
    await clickButton((text) => text.startsWith("Import "));
    await settle();
    expect(mockCompaniesApi.importBundleAsync).toHaveBeenCalledWith(expect.objectContaining({
      source: { type: "project_repository", companyId: "company-1", workspaceId: "workspace-1" },
    }));
  });

  /** Adapter selects in the picker list, in manifest order (excludes the target/collision selects). */
  function findAdapterSelects() {
    return Array.from(container.querySelectorAll("select"))
      .filter((select) => select.value !== "new" && select.value !== "existing" && select.value !== "rename");
  }

  async function previewMixedAdapterPackage() {
    mockCompaniesApi.importPreview.mockResolvedValue(buildMixedAdapterPreviewResult());
    await renderPage();
    await enterGithubUrl();
    await clickButton((text) => text === "Preview import");
  }

  function lastImportMeta() {
    const call = mockCompaniesApi.importBundleAsync.mock.calls.at(-1);
    expect(call).toBeTruthy();
    return call![0] as { adapterOverrides?: Record<string, { adapterType: string; runner?: AgentRunnerChoice; adapterConfig?: Record<string, unknown> }> };
  }

});
