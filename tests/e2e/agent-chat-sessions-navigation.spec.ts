import { expect, test } from "@playwright/test";

import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";

import { idle, json, send, setup } from "./agent-chat.shared";

test.use({ trace: "retain-on-failure" });
test.setTimeout(120_000);

/**
 * Agent chat session reset and sidebar navigation coverage split out of
 * agent-chat-sessions.spec.ts so serial E2E shards stay under 75s.
 */
test("Stop then queued /new resets unpause the conversation without losing history", async ({
  page,
  request,
}) => {
  const f = await setup(request);
  try {
    await page.goto(f.route);
    await send(page, { action: "hold" });
    await expect
      .poll(async () => {
        const chat = await json(await request.get(f.chatPath));
        return (
          chat &&
          (
            await json(await request.get(`/api/issues/${chat.id}/comments`))
          ).some(
            (c: any) => c.body === "Provider is streaming and ready to stop.",
          )
        );
      }, { timeout: 30_000 })
      .toBe(true);
    const issue = await json(await request.get(f.chatPath));
    const active = (
      await json(await request.get(`/api/issues/${issue.id}/live-runs`))
    )[0];
    await page.getByTestId("task-chat-composer-stop").click();
    await expect
      .poll(
        async () =>
          (await json(await request.get(`/api/heartbeat-runs/${active.id}`)))
            .status,
      )
      .toBe("cancelled");
    const staleToken = createLocalAgentJwt(
      f.agent.id,
      f.company.id,
      "process",
      active.id,
    );
    expect(staleToken).toBeTruthy();
    const late = await request.post(`/api/issues/${issue.id}/comments`, {
      headers: { Authorization: `Bearer ${staleToken}` },
      data: { body: "Forbidden late response" },
    });
    expect([403, 409]).toContain(late.status());
    const mutation = await request.post(
      `/api/companies/${f.company.id}/projects`,
      {
        headers: { Authorization: `Bearer ${staleToken}` },
        data: { name: "Cancelled project" },
      },
    );
    expect([403, 409]).toContain(mutation.status());
    expect(
      await json(await request.get(`/api/companies/${f.company.id}/projects`)),
    ).toHaveLength(0);
    await send(page, "/new");
    await send(page, "/new");
    await send(page, "Fresh followup");
    await idle(request, f.chatPath, 2);
    const fresh = await json(await request.get(f.chatPath));
    expect(fresh.id).toBe(issue.id);
    expect(fresh.conversationSessionGeneration).toBe(2);
    await expect(
      page.getByText("Reply generation 2: Fresh followup", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText("New session", { exact: true })).toHaveCount(2);
    await expect(
      page.getByRole("separator", { name: "Run completed", exact: true }),
    ).toHaveCount(0);
    const runs = await json(
      await request.get(`/api/companies/${f.company.id}/heartbeat-runs`),
    );
    const detailed = await Promise.all(
      runs.map((run: any) =>
        request.get(`/api/heartbeat-runs/${run.id}`).then(json),
      ),
    );
    expect(
      detailed.filter((run) => run.contextSnapshot?.conversationReset),
    ).toHaveLength(2);
    expect(
      detailed
        .filter((run) => run.contextSnapshot?.conversationReset)
        .every((run) => !run.sessionIdAfter),
    ).toBe(true);
  } finally {
    await f.restore();
  }
});

test("Coordinator agent switching preserves drafts and opens one conversation only on send", async ({ page, request }) => {
  const f = await setup(request, { agentCount: 2 });
  try {
    await page.goto(f.route);
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]');
    const contacts = page.getByRole("complementary", { name: "Chat contacts", exact: true });
    const switchTo = async (name: string) => {
      const contact = contacts.getByRole("link", { name: new RegExp(`^${name}`) });
      await contact.click();
      await expect(contact).toHaveAttribute("aria-current", "page");
    };
    await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
    await expect(contacts.getByRole("button", { name: "Add chat", exact: true })).toHaveCount(0);
    await editor.fill("Unsent Coordinator draft for Alpha");
    await switchTo("Beta");
    await expect(editor).toHaveText("");
    expect(await json(await request.get(`/api/companies/${f.company.id}/chats/${f.agents[1].id}`))).toBeNull();
    await switchTo("Alpha");
    await expect(editor).toContainText("Unsent Coordinator draft for Alpha");
    await page.reload();
    await expect(editor).toContainText("Unsent Coordinator draft for Alpha");
    expect(await json(await request.get(f.chatPath))).toBeNull();
    await editor.fill("");
    await send(page, "Coordinator conversation acceptance");
    await idle(request, f.chatPath);
    const chat = await json(await request.get(f.chatPath));
    await switchTo("Beta");
    await switchTo("Alpha");
    await expect(page.getByText("Coordinator conversation acceptance", { exact: true })).toBeVisible();
    expect((await json(await request.get(f.chatPath))).id).toBe(chat.id);
    expect(await json(await request.get(`/api/companies/${f.company.id}/chats`))).toHaveLength(1);
  } finally {
    await f.restore();
  }
});

