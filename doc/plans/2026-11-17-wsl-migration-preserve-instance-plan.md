# WSL migration with full instance preservation — implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. The main chat owns implementation. This side chat only prepares and hands over the plan. Do not run competing migration work.

**Goal:** Run Paperclip, Codex and Claude in WSL while retaining every existing instance record, generated agent file, conversation and session, with a verified return path to Windows.

**Architecture:** Preserve the Windows source and take a consistent database-plus-filesystem recovery copy. Restore a separate Linux instance, translate only supported machine-specific configuration, prove both harnesses, then switch the live endpoint. Use the existing Paperclip Runner rather than adding a WSL-specific runner.

**Tech stack:** WSL2, Linux filesystem, Git, the repository-supported Node/pnpm/Rust versions, PostgreSQL, Paperclip Runner, Codex and Claude.

**Spec:** The user's decision on 2026-11-17: move to WSL, configure Codex and Claude, create one shared skill, and retain all data from the Windows instance, including all generated files and sessions.

## Status and verified facts

### Execution checkpoint, 2026-11-18

- Removed 18 verified clean task code roots. The first 17 contained 158 Git
  repositories; the older final root contained one more linked worktree.
  Original projects, attempt directories and generated outputs remain.
  The first cleanup reclaimed approximately 19.65 GiB. A verified 2.38 GiB Git
  recovery set and a separate full instance archive retain the removed code.
  The private recovery kit now has one `Restore-AllTaskCode.ps1` entrypoint.
  It defaults to a dry run and refuses to overwrite existing destinations.
- Independently verified the compressed instance archive, older referenced
  session directories and eight external skill snapshots. The operational
  Linux copy passed content checks for 1,707,271 regular files, plus 45,048
  files from older referenced directories and 36 external skill files.
  Windows physical database files stay in the recovery archive.
- Native PostgreSQL restore matched all 350 tables and 523,003 rows, including
  complete row hashes and submillisecond timestamps. The initial JavaScript
  backup restore lost timestamp precision; it was rejected. The native dump
  supersedes that failed proof.
- Linux build passed. The validation server answered health and company/agent
  reads on a separate port. The wiki plugin loaded after its stored machine
  paths were translated. Operational path changes and temporary pauses have
  private before/after receipts and company activity records.
- The first validation start ran a normal retention job despite disabled
  heartbeats. It removed 3,727 cached evidence files in the Linux copy. The
  server was stopped; all those files were restored from the unchanged source
  and verified. Subsequent validation explicitly disables those retention jobs.
- The user approved both sequential OS upgrades. Ubuntu was upgraded from
  22.04 through 24.04 to 26.04.1 LTS and restarted. Package audit is clean;
  glibc is 2.43 and Runner preflight passes. WSL was updated to 3.0.5 to
  provide the unified cgroup hierarchy required by the official upgrader.
  The original Docker container resumed healthy. Optional obsolete-package
  removal was declined to preserve existing tools. No drive was relocated.
- Cold server imports exposed a separate libc-probe timeout bug. A real-child
  regression reproduced it; the bounded asynchronous timeout fix passed all
  16 platform tests on both Ubuntu 24.04 and 26.04. It is pushed to the native
  runtime branch and existing PR #18144 as commit `6cd3585a9f`.
- The saved Codex account and selected model passed a real hello on Ubuntu
  24.04 in 4,976 ms. Claude's saved subscription resolved, but its CLI was
  absent from the service PATH. On 26.04 the existing pinned SDK's native
  Claude 2.1.286 binary is exposed through the scoped tool directory, without
  another installation. Post-upgrade account probes and full runs remain
  acceptance work; hello timing is not a complete agent-start benchmark.
- The shared WSL helper passed Windows-to-Linux and Linux preflight, argument
  preservation and conflicting-instance/configuration/database/port rejection.
  Its Runner preflight now checks the owning shared platform contract before
  expensive preparation. Independent review found the configuration override
  issue; the corrected guard passed its reproduced regression.
