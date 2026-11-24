// @vitest-environment jsdom
import { sampleHarnesses } from "@/test-support/harness-availability";
import { act } from "react";
import { PAPERCLIP_RUNNER_ACPX_PROFILES } from "@paperclipai/adapter-utils";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/api/client";
import {
  api, envApi, settings, secrets, state, managedApi, adapterApi,
  root, container, cache, settle, click, fill, render, connect, pass,
  renderCurrentParams,
} from "./NewAgent.test-support";

describe("New agent setup", () => {
  it.each([
    ["claude_local", "Claude", "anthropic", "api_key"], ["codex_local", "OpenAI", "openai", "api_key"],
    ["claude_local", "Claude", "anthropic", "subscription"], ["codex_local", "OpenAI", "openai", "subscription"],
  ] as const)("retries failed account model discovery for %s %s %s %s", async (adapter, label, provider, method) => {
    const connectionId = "00000000-0000-4000-8000-000000000021";
    const grantId = "00000000-0000-4000-8000-000000000022";
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", canManageConnections: true, connections: [{
      id: connectionId, grantId, companyId: "company-1", provider, method, name: "Catalog account",
      ownership: "personal", ownerUserId: "user-1", isDefault: true, status: "connected",
    }] } as any);
    api.adapterModels.mockImplementation(async (_company, _adapter, options) => {
      if (options?.aiConnection) throw new Error("Temporary catalog failure");
      return [];
    });
    await render(adapter);
    await click(label + (method === "api_key" ? "API key" : "Subscription"));
    await click(method === "api_key" ? "Use saved API key" : "Use saved subscription");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load models"));
    const binding = api.testEnvironment.mock.calls.at(-1)![2].aiConnection;
    expect(binding).toMatchObject({ mode: "responsible_user", provider, method });
    const refresh = [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh models");
    expect(refresh).toBeTruthy();
    let finish!: (models: Array<{ id: string; label: string }>) => void;
    api.adapterModels.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const before = api.adapterModels.mock.calls.length;
    await click("Refresh models");
    expect(refresh!.disabled).toBe(true);
    expect(api.adapterModels).toHaveBeenCalledTimes(before + 1);
    expect(api.adapterModels).toHaveBeenLastCalledWith("company-1", adapter, expect.objectContaining({ aiConnection: binding }));
    await act(async () => finish([{ id: "account-exact-model", label: "Recovered model" }]));
    await settle();
    expect(container.textContent).not.toContain("Could not load models");
    expect(refresh!.disabled).toBe(false);
  });

});