test("secondary chat navigation preserves layout, separate conversations, history, and drafts", async ({
  page,
  request,
}) => {
  const originalExperimental = await json(await request.get("/api/instance/settings/experimental"));
  const f = await setup(request, { agentCount: 6 });
  const originalWorkspace = await json(await request.get("/api/workspace-preferences/me"));
  try {
    await page.route("**/api/workspace-preferences/me", (route) =>
      route.fulfill({
        json: { ...originalWorkspace, coordinatorWorkspaceEnabled: false },
      }),
    );
    await page.route("**/api/instance/settings/experimental", (route) =>
      route.fulfill({
        json: { ...originalExperimental, enableStreamlinedUi: true },
      }),
    );
    await page.goto(`/${f.company.issuePrefix}/dashboard`);
    await page.locator('a[href$="/chats"]').click();
    // With no recent conversation, Chat opens the first human-created primary.
    // Navigation alone must not create a conversation or start execution.
    expect(await json(await request.get(`/api/companies/${f.company.id}/primary-agent/me`))).toMatchObject({
      primaryAgentId: f.agents[0].id, initialized: true,
    });
    const sidebar = page.getByRole("complementary", { name: "Chat contacts", exact: true });
    const nav = sidebar.getByRole("navigation", { name: "Agent conversations" });
    const alphaContact = nav.getByRole("link", { name: /^Alpha/ });
    const betaContact = nav.getByRole("link", { name: /^Beta/ });
    await expect(alphaContact).toHaveAttribute("aria-current", "page");
    expect(await json(await request.get(f.chatPath))).toBeNull();
    expect(await json(await request.get(`/api/companies/${f.company.id}/heartbeat-runs`))).toHaveLength(0);
    await expect(nav.getByRole("link")).toHaveText([/^Alpha/, /^Beta/, /^Delta/, /^Epsilon/, /^Gamma/, /^Zeta/]);
    const landingBounds = await sidebar.boundingBox();
    const chatListPath = `/api/companies/${f.company.id}/chats`;
    await betaContact.click();
    await expect(betaContact).toHaveAttribute("aria-current", "page");
    expect(await json(await request.get(chatListPath))).toHaveLength(0);
    await alphaContact.click();
    await expect(alphaContact).toHaveAttribute("aria-current", "page");
    const compose = sidebar.getByRole("button", { name: "Add chat", exact: true });
    const picker = page.getByRole("dialog");
    const previousDefaultEditor = await page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]').elementHandle();
    await compose.click();
    await expect(picker.getByRole("option")).toHaveCount(6);
    await picker.getByRole("combobox").fill("Beta");
    await expect(picker.getByRole("option", { name: /^Beta / })).toContainText("New chat");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(nav.getByRole("link", { name: /^Beta/ })).toHaveAttribute("aria-current", "page");
    expect(await sidebar.boundingBox()).toEqual(landingBounds);
    const [beta] = await json(await request.get(chatListPath));
    const betaPath = `/api/issues/${beta.id}`;
    await expect(page).toHaveURL(new RegExp(`${beta.id}$`));
    await previousDefaultEditor!.waitForElementState("hidden");
    expect(beta.conversationAgentId).toBe(f.agents[1].id);
    expect(await json(await request.get(chatListPath))).toHaveLength(1);
    expect(await json(await request.get(`/api/companies/${f.company.id}/heartbeat-runs`))).toHaveLength(0);

    const betaDraftEditor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]');
    await betaDraftEditor.fill("First Beta conversation draft");

    // Adding the same agent again creates a distinct conversation.
    const previousBetaEditor = await betaDraftEditor.elementHandle();
    const createUrl = `**/api/companies/${f.company.id}/chats/${f.agents[1].id}?new=true`;
    let lostRequestId: string | undefined;
    let committedChatId: string | undefined;
    let finishLostResponse!: () => void;
    const lostResponseFinished = new Promise<void>(resolve => { finishLostResponse = resolve; });
    await page.route(createUrl, async route => {
      const response = await route.fetch();
      try {
        lostRequestId = route.request().postDataJSON().clientRequestId;
        committedChatId = (await json(response)).id;
        await route.abort("failed");
      } finally {
        await response.dispose();
        finishLostResponse();
      }
    }, { times: 1 });
    await compose.click();
    await expect(picker.getByRole("combobox")).toHaveValue("");
    await picker.getByRole("combobox").fill("Beta");
    await expect(picker.getByRole("option", { name: /^Beta / })).toContainText("New chat");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker.getByRole("alert")).toBeVisible();
    await lostResponseFinished;
    expect(lostRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await json(await request.get(chatListPath))).toHaveLength(2);
    const retryRequest = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith(`/chats/${f.agents[1].id}?new=true`));
    await picker.getByRole("combobox").press("Enter");
    expect((await retryRequest).postDataJSON().clientRequestId).toBe(lostRequestId);
    await expect(picker).not.toBeVisible();
    await previousBetaEditor!.waitForElementState("hidden");
    await expect(betaDraftEditor).toHaveText("");
    await betaDraftEditor.fill("Second Beta conversation draft");
    const betaChats = await json(await request.get(chatListPath));
    expect(betaChats).toHaveLength(2);
    expect(new Set(betaChats.map((chat: { id: string }) => chat.id)).size).toBe(2);
    expect(betaChats.map((chat: { id: string }) => chat.id)).toContain(beta.id);
    const secondBeta = betaChats.find((chat: { id: string }) => chat.id !== beta.id);
    expect(secondBeta.id).toBe(committedChatId);
    await sidebar.locator(`a[href$="/${beta.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${beta.id}$`));
    await expect(betaDraftEditor).toContainText("First Beta conversation draft");
    await betaDraftEditor.click();
    await betaDraftEditor.press("ControlOrMeta+A");
    await expect.poll(() => betaDraftEditor.evaluate(() => window.getSelection()?.toString())).toBe("First Beta conversation draft");
    await betaDraftEditor.press("Backspace");
    await expect(betaDraftEditor).toHaveText("");
    await sidebar.locator(`a[href$="/${secondBeta.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${secondBeta.id}$`));
    await expect(betaDraftEditor).toContainText("Second Beta conversation draft");
    await page.reload();
    await expect(betaDraftEditor).toContainText("Second Beta conversation draft");
    await betaDraftEditor.click();
    await betaDraftEditor.press("ControlOrMeta+A");
    await expect.poll(() => betaDraftEditor.evaluate(() => window.getSelection()?.toString())).toBe("Second Beta conversation draft");
    await betaDraftEditor.press("Backspace");
    await expect(betaDraftEditor).toHaveText("");

    await compose.click();
    await picker.getByRole("combobox").fill("Alpha");
    await picker.getByRole("combobox").press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(nav.getByRole("link", { name: /^Alpha/ })).toHaveAttribute("aria-current", "page");
    const alpha = (await json(await request.get(chatListPath))).find((chat: { conversationAgentId: string }) => chat.conversationAgentId === f.agents[0].id);
    const alphaLink = sidebar.locator(`a[href$="/${alpha.id}"]`);
    const betaLink = sidebar.locator(`a[href$="/${beta.id}"]`);
    // Open chat first, then other conversations, then the rest alphabetically.
    await expect(nav.getByRole("link")).toHaveText([/^Alpha/, /^Beta/, /^Delta/, /^Epsilon/, /^Gamma/, /^Zeta/]);
    const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]');
    await editor.fill("Unsent draft for Alpha");
    await betaLink.click();
    await expect(editor).toHaveText("");
    await alphaLink.click();
    await expect(editor).toContainText("Unsent draft for Alpha");

    const search = sidebar.getByRole("textbox", { name: "Search chats", exact: true });
    await search.fill("No matching agent");
    await expect(sidebar.getByText("No agents found", { exact: true })).toBeVisible();
    await search.fill("Beta");
    await expect(nav.getByRole("link")).toHaveCount(1);
    await expect(betaLink).toBeVisible();
    await search.press("Escape");
    await expect(nav.getByRole("link")).toHaveCount(6);
    await page.reload();
    await expect(editor).toContainText("Unsent draft for Alpha");
    await expect(nav.getByRole("link")).toHaveCount(6);

    await page.locator('a[href$="/chats"]').click();
    await expect(nav.getByRole("link", { name: /^Alpha/ })).toHaveAttribute("aria-current", "page");
    await expect(editor).toContainText("Unsent draft for Alpha");
    expect(await sidebar.boundingBox()).toEqual(landingBounds);
    await page.goto(`/${f.company.issuePrefix}/dashboard`);
    await expect(page).toHaveURL(/\/dashboard$/);
    await json(await request.post(`/api/issues/${beta.id}/comments`, {
      data: {
        body: "Background activity",
        clientRequestId: "00000000-0000-4000-8000-000000000099",
      },
    }));
    await idle(request, betaPath);
    await page.locator('a[href$="/chats"]').click();
    await expect(nav.getByRole("link", { name: /^Alpha/ })).toHaveAttribute("aria-current", "page");
    await betaLink.click();
    await expect(nav.getByRole("link", { name: /^Beta/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("task-chat-human-bubble").getByText("Background activity", { exact: true })).toBeVisible();
    expect((await json(await request.get(betaPath))).id).toBe(beta.id);
    expect(await json(await request.get(chatListPath))).toHaveLength(3);
    await json(await request.post(`/api/agents/${f.agents[1].id}/terminate`));
    await page.goto(`/${f.company.issuePrefix}/chats`);
    await expect(nav.getByRole("link", { name: /^Beta / })).toContainText("Terminated");
    await betaLink.click();
    await expect(page).toHaveURL(new RegExp(`/chats/${f.agents[1].id}/${beta.id}$`));
    await expect(page.getByTestId("task-chat-human-bubble").getByText("Background activity", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("task-chat-human-bubble").getByText("Background activity", { exact: true })).toBeVisible();
  } finally {
    await f.restore();
  }
});