- Runtime preparation changes are saved on `codex/wsl-live-runtime-20261117`.
  Incremental verification reports an outstanding trusted SDK lock-policy
  update for the repaired integration lockfile. Required CI is not green.
  Existing PRs #18144 and #22033 remain open; neither was closed or overwritten.

The remaining acceptance work is post-upgrade account checks, real new and
resumed Codex/Claude runs, final data reconciliation, trusted lock/CI
qualification and controlled cutover. A healthy validation server is not
completion of this migration.

- This is a plan, not a completed migration or a backup receipt.
- Source configuration currently identifies `C:\.paperclip\instances\default`, embedded PostgreSQL under its `db` directory, local storage under `data/storage`, the original `secrets/master.key`, and port 3100.
- The current integration worktree points to a separate test instance on D:. Do not mistake it for the user's source instance.
- Ubuntu is installed. The separate `PaperclipSkillQualification-20261117` distro is a qualification environment, not the production migration destination.
- At planning time C: has approximately 58.7 GiB free and D: 11.9 GiB. An earlier inventory measured about 105 GB of logical source data. Logical size is not allocated size; neither proves the migration will fit.
- `doc/database-backups.md` explicitly states that database backups are not full instance filesystem backups.
- There has been one successful native Linux Codex qualification run. That does not prove migration of the full instance, Claude readiness, or portability of all existing sessions.

### Backup maintenance update, 2026-11-17

The user separately approved removal of 132 older or incomplete database backups.
Read-only verification now finds three backups, totaling 649,336,437 bytes:
`paperclip-20261117-140602.sql.gz`, `paperclip-20261117-124126.sql.gz`, and
`paperclip-20261117-104632.sql.gz`. The earlier 20.8 GiB backup inventory is obsolete.
The maintenance receipts report complete gzip and SQL end-marker checks, with
unchanged SHA-256 values after cleanup. A database restore test is still required.
The private receipts are in the source instance's `data/backup-maintenance/`.

The delegated post-cleanup measurement reports approximately 77.9 GiB of logical
instance data. The first migration metadata scan ran before that cleanup and is
not a current recovery manifest. Reconcile or repeat it at the final snapshot.
No additional source cleanup is authorized by this exception.

### Task-code cleanup exception, 2026-11-17

The user subsequently authorized removing clean task repository copies before
migration, with a recovery script. Inventory found 17 code roots containing 158
repositories, including nested linked worktrees. Preserve their commits, refs,
reflogs and Git metadata in a verified, deduplicated recovery set before removal.
Recheck clean status and process ownership immediately before deletion. Keep the
attempt directories and seed records, project sources, agent outputs, provider
homes, conversations and session history. This exception applies only to the
verified task code roots; it does not authorize broader instance cleanup.
The recovery set becomes an external dependency of the migration and must be
included in the final recovery inventory. Old-session continuation still needs
verification; do not assume that retaining Git bundles alone proves it.

The local configuration now sets `database.backup.intervalMinutes=1440` and
`database.backup.retentionDays=3`. At the next authorized server start, also set
the database-owned general setting through its API and verify it with GET:

```json
{"backupRetention":{"dailyDays":3,"weeklyWeeks":1,"monthlyMonths":1}}
```

These are the lowest supported retention presets, not a hard three-file limit.
Do not restart the server solely to apply this pending setting. Initial migration
validation must still keep backup and retention jobs disabled as described below.

## Global constraints

