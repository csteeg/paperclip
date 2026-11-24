// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { MemoryRouter } from "@/lib/router";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CoordinatorTasks } from "./CoordinatorTasks";
import { Issues } from "./Issues";
import { queryKeys } from "@/lib/queryKeys";
import { ToastProvider, useToastState } from "@/context/ToastContext";
import { IssueFilterPanel } from "@/components/IssueFilterPanel";
import type { ComponentProps } from "react";
import type { Issue } from "@paperclipai/shared";
import type { IssueRowArchiveAction } from "@/components/IssueRow";
import type { TaskListSort } from "@/lib/task-list";
import { taskListViews, taskListViewStorageKey, type TaskListView } from "@/lib/task-list-views";

const mocks = vi.hoisted(() => ({ list: vi.fn(), archive: vi.fn(), restore: vi.fn(), get: vi.fn(), attention: vi.fn(), breadcrumbs: vi.fn(), liveRuns: vi.fn(), localTrusted: false, realFilters: false, labels: [] as { id: string; name: string; color: string }[], identity: { userId: "person" as string | null, settled: true } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.liveRuns } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: mocks.get, archiveFromInbox: mocks.archive, unarchiveFromInbox: mocks.restore, listLabels: async () => mocks.labels, update: vi.fn() } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: mocks.attention } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => mocks.identity }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: mocks.identity.userId ?? (mocks.localTrusted ? "local-board" : null), loaded: mocks.identity.settled }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/components/TaskListToolbar", () => ({ TaskListToolbar: ({ filters, view, onViewChange, onLayoutChange }: { filters: Omit<ComponentProps<typeof IssueFilterPanel>, "onClear">; view: TaskListView; onViewChange: (view: TaskListView) => void; onLayoutChange: (layout: "list" | "board") => void }) => <>
  {mocks.realFilters ? <IssueFilterPanel {...filters} onClear={() => filters.onChange({ labels: [] })} /> : null}
  <span data-selected-view>{view}</span>
  {taskListViews.map(option => <button key={option.value} onClick={() => onViewChange(option.value)}>{option.label}</button>)}
  <button onClick={() => filters.onChange({ routineTasksOnly: true })}>Routine tasks</button>
  <button onClick={() => filters.onChange({ routineTasksOnly: false })}>Show other tasks</button>
  <button onClick={() => filters.onChange({ liveOnly: true })}>Live runs only</button>
  <button onClick={() => filters.onChange({ priorities: ["high"] })}>High priority</button>
  <button onClick={() => filters.onChange({ statuses: ["in_progress"] })}>In progress only</button>
  <button onClick={() => filters.onChange({ assignees: [], statuses: [] })}>Clear assignee and status</button>
  <button onClick={() => filters.onChange({ assignees: ["first", "second"], statuses: ["todo"] })}>Change assignee and status</button>
  <button onClick={() => onLayoutChange("board")}>Board view</button>
  <button onClick={() => onLayoutChange("list")}>List view</button>
</> }));
vi.mock("@/components/TaskList", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/TaskList")>(),
  TaskList: ({ items, emptyState, onSortChange, getArchiveAction }: {
    onSortChange?: (sort: TaskListSort) => void;
    items: { issue: Issue; assignee?: string | null }[];
    emptyState: React.ReactNode;
    getArchiveAction?: (issue: Issue) => IssueRowArchiveAction | undefined;
  }) => <div>
    <button onClick={() => onSortChange?.({ column: "taskId", direction: "descending" })}>Sort by task ID</button>
    <output>{useLocation().search}</output>
    {items.length ? items.map(item => {
      const action = getArchiveAction?.(item.issue);
      return <p key={item.issue.id} data-task-id={item.issue.id} data-assignee={item.assignee}>
        {item.issue.title}{action ? <button disabled={action.disabled} onClick={action.onClick}>{action.archived ? "Restore" : "Archive"}</button> : null}
      </p>;
    }) : emptyState}
  </div>,
}));

describe("Coordinator tasks using the proposed table", () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  const pending = createIssue({ id: "pending", companyId: "company", status: "todo", parentId: null, title: "Needs a channel answer" });
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    mocks.realFilters = false; mocks.labels = [];
    mocks.identity = { userId: "person", settled: true };
    mocks.localTrusted = false;
    mocks.liveRuns.mockResolvedValue([]);
    mocks.attention.mockResolvedValue({ taskIds: [pending.id] });
    mocks.get.mockResolvedValue(pending);
    mocks.list.mockImplementation(async (_company, filters) => filters.q ? [] : filters.ids ? [pending] : [createIssue({ id: "unrelated-review", companyId: "company", status: "in_review", parentId: null })]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
  async function mount(url: string) {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><CoordinatorTasks /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
  }

  it.each([
    { url: "/issues", view: "all", ids: ["parent", "mine", "assigned", "unrelated"] },
    { url: "/issues?view=inbox", view: "inbox", ids: ["parent", "mine", "assigned"] },
  ])("opens $url in $view, retaining parent context for Inbox", async ({ url, view, ids }) => {
    mocks.list.mockResolvedValue([
      createIssue({ id: "parent", companyId: "company", parentId: null, createdByUserId: "other" }),
      createIssue({ id: "mine", companyId: "company", parentId: "parent", createdByUserId: "person" }),
      createIssue({ id: "assigned", companyId: "company", parentId: null, assigneeUserId: "person" }),
      createIssue({ id: "unrelated", companyId: "company", parentId: null, createdByUserId: "other" }),
    ]);
    await mount(url);
    expect(host.querySelector("[data-selected-view]")?.textContent).toBe(view);
    expect([...host.querySelectorAll("[data-task-id]")].map(row => row.getAttribute("data-task-id"))).toEqual(ids);
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe(`?view=${view}`));
  });

  it("hydrates distinct pending task IDs independently of status and the first task-list page", async () => {
    await mount("/issues?view=needs_attention");
    expect(mocks.attention).toHaveBeenCalledWith("company");
    expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual(["pending"]);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith("company", expect.objectContaining({ ids: [pending.id], projection: "index" }), expect.anything());
    // Canonical attention invalidation refreshes the complete task membership.
    // No parallel status-based queue is involved.
    flushSync(() => client.setQueryData(coordinatorAttentionTasksQueryKey("company", "person"), { taskIds: [pending.id] }));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-task-id]")).toHaveLength(1));
    flushSync(() => client.setQueryData(coordinatorAttentionTasksQueryKey("company", "person"), { taskIds: [] }));
    await vi.waitFor(() => expect(host.textContent).toContain("No tasks need a decision."));
  });
});
