// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { getLastProjectId } from "../lib/recent-projects";
import { NewProjectForm } from "./NewProjectDialog";
import { repositoryProviders } from "./repository-providers";

vi.mock("../api/projects", () => ({ projectsApi: { create: vi.fn(), environmentOptions: vi.fn() } }));
vi.mock("./ProjectRepositoryInput", () => ({
  ProjectRepositoryInput: ({ onConnect }: { onConnect: (provider: typeof repositoryProviders[number]) => void }) => <button type="button" onClick={() => onConnect(repositoryProviders[1])}>Connect Azure</button>,
  repositoryOptionsKey: (companyId: string) => ["repositories", companyId],
}));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({ ConnectionSetupFlow: ({ serviceSlug, onCancel }: { serviceSlug: string; onCancel: () => void }) => <div>Setup {serviceSlug}<button onClick={onCancel}>Back</button></div> }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(projectsApi.create).mockReset().mockResolvedValue({ id: "project-created" } as Awaited<ReturnType<typeof projectsApi.create>>);
  vi.mocked(projectsApi.environmentOptions).mockReset().mockResolvedValue({ groups: [], defaultEnvironmentId: null, error: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe("new project colors", () => {
  it("opens Azure setup in the project dialog and preserves the project name on return", () => {
    act(() => root.render(<QueryClientProvider client={new QueryClient()}><NewProjectForm companyId="company-1" onClose={vi.fn()} /></QueryClientProvider>));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "My project");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connect = [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect Azure")!;
    act(() => connect.click());
    expect(container.textContent).toContain("Setup azure-devops");
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Back")!.click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')?.value).toBe("My project");
  });
});

const groups = [
  { storageProviderPluginId: null, environments: [{ id: "sandbox", name: "Paperclip Sandbox" }, { id: "ssh", name: "Build host" }] },
  { storageProviderPluginId: "computer-plugin", environments: [{ id: "computer", name: "Agent computers" }] },
];

async function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>
    <NewProjectForm companyId="company-1" onClose={vi.fn()} />
  </QueryClientProvider>));
  await settle();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Environment project");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return client;
}