- Preserve the complete Windows instance and externally referenced user data. No destructive cleanup, retention expiry, source deletion or exclusion of agent-generated files to make the migration fit.
- Keep the source stopped or write-fenced for the final consistency boundary. Never run two schedulers or agent executors against cloned live state.
- Do not use the ordinary development seed workflow for production migration: it can quarantine runs, reset agents, pause routines or anonymize data. An intentionally paused validation copy needs a separate, auditable record of temporary changes and their restoration.
- Do not copy Windows PostgreSQL data files into a Linux PostgreSQL cluster. Use the supported logical backup and restore path, preserving application IDs and history.
- Keep original encrypted secrets and their key together. Treat auth files, environment files, snapshots, logs and session archives as confidential. Never commit them or print their contents.
- Linux tools, repositories, dependencies and runtime data must live inside the Linux filesystem. The distro's virtual disk can be on D: if capacity permits; `/mnt/c` and `/mnt/d` are transfer paths, not the final working data paths.
- Native Windows-specific development is no longer an acceptance goal. Generic integrity checks, provider confinement and portable fixes remain required.
- The user's migration authorization permits implementation. Do not repeat routine approval questions. A capacity shortfall or a choice between unavailable storage destinations needs a concrete user decision; time passing is not permission to delete source data.

## Review focus

1. Files outside the main instance root, including junction targets, Git worktree common directories, temporary attachment paths and provider homes, must be inventoried and preserved.
2. Database references and filesystem bytes must represent the same final snapshot. Changes after the first copy require a final delta and verification.
3. Runtime identity, saved digests and credentials must not be corrupted by broad Windows-to-Linux string replacement.
4. Retaining session history is distinct from resuming a live Windows process. Unsupported live sessions must end at a durable checkpoint with a visible continuation path.
5. Reverting to Windows after Linux has accepted new writes requires recovery of those writes, not simply starting the old Windows database.

## Task 1 — establish ownership, source inventory and capacity

- [ ] Coordinate with the main chat and record its current branches, active test runs and processes. Preserve unfinished changes and existing merge work.
- [ ] Confirm the actual live process, instance configuration, storage provider, PostgreSQL version, source revision, instance ID and any external database/storage services. Do not infer these from the current worktree.
- [ ] Produce a private inventory of all regular files, byte sizes, hashes, timestamps, directories and reparse points. Do not follow junctions recursively without an explicit target inventory. Preserve empty directories and link targets.
- [ ] Inventory at least: `data`, attachments and artifacts, `companies`, `projects`, `w`, `workspaces`, isolated workspaces/attempts, `skills`, `runtime-context-assets`, `runtime`, runtime services/logs, accounting receipts, wiki, telemetry, logs, backups, local logins, secrets and configuration.
- [ ] Inventory external dependencies: repository common Git directories and worktrees, untracked/ignored generated files, Git LFS data, plugin sources, provider conversation/session homes and downloaded outputs. Preserve unstaged/staged changes, local branches, stashes and unpushed commits. A Git bundle alone does not include the whole working directory.
- [ ] Record database counts and ID sets for organizations, users, memberships, agents, issues, comments, documents, attachments, runs/events, sessions, skills/version pins, account bindings, approvals and other persisted state.
- [ ] Measure allocated source bytes and expected restored Linux bytes, including growth headroom. Compression may reduce an archive but does not remove restored-space requirements. Select an adequate destination before creating a large archive or distro.
- [ ] If capacity is insufficient, report the measured shortfall and obtain a storage destination decision. Do not automatically use C: or delete caches, backups or workspaces.

**Deliverable:** private inventory, source identity, path/dependency map, capacity calculation and selected destination. Nothing has been cut over.

## Task 2 — create and test a complete recovery copy

- [ ] Define a short final write-free window. Pause new task admission and schedules through owning APIs, recording previous settings. Drain active tasks to durable checkpoints where possible. Do not silently mark unfinished runs successful or wipe their recovery state.
- [ ] Preserve a first copy while the source is available if capacity and tooling support a consistent final delta. At the final boundary stop/fence writers and create the logical database backup plus remaining filesystem copy from the same boundary.
- [ ] Include the complete inventory, externally referenced payloads and original secrets key. Preserve original paths as migration metadata. Preserve raw Windows ACL/link metadata in the recovery archive where tooling supports it; use appropriate Linux ownership on restored operational files.
- [ ] Independently read the recovery copy, verify manifests and hashes, and perform a logical database restore test. Confirm archive completeness rather than accepting the mere existence of a `.gz` file.
- [ ] Keep the original Windows instance and at least one independently verified recovery copy. Do not count two names for the same bytes as two independent backups.

