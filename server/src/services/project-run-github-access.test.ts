import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { assertRunProjectGitHubAccess, authorizeProjectGitHubCheckout } from "./project-run-github-access.js";

function grantDb(fullNames: string[] = ["org/repo"]) {
  const rows = [{
    tenant: { github: { repositories: fullNames.map(fullName => ({ id: "123", fullName })) } },
    refs: [] as Array<{ configPath: string }>,
  }];
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return {
    db: { select } as unknown as Db,
    select,
    from,
    where,
    setRepositoryId(id: string) {
      rows[0]!.tenant.github.repositories.forEach(repository => { repository.id = id; });
    },
    usePat() {
      rows[0]!.tenant.github.repositories = [];
      rows[0]!.refs = [{ configPath: "credentials.authorization" }];
    },
  };
}
const run = {
  companyId: "company-test",
  agentId: "agent-test",
  runId: "run-test",
};
const token = "synthetic-github-token-never-leak";
const available = () => ({
  status: "available",
  env: { PAPERCLIP_GIT_TOKEN: token },
  grantId: "grant-test",
  connectionId: "connection-test",
  identityContextId: "identity-test",
  revision: 3,
});
const liveRepositoryResponse = (id: number) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ id }) });

describe("run project GitHub access policy", () => {
  it("allows a PAT only for a repository with a bound ID and live access", async () => {
    const catalog = grantDb();
    catalog.usePat();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue({ ...liveRepositoryResponse(123), json: vi.fn().mockResolvedValue({ id: 123, full_name: "org/repo", permissions: { pull: true } }) }) as unknown as typeof fetch;
    const input = { ...run, repoUrls: ["https://github.com/org/repo"], expectedRepositoryIds: { "org/repo": "123" } };
    await expect(assertRunProjectGitHubAccess(catalog.db, input, resolve, request)).resolves.toBe(true);
    await expect(assertRunProjectGitHubAccess(catalog.db, { ...run, repoUrls: input.repoUrls }, resolve, request)).rejects.toThrow(/unavailable/i);
    await expect(assertRunProjectGitHubAccess(catalog.db, { ...input, expectedRepositoryIds: { "org/repo": "456" } }, resolve, request)).rejects.toThrow(/unavailable/i);
  });
  it.each([
    { id: 123, full_name: "org/repo", permissions: { pull: false } },
    { id: 123, full_name: "other/repo", permissions: { pull: true } },
    { id: 456, full_name: "org/repo", permissions: { pull: true } },
  ])("rejects a PAT when GitHub returns an unauthorized repository", async payload => {
    const catalog = grantDb(); catalog.usePat();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(payload) }) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(catalog.db, { ...run, repoUrls: ["https://github.com/org/repo"],
      expectedRepositoryIds: { "org/repo": "123" } }, resolve, request)).rejects.toThrow(/unavailable/i);
  });
  it("rechecks the project repository ID after a PAT lookup", async () => {
    let workspaceId = "123";
    const db = { select: (fields: Record<string, unknown>) => ({ from: () => ({ where: async () =>
      "refs" in fields ? [{ tenant: null, refs: [{ configPath: "credentials.authorization" }] }]
        : [{ repoUrl: "https://github.com/org/repo", metadata: { githubRepositoryId: workspaceId } }],
    }) }) } as unknown as Db;
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockImplementation(async () => {
      workspaceId = "456";
      return { ok: true, json: async () => ({ id: 123, full_name: "org/repo", permissions: { pull: true } }) };
    }) as unknown as typeof fetch;
    await expect(authorizeProjectGitHubCheckout(db, { ...run, projectId: "project", repoUrl: "https://github.com/org/repo" }, resolve, request))
      .rejects.toThrow(/unavailable/i);
  });
  it.each([
    "https://github.com/org/repo.git",
    "https://www.github.com/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
    "git@www.github.com:org/repo.git",
  ])("checks connection state for GitHub repository %s", async (repoUrl) => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: [repoUrl] }, resolve, request)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("https://api.github.com/repos/org/repo", expect.objectContaining({
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ["revoked", { status: "unavailable" }],
    ["missing", { status: "absent" }],
  ])("rejects a GitHub run when its provider authorization is %s", async (_label, result) => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(result);
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve))
      .rejects.toThrow(/reconnect/i);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider errors or credential material in the reconnect error", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockRejectedValue(new Error(`provider failed with ${token}`));
    let caught: unknown;
    try {
      await assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["git@github.com:org/repo.git"] }, resolve);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect((caught as Error).message).not.toContain(token);
  });

  it("checks GitHub access in a mixed GitHub, Azure, and local repository set", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const repoUrls = [
      "https://dev.azure.com/org/project/_git/repo",
      "/workspace/local-repository",
      "git@github.com:org/repo.git",
    ];
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls }, resolve, request)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not resolve provider access when there are no GitHub repositories", async () => {
    const { db } = grantDb();
    const resolve = vi.fn();
    const repoUrls = [
      "https://dev.azure.com/org/project/_git/repo",
      "https://gitlab.com/org/repo.git",
      "/workspace/local-repository",
    ];
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls }, resolve)).resolves.toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("does not allow host credentials for a linked GitHub project even if a connection appeared later", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    await expect(assertRunProjectGitHubAccess(db, { ...run, hostGitHub: true, repoUrls: ["https://github.com/org/repo"] }, resolve))
      .rejects.toThrow(/reconnect/i);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([403, 404])("fails safely when GitHub repository lookup returns %i", async statusCode => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue({ ok: false, status: statusCode }) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
  });

  it("rechecks caller authorization after repository lookup", async () => {
    const { db } = grantDb();
    const resolve = vi.fn()
      .mockResolvedValueOnce(available())
      .mockResolvedValueOnce({ ...available(), status: "unavailable", env: {} });
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["git@github.com:org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("denies repositories outside the selected grant before making a live lookup", async () => {
    const { db, select } = grantDb(["org/another-repo"]);
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(select).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("denies when the live GitHub repository ID differs from the grant catalog", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(456)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("denies if the grant catalog repository ID changes during the live request", async () => {
    const catalog = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockImplementation(async () => {
      catalog.setRepositoryId("456");
      return liveRepositoryResponse(123);
    }) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(catalog.db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(request).toHaveBeenCalledTimes(1);
  });

});
