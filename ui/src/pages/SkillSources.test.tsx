// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSource } from '@paperclipai/shared';
import { SkillSources } from './SkillSources';
import { ApiError } from '@/api/client';
import { skillSourcesApi } from '@/api/skillSources';
import { sourceFixture } from '../../storybook/fixtures/githubSkillSources';

const context = vi.hoisted(() => ({ navigate: vi.fn(), breadcrumbs: vi.fn(), sourceId: 'new', streamlinedEnabled: true }));
vi.mock('@/context/CompanyContext', () => ({ useCompany: () => ({ selectedCompanyId: 'company-1', selectedCompany: { name: 'Acme' } }) }));
vi.mock('@/context/BreadcrumbContext', () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: context.breadcrumbs }) }));
vi.mock('@/lib/router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => context.navigate,
  useParams: () => ({ sourceId: context.sourceId }),
}));
vi.mock('@/api/skillSources', () => ({ skillSourcesApi: { list: vi.fn(), projectRepositories: vi.fn(), adoptProject: vi.fn(), settings: vi.fn(), branches: vi.fn(), repositories: vi.fn(), discoverStream: vi.fn(), create: vi.fn(), select: vi.fn(), refresh: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@/hooks/useStreamlinedUiEnabled', () => ({ useStreamlinedUiEnabled: () => ({ enabled: context.streamlinedEnabled, loaded: true }) }));

const repos = {
  connections: [{ id: 'personal', name: 'Personal' }, { id: 'shared', name: 'Engineering' }],
  connectionCount: 2, failedConnectionCount: 0,
  repositories: [
    { id: '1', fullName: 'acme/team-skills', url: 'https://github.com/acme/team-skills', private: true, connections: ['Personal', 'Engineering'], connectionIds: ['personal', 'shared'] },
    { id: '2', fullName: 'acme/design', url: 'https://github.com/acme/design', private: true, connections: ['Engineering'], connectionIds: ['shared'] },
  ],
};
const discovery = { repositoryId: '1', repositoryUrl: 'https://github.com/acme/team-skills', fullName: 'acme/team-skills', trackingRef: 'feature/new-skills', commitSha: 'a'.repeat(40), candidates: [], warnings: [] };
const connectedSource: SkillSource = {
  id: 'source-1', companyId: 'company-1', repositoryId: '1', repositoryUrl: 'https://github.com/acme/team-skills', fullName: 'acme/team-skills',
  trackingRef: 'HEAD', connectionId: 'shared', excludedFolders: [], enabled: true, revision: 1,
  lastAttemptAt: null, lastSuccessAt: null, lastScanCommit: null, lastError: null, entries: [],
};
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><SkillSources /></QueryClientProvider>));
  await flush(); await flush();
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === text)!; }
async function input(selector: string, value: string) {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.mocked(skillSourcesApi.list).mockResolvedValue([]);
  vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([]);
  vi.mocked(skillSourcesApi.repositories).mockResolvedValue(structuredClone(repos));
  vi.mocked(skillSourcesApi.branches).mockResolvedValue({ defaultBranch: 'master', branches: [{ name: 'master', isDefault: true }], truncated: false });
  vi.mocked(skillSourcesApi.discoverStream).mockResolvedValue(discovery);
  context.sourceId = 'new';
  context.streamlinedEnabled = true;
  sessionStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe('GitHub skill source import', () => {
  it('explains how to authorize each affected Azure project and links to its configuration', async () => {
    context.sourceId = '';
    const repository = { projectId: 'one', projectName: 'First', projectVisibility: 'open' as const,
      workspaceId: 'workspace-one', repositoryUrl: 'https://dev.azure.com/contoso/Platform/_git/Skills', trackingRef: 'HEAD',
      bindingId: 'binding-one', sourceId: null, status: 'error' as const,
      lastError: 'Authorize this project’s Azure DevOps connection to import its skills.' };
    vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([repository, { ...repository, projectId: 'two', projectName: 'Second', workspaceId: 'workspace-two' }]);
    await mount();
    expect(document.body.textContent).toContain('Azure DevOps organization access');
    expect(document.body.textContent).toContain('Save authorization');
    expect([...document.querySelectorAll('a')].filter(link => link.textContent?.includes('Configure')).map(link => link.getAttribute('href')))
      .toEqual(['/projects/one/configuration', '/projects/two/configuration']);
  });
  it('identifies Azure project skill sources and directs connection repair to the project', async () => {
    context.sourceId = '';
    const source = { ...sourceFixture(), repositoryUrl: 'https://dev.azure.com/contoso/Platform/_git/Skills',
      fullName: 'contoso/Platform/Skills', accessScope: 'projects' as const,
      projects: [{ id: 'project-one', name: 'Platform', visibility: 'open' as const, active: true }],
      lastError: 'Azure DevOps project authorization is unavailable. Reconnect or select a connection.', repairAction: 'connection' as const };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([source]);
    await mount();
    expect(document.body.textContent).toContain('Azure DevOps');
    expect(document.querySelector('[aria-label="Azure DevOps"]')).not.toBeNull();
    expect([...document.querySelectorAll('a')].some(link => link.textContent === 'Manage project connection' && link.getAttribute('href') === '/projects/project-one/configuration')).toBe(true);
  });

  async function openRemoval(disconnected = false) {
    context.sourceId = '';
    const source = { ...sourceFixture(), companyId: 'company-1', enabled: !disconnected };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([source]);
    await mount();
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${source.fullName}"]`)!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
    const menu = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === (disconnected ? 'Remove source' : 'Disconnect source'))!;
    await act(async () => menu.click()); await flush();
    return source;
  }

});

