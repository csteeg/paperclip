import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, success } from './controller-fixture.mjs';
import { canonical, sha256 } from './manifest.mjs';
const runtime = process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME ? pathToFileURL(resolve(process.env.PAPERCLIP_CONTROLLER_TEST_RUNTIME) + '/') : import.meta.url;
const { hostedPaths, hostedPolicyConfiguration, prepareHostedManifest, verifyHostedCell } = await import(new URL('./hosted.mjs', runtime));
const { packControlledAttempt, summarizeControlledManifest } = await import(new URL('./archive.mjs', runtime));

async function campaign(t) {
  const f = await fixture(t, { count: 2, observability: true });
  const runId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000)), paths = hostedPaths(runId);
  t.after(() => rm(paths.root, { recursive: true, force: true }));
  await mkdir(join(paths.runner, 'portable/dist/cli'), { recursive: true });
  const artifacts = {};
  for (const [name, relative] of [['runnerCli', 'portable/dist/cli/eval-session.js'], ['runnerPackage', 'paperclip-runner.tgz'], ['runnerd', 'paperclip-runnerd']]) {
    artifacts[name] = { ...f.manifest[name], path: join(paths.runner, relative) };
    await cp(f.manifest[name].path, artifacts[name].path);
  }
  const cells = f.requests.map(({ request }, index) => ({ cellId: `execution-${index}`, provider: request.provider, model: request.model }));
  const catalog = { schema: 'paperclip.runner-protocol-eval.catalog/v1', campaignId: `gha-${runId}-1`,
    source: { paperclipSha: f.manifest.sourceRevision, evalsSha: f.manifest.definitionsRevision },
    cells, matrices: cells.map(cell => ({ include: [cell] })) };
  const catalogSha256 = sha256(canonical(catalog));
  for (const item of f.requests) { item.request.runnerd = artifacts.runnerd; await writeFile(item.requestPath, JSON.stringify(item.request)); }
  const prepared = { schema: 'paperclip.runner-eval.prepared-requests/v1', campaignId: catalog.campaignId, githubRunId: runId, githubRunAttempt: 1,
    sourceRevision: f.manifest.sourceRevision, definitionsRevision: f.manifest.definitionsRevision, catalogSha256, runnerd: artifacts.runnerd,
    cells: cells.map((cell, index) => ({ cellId: cell.cellId, runId: `${catalog.campaignId}-${cell.cellId}`, request: f.requests[index].request })) };
  const { provisionalBound, ...observability } = f.manifest.observability;
  const { executionId, attemptId, requestSha256, ...allocation } = f.manifest.attempts[0];
  const policy = { schema: 'paperclip.runner-eval.hosted-policy/v1', maxUsd: f.manifest.maxUsd, maxCells: 2, durationMs: 60000,
    pricingVerifiedAt: f.manifest.pricingVerifiedAt, pricingExpiresAt: f.manifest.pricingExpiresAt,
    route: 'direct', models: f.manifest.models, overhead: f.manifest.overhead, observability, allocations: [allocation] };
  policy.capacityBound = { version: 1, scope: 'full_lifecycle', evidenceSha256: 'a'.repeat(64), configurationSha256: sha256(canonical(hostedPolicyConfiguration(policy))) };
  const environment = { ...f.environment, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: f.manifest.sourceRevision, PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA: prepared.sourceRevision, PAPERCLIP_PROTOCOL_EVALS_SHA: prepared.definitionsRevision };
  const input = { catalog, catalogSha256, prepared, policy, artifacts, environment };
  const build = () => prepareHostedManifest(input);
  return { f, input, paths, environment, build };
}

test('one prepared manifest binds disjoint workers and retains partial or entirely missing campaigns', async t => {
  const c = await campaign(t), result = c.build();
  Object.assign(c.f.manifest, result.manifest); await c.f.save();
  const empty = await summarizeControlledManifest(result.manifest, []);
  assert.equal(empty.incompleteAttempts, 2); assert.equal(empty.heldUsd, '0.024000000');
  assert.equal(empty.costStatus, 'incomplete');
  Object.assign(c.f.environment, c.environment, { PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' });
  assert.equal((await c.f.run(0, () => success())).code, 0);
  const bundle = await packControlledAttempt({ manifest: result.manifest, attemptId: 'attempt-0', environment: c.f.environment });
  const partial = await summarizeControlledManifest(result.manifest, [bundle, bundle]);
  assert.equal(partial.incompleteAttempts, 1); assert.equal(partial.knownUsd, '0.000136000');
  assert.equal(partial.heldUsd, '0.014000000'); assert.equal(partial.operatingHeldUsd, '0.004000000');
  Object.assign(c.f.environment, { PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-1' });
  assert.equal((await c.f.run(1, () => success())).code, 0);
  const second = await packControlledAttempt({ manifest: result.manifest, attemptId: 'attempt-1', environment: c.f.environment });
  const complete = await summarizeControlledManifest(result.manifest, [bundle, second]);
  assert.equal(complete.incompleteAttempts, 0); assert.equal(complete.knownUsd, '0.000272000');
  assert.equal(complete.heldUsd, '0.004000000'); assert.equal(complete.costStatus, 'provisional');
  await assert.rejects(summarizeControlledManifest({ ...result.manifest, maxUsd: '2' }, [bundle]), /retained campaign manifest/);
});

test('hosted preparation rejects selection drift, unsupported cells and unreviewed or insufficient budgets', async t => {
  const c = await campaign(t);
  const changes = [
    input => { input.prepared.definitionsRevision = 'd'.repeat(40); },
    input => { input.prepared.catalogSha256 = '0'.repeat(64); },
    input => { input.catalog.matrices[1].include = input.catalog.matrices[0].include; },
    input => { input.prepared.cells[1] = input.prepared.cells[0]; },
    input => { input.prepared.cells[0].request.provider = 'opencode'; },
    input => { input.policy.maxUsd = '0.01'; },
    input => { input.environment.GITHUB_RUN_ATTEMPT = '2'; },
    input => { input.environment.GITHUB_SHA = 'wrong'; },
    input => { input.environment.GITHUB_SHA = 'c'.repeat(40); },
    input => { delete input.policy.observability; },
  ];
  for (const change of changes) {
    const input = structuredClone(c.input); change(input);
    assert.throws(() => prepareHostedManifest(input));
  }
  const input = structuredClone(c.input); input.policy.maxUsd = '0.01';
  input.policy.capacityBound.configurationSha256 = sha256(canonical(hostedPolicyConfiguration(input.policy)));
  assert.throws(() => prepareHostedManifest(input), /budget/);
});

test('worker preflight verifies identical manifest bytes and current cell/run before credentials', async t => {
  const c = await campaign(t), { manifest, manifestSha256 } = c.build();
  await writeFile(c.paths.manifest, canonical(manifest));
  const input = { manifestPath: c.paths.manifest, manifestSha256, cellId: 'execution-0',
    environment: { ...c.environment, PAPERCLIP_RUNNER_EVAL_EXECUTION_ID: 'execution-0' } };
  assert.equal((await verifyHostedCell(input)).attempt.attemptId, 'attempt-0');
  await assert.rejects(verifyHostedCell({ ...input, cellId: 'another-cell' }), /outside/);
  await assert.rejects(verifyHostedCell({ ...input, environment: { ...input.environment, GITHUB_RUN_ATTEMPT: '2' } }), /first-attempt/);
  await writeFile(c.paths.manifest, canonical(manifest) + '\n');
  await assert.rejects(verifyHostedCell(input), /bytes changed/);
});
