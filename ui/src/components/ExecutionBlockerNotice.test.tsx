// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import type { AnchorHTMLAttributes } from "react";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};
describe("ordinary task interruption", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async (presentation = failed, options: { canRetry?: boolean; optimistic?: boolean; takingLonger?: boolean; error?: Error } = {}) => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} {...options} />));
  };
  it("names the incompatible Runner and keeps the next check visible", async () => {
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
      retryWait: { reason: "runner_acpx_profile_incompatible", message: "Waiting for a compatible Runner." }, canRetry: false });
    expect(container.textContent).toContain("Waiting for a compatible Runner.");
    expect(container.textContent).toContain("Checking again in");
    expect(container.querySelector("[data-testid=task-execution-retry]")).toBeNull();
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
      retryWait: { reason: "runner_acpx_profile_incompatible", message: "A compatible Runner is available." }, canRetry: true });
    const retryButton = container.querySelector<HTMLButtonElement>("[data-testid=task-execution-retry]")!;
    expect(retryButton.textContent).toBe("Retry");
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();
  });

});