**Deliverable:** consistent recovery set, restore receipt and source-to-backup reconciliation. A DB-only dump is not sufficient.

## Task 3 — prepare Linux and restore without activating cloned work

- [ ] Inspect the existing Ubuntu distro, user, ownership, configuration and unrelated services before making changes. Use a selected normal-user environment, separate from the qualification distro and Docker Desktop internals.
- [ ] Place the chosen distro's virtual disk on the approved storage destination. Use native Linux paths for the checkout, Paperclip home and provider homes. Install repository-supported runtimes and dependencies inside Linux; do not reuse Windows `node_modules` or executables.
- [ ] Restore into a fresh compatible Linux PostgreSQL cluster and separate Paperclip home. Initially use the same compatible source revision/schema so that migration and product upgrade are not coupled.
- [ ] Restore the complete file inventory and original secrets key. Create a private mapping from each preserved Windows root to its Linux operational root. Keep the original recovery copy unchanged.
- [ ] Audit schema-owned path columns, JSON config, attachments, plugin locations, Git worktree links and runtime state. Convert supported configuration through owning services/migration code, in transactions with before/after records. Do not globally replace `C:\` strings in JSON or change saved content digests, IDs, signatures or executable identity claims.
- [ ] For every archived/generated artifact, prove both byte equality and a usable application reference. Retain unresolved references as explicit blockers rather than dropping rows or hiding files.
- [ ] Start validation on a separate private port with outbound task admission, recurring work, notifications and retention disabled before startup through supported controls. If startup mutates cloned run state, capture and reconcile it; never apply test-instance quarantine scripts to the migration baseline.

**Deliverable:** isolated Linux restoration with complete data reconciliation and no duplicate external actions.

## Task 4 — configure Codex, Claude and session continuity

- [ ] Use the repository's supported provider-pack/CLI installation paths and versions. Verify binaries resolve to Linux executables under the chosen Linux user. Do not rely on an interactive shell profile to supply service PATH.
- [ ] Preserve Paperclip accounts, encrypted credentials, grants and memberships. Validate Linux authentication using existing authorized bindings. Some Windows credential stores are OS-bound; retain them and request interactive reauthentication only if the supported export/import cannot recover Linux access.
- [ ] Restore provider session histories and working files. Inventory each session's provider, model, lifecycle, saved context, transcript, workspace, checkpoints and recovery schema.
- [ ] Do not transplant Windows PIDs, named pipes, kernel jobs, MXC state or stale execution leases as Linux process authority. Preserve their historical records; use supported retirement/checkpoint/continuation behavior.
- [ ] Test a representative old Codex session and old Claude session: display earlier history, open existing generated output, continue in the preserved workspace and confirm prior context is available. Record any session that requires a fresh process or provider thread. No claim of universal live-session portability without evidence.
- [ ] Test both harnesses through real Paperclip agents using the existing authorized accounts: skill discovery/read, workspace access, a synthetic generated artifact, cancellation, controlled restart, recovery and final artifact download. Use dedicated diagnostic tasks rather than modifying product work.
- [ ] Compare migrated account and agent permissions with the source. Missing credentials do not justify broad new grants or authentication bypasses.

**Deliverable:** working Codex and Claude agent runs, session compatibility report and verified accessibility of historical data. Any unsupported required continuation is a cutover blocker until resolved or explicitly accepted by the user.

## Task 5 — one shared WSL skill and clear project instructions

**Proposed source files:** `.agents/skills/paperclip-wsl/SKILL.md`, a thin Claude discovery entry if needed, and small references in `AGENTS.md` / `CLAUDE.md`. Confirm each tool's supported skill discovery before choosing the projection. Never edit installed plugin-cache copies as the source of truth.

- [ ] Keep one canonical skill, discoverable by both tools through a supported Linux link or generated projection. Preserve all existing project instructions.
- [ ] Scope it to this Paperclip workflow. Describe the selected distro/user, configured Linux checkout and instance paths, safe command entry from Windows, dev start/stop, tests and release-image checks. Store machine-specific values locally; do not publish usernames, credentials or private paths in a public skill.
- [ ] Require Git, package installation, builds, migrations, tests and provider processes to run inside Linux. A Windows editor is fine. Existing Windows data is a preserved migration source, not an automatically mutable live workspace.
- [ ] Add a small preflight using existing tooling where possible: verify Linux OS, selected checkout/home, correct instance/port, executable paths and sufficient storage. Fail clearly on a Windows Node/CLI or a mistaken test instance; do not auto-migrate data or bypass controls.
- [ ] Check a Windows-launched assistant and a Linux-launched assistant both discover the instruction and select the correct Linux checkout. Test quoting, spaces and Unicode paths if a Windows launch helper is needed.
- [ ] Validate through one Codex-led and one Claude-led Paperclip diagnostic task. Record which instructions and actual binaries were used.

**Deliverable:** a small shared skill and proven workflow, not a second runner or broad tooling rewrite.

## Task 6 — reconcile PRs and qualify the intended image

- [ ] Inventory open Windows-related PRs and their current heads/reviews. For #18144, separate indispensable cross-platform process, packaging, recovery and performance work from Windows-only support. Preserve useful commits in focused upstream work before closing any Windows-only remainder.
- [ ] Keep #22033's shared repository work: duplicate repository copies are also a Linux problem. Finish its relevant review fixes and Linux tests.
- [ ] Record the disposition of each PR and retained commit. Do not close unrelated PRs or drop useful code based only on a Windows title.
- [ ] Complete affected local verification and required final-head CI. Build and test the intended Linux deployment image when code is ready; do not require an image rebuild for every development edit.

**Deliverable:** reviewable pushed branches, clear PR disposition, final-revision checks and a tested Linux artifact.

## Task 7 — controlled cutover, return path and final reconciliation

- [ ] Before cutover, confirm there is no write gap between the final source snapshot and restored Linux state. If Windows resumed during qualification, repeat the final consistent delta and DB restore/reconciliation rather than discarding intervening work.
- [ ] Require matching source/target ID sets and file hashes, zero unexplained missing artifacts, readable historical conversations, validated secrets and both provider pilots. Record benign path/permission/operational-state changes separately from preserved business data.
- [ ] Stop the Windows executor/server through its owning lifecycle and verify process settlement. Keep its files and backup. Start the Linux instance on the intended endpoint, then reenable only the schedules, integrations and tasks that were previously enabled.
- [ ] Verify browser login, organizations, task history, generated-file downloads, one existing-session continuation per harness and new Codex/Claude runs. Confirm no duplicate schedules or stale source writers.
- [ ] Before Linux accepts new writes, a failed cutover can return to the intact Windows source. After Linux accepts writes, first stop Linux writers and preserve/reconcile all new DB and filesystem state through a supported reverse restore; never simply restart the old Windows database and lose Linux work.
- [ ] Keep the original Windows data and verified recovery set after acceptance. Source deletion or expiry of this migration backup is a separate explicit user decision.
- [ ] Publish a concise report: chosen Linux paths, actual binaries/versions, preserved counts/bytes, session limitations, account/permission checks, timings, PR links, backup/restore receipts and rollback procedure. Keep raw private evidence out of Git.

**Done means:** Paperclip and both harnesses run in WSL; all existing data is reconciled and accessible; session continuation behavior is proven or its remaining limitation explicitly accepted; the shared skill is active; final code checks pass; and a tested recovery path exists. Merely copying a database or obtaining one successful fresh agent run is not completion.
