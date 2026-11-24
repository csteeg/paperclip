// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettingsNav, getCompanySettingsTab } from "./CompanySettingsNav";

let currentPathname = "/company/settings";
const navigateMock = vi.hoisted(() => vi.fn());
const pageTabBarMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "" }),
  useNavigate: () => navigateMock,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div data-testid="tabs-root">{children}</div>,
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: (props: {
    items: Array<{ value: string; label: string }>;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => {
    pageTabBarMock(props);

    return (
      <div>
        <div data-testid="active-tab">{props.value}</div>
        <button type="button" onClick={() => props.onValueChange?.("secrets")}>
          switch-tab
        </button>
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("CompanySettingsNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/company/settings";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function renderNav(
    root: ReturnType<typeof createRoot>,
    hiddenSettings?: string[],
    cloud?: { managed: boolean },
    fastResponsesEnabled = true,
  ) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableFastResponses: fastResponsesEnabled });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      ...(hiddenSettings ? { hiddenSettings } : {}),
      ...(cloud ? { cloud } : {}),
    });
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanySettingsNav />
      </QueryClientProvider>,
    );
  }

  it("renders the active tab and navigates when a different tab is selected", async () => {
    currentPathname = "/PAP/company/settings/members";
    const root = createRoot(container);

    await act(async () => {
      renderNav(root);
    });

    expect(container.textContent).toContain("members");
    expect(pageTabBarMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "members",
        items: [
          { value: "general", label: "General" },
          { value: "export", label: "Export" },
          { value: "import", label: "Import" },
          { value: "members", label: "Members" },
          { value: "secrets", label: "Secrets" },
          { value: "instance-profile", label: "Profile" },
          { value: "instance-environments", label: "Environments" },
          { value: "connections", label: "Connections" },
          { value: "pools", label: "Pools" },
          { value: "instance-access", label: "Access" },
          { value: "instance-experimental", label: "Experimental" },
          { value: "instance-plugins", label: "Plugins" },
          { value: "instance-adapters", label: "Adapters" },
        ],
      }),
    );

    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/company/settings/secrets");

    await act(async () => {
      root.unmount();
    });
  });

  it("filters operator-hidden tabs out of the tab bar", async () => {
    currentPathname = "/PAP/company/settings/members";
    const root = createRoot(container);

    await act(async () => {
      renderNav(root, ["instance.plugins"]);
    });

    const renderedValues = pageTabBarMock.mock.calls.at(-1)?.[0]?.items?.map(
      (item: { value: string }) => item.value,
    );
    expect(renderedValues).toEqual([
      "general",
      "export",
      "import",
      "members",
      "secrets",
      "instance-profile",
      "instance-environments",
      "connections",
      "pools",
      "instance-access",
      "instance-experimental",
      "instance-adapters",
    ]);

    await act(async () => {
      root.unmount();
    });
  });

});

it("selects the dedicated Pools settings destination", () => {
  expect(getCompanySettingsTab("/company/settings/pools")).toBe("pools");
});
