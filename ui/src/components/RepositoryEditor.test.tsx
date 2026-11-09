// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRepository } from "@paperclipai/shared";
import { RepositoryEditor } from "./RepositoryEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RepositoryEditor", () => {
  it("shows provider-neutral selected repository names and preserves provider-qualified identity", async () => {
    const selected: ProjectRepository[] = [
      { id: "12345", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: [] },
      { id: "azure-devops:org/project/repo", provider: "azure-devops", fullName: "org/project/repo", url: "https://dev.azure.com/org/project/_git/repo", connections: ["Work Azure DevOps"] },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={selected} available={[selected[0]!]} onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(container.textContent).toContain("paperclipai/paperclip");
      expect(container.textContent).toContain("GitHub");
      expect(container.textContent).toContain("org/project/repo");
      expect(container.textContent).toContain("Azure DevOps");
      expect(container.querySelector('[aria-label="Remove paperclipai/paperclip"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Remove org/project/repo"]')).toBeTruthy();
      expect(container.textContent).toContain("Restore the provider connection or repository access");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each(["loading", "error"] as const)("does not report missing provider access while the catalog is %s", async (state) => {
    const selected: ProjectRepository[] = [{ id: "azure-devops:org/project/repo", provider: "azure-devops", fullName: "org/project/repo", url: "https://dev.azure.com/org/project/_git/repo", connections: [] }];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={selected} available={[]} state={state} onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(container.textContent).not.toContain("Restore the provider connection or repository access");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it("shows a recovery message for an unavailable GitHub repository", async () => {
    const selected: ProjectRepository[] = [{ id: "12345", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: [] }];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={selected} available={[]} state="empty" onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(container.textContent).toContain("Restore the provider connection or repository access");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

});
