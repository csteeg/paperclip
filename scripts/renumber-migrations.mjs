#!/usr/bin/env node
// Moves this branch's own Drizzle migrations behind the base branch's migrations.
//
// Usage (from anywhere inside a worktree):
//   node scripts/renumber-migrations.mjs [--base <ref>] [--start <number>] [--dry-run] [--skip-generate]
//
// "Own" migrations are the .sql files in packages/db/src/migrations that the base
// ref does not have. Their SQL stays byte-identical, so a database that already
// applied one recognizes it by hash and skips it. The script:
//   1. drops own files whose bytes equal a base migration (the base already ships
//      that SQL, for example after upstream landed a pull request) or another own
//      file (the same pull request migration under two numbers);
//   2. renames the rest to consecutive numbers after the base's newest migration,
//      or from --start (develop uses --start 8801, its fork-local range). With
//      --start, files already numbered in that range keep their order and come
//      first, so earlier fork-local numbers stay stable;
//   3. rebuilds meta/_journal.json as the base journal plus the own entries;
//   4. restores the base snapshots and regenerates only the newest snapshot;
//   5. runs the numbering, safety and compatibility checks against the base.
// It also works in the middle of a merge whose journal or snapshots conflict:
// the meta folder is rebuilt from the base instead of text-merged, as
// packages/db/.gitattributes requires. Stage the result with git add -A.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = "packages/db/src/migrations";
const META = `${MIGRATIONS}/meta`;
const JOURNAL = `${META}/_journal.json`;
const NUMBERED = /^(\d{4})_(.+)\.sql$/;

function parseArgs(argv) {
  const options = { base: null, start: null, dryRun: false, skipGenerate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") options.base = argv[++i];
    else if (arg === "--start") options.start = Number.parseInt(argv[++i], 10);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-generate") options.skipGenerate = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("node scripts/renumber-migrations.mjs [--base <ref>] [--start <number>] [--dry-run] [--skip-generate]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.start !== null && (!Number.isInteger(options.start) || options.start < 1 || options.start > 9999)) {
    throw new Error("--start must be a number between 1 and 9999");
  }
  return options;
}

function git(args, { buffer = false } = {}) {
  return execFileSync("git", args, { encoding: buffer ? "buffer" : "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function gitOrNull(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function refExists(ref) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

function run(label, command, cwd) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, { cwd, shell: true, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function migrationNumber(name) {
  const match = name.match(NUMBERED);
  if (!match) throw new Error(`Migration file does not start with a 4-digit number: ${name}`);
  return Number.parseInt(match[1], 10);
}

function readJournal(text) {
  if (text === null) return null;
  try {
    const journal = JSON.parse(text);
    return Array.isArray(journal.entries) ? journal : null;
  } catch {
    return null;
  }
}

// The id git gives these bytes as a blob (SHA-1), comparable with ls-tree output.
const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  process.chdir(root);

  const base = options.base ?? ["upstream/master", "origin/master", "master"].find(refExists);
  if (!base || !refExists(base)) throw new Error(`Base ref not found: ${options.base ?? "upstream/master, origin/master or master"}`);

  const baseListing = git(["ls-tree", "--name-only", `${base}:${MIGRATIONS}`]).split("\n").filter(Boolean);
  const baseSql = new Set(baseListing.filter((name) => name.endsWith(".sql")));
  const baseSnapshots = git(["ls-tree", "--name-only", `${base}:${META}`]).split("\n")
    .filter((name) => name.endsWith("_snapshot.json"));
  const baseJournalText = git(["show", `${base}:${JOURNAL}`]);
  const baseJournal = readJournal(baseJournalText);
  if (!baseJournal) throw new Error(`Cannot read ${JOURNAL} at ${base}`);
  const baseMax = Math.max(...[...baseSql].map(migrationNumber));

  const currentSql = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
  const missing = [...baseSql].filter((name) => !currentSql.includes(name));
  if (missing.length > 0) {
    throw new Error(`${base} has migrations this worktree lacks (${missing.join(", ")}); merge ${base} first or pass --base <ref>`);
  }
  let own = currentSql.filter((name) => !baseSql.has(name));
  if (own.length === 0) {
    console.log(`No migrations beyond ${base}; nothing to renumber.`);
    return;
  }

  // Journal order and timestamps: the working journal, else (mid-merge, when it
  // has conflict markers) the journals of HEAD and of the branch being merged.
  const journals = [readJournal(readFileSync(JOURNAL, "utf8")), readJournal(gitOrNull(["show", `HEAD:${JOURNAL}`]))];
  if (refExists("MERGE_HEAD")) journals.push(readJournal(gitOrNull(["show", `MERGE_HEAD:${JOURNAL}`])));
  const journalOrder = new Map();
  const originalWhen = new Map();
  for (const journal of journals.filter(Boolean)) {
    journal.entries.forEach((entry, index) => {
      const file = `${entry.tag}.sql`;
      if (!journalOrder.has(file)) journalOrder.set(file, index);
      if (!originalWhen.has(file) && Number.isFinite(entry.when)) originalWhen.set(file, entry.when);
    });
  }

  const reserved = (file) => options.start !== null && migrationNumber(file) >= options.start;
  own.sort((a, b) => {
    if (reserved(a) !== reserved(b)) return reserved(a) ? -1 : 1;
    if (reserved(a)) return migrationNumber(a) - migrationNumber(b) || a.localeCompare(b);
    const ia = journalOrder.get(a) ?? Number.POSITIVE_INFINITY;
    const ib = journalOrder.get(b) ?? Number.POSITIVE_INFINITY;
    return ia === ib ? a.localeCompare(b) : ia - ib;
  });

  // Duplicates by content (git blob id): the base already ships the SQL, or an
  // earlier own file has it.
  const baseHashes = new Map();
  for (const line of git(["ls-tree", `${base}:${MIGRATIONS}`]).split("\n")) {
    const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.+\.sql)$/);
    if (match) baseHashes.set(match[1], match[2]);
  }
  const ownHashes = new Map();
  const duplicates = [];
  own = own.filter((file) => {
    const hash = blobId(readFileSync(path.join(MIGRATIONS, file)));
    const same = baseHashes.get(hash) ?? ownHashes.get(hash);
    if (same) {
      duplicates.push({ file, same });
      return false;
    }
    ownHashes.set(hash, file);
    return true;
  });

  const start = options.start ?? baseMax + 1;
  if (start <= baseMax) throw new Error(`--start ${start} must be above ${base}'s newest migration ${String(baseMax).padStart(4, "0")}`);
  if (start + own.length - 1 > 9999) throw new Error("Not enough 4-digit numbers left after --start");

  const plan = own.map((file, index) => {
    const number = String(start + index).padStart(4, "0");
    const name = file.match(NUMBERED)[2];
    return { from: file, to: `${number}_${name}.sql`, tag: `${number}_${name}` };
  });
  if (new Set(plan.map((step) => step.to)).size !== plan.length) throw new Error("Two migrations would get the same file name");

  console.log(`Base: ${base} (newest migration ${String(baseMax).padStart(4, "0")})`);
  for (const { file, same } of duplicates) console.log(`  ${file} -> removed (byte-identical to ${same})`);
  for (const step of plan) console.log(`  ${step.from} -> ${step.to}${step.from === step.to ? " (unchanged)" : ""}`);
  if (options.dryRun) return;

  // 1-2. Remove duplicates, then rename in two phases so no rename overwrites a file.
  for (const { file } of duplicates) rmSync(path.join(MIGRATIONS, file));
  const moving = plan.filter((step) => step.from !== step.to);
  for (const step of moving) renameSync(path.join(MIGRATIONS, step.from), path.join(MIGRATIONS, `${step.to}.renumbering`));
  for (const step of moving) {
    if (existsSync(path.join(MIGRATIONS, step.to))) throw new Error(`${step.to} already exists`);
    renameSync(path.join(MIGRATIONS, `${step.to}.renumbering`), path.join(MIGRATIONS, step.to));
  }

  // 3. Journal: base entries, then own entries with idx continuing and monotonic `when`.
  const entries = baseJournal.entries.map((entry) => ({ ...entry }));
  let lastWhen = Math.max(0, ...entries.map((entry) => entry.when ?? 0));
  for (const step of plan) {
    const when = Math.max(lastWhen + 1, originalWhen.get(step.from) ?? Date.now());
    lastWhen = when;
    entries.push({ idx: entries.length, version: baseJournal.entries.at(-1)?.version ?? "7", when, tag: step.tag, breakpoints: true });
  }
  const writeJournal = (list) => {
    const text = JSON.stringify({ ...baseJournal, entries: list }, null, 2);
    writeFileSync(JOURNAL, baseJournalText.endsWith("\n") ? `${text}\n` : text);
  };
  writeJournal(entries);

  // 4. Snapshots: exactly the base's, then one regenerated snapshot for the newest own migration.
  for (const name of readdirSync(META).filter((file) => file.endsWith("_snapshot.json"))) {
    rmSync(path.join(META, name));
  }
  for (const name of baseSnapshots) {
    writeFileSync(path.join(META, name), git(["show", `${base}:${META}/${name}`], { buffer: true }));
  }
  const db = path.join(root, "packages/db");
  if (!options.skipGenerate && plan.length > 0) {
    run("clean", "node scripts/clean.mjs", db);
    run("tsc", "node node_modules/typescript/bin/tsc -p tsconfig.json", db);
    run("drizzle-kit generate", "node node_modules/drizzle-kit/bin.cjs generate", db);
    const generated = readJournal(readFileSync(JOURNAL, "utf8")).entries.slice(entries.length);
    if (generated.length === 0) {
      console.log("\nSchema matches the base snapshot; no new snapshot was needed.");
    } else {
      const tag = generated[0].tag;
      const sql = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8");
      console.log(`\nSchema changes drizzle derived for this branch (compare with your migrations; this file is discarded):\n${sql}`);
      rmSync(path.join(MIGRATIONS, `${tag}.sql`));
      const newest = plan.at(-1).tag.slice(0, 4);
      renameSync(path.join(META, `${tag.slice(0, 4)}_snapshot.json`), path.join(META, `${newest}_snapshot.json`));
      writeJournal(entries);
    }
    run("prune snapshots", "node scripts/prune-snapshots.mjs", db);
  }

  // 5. Checks.
  run("migration numbering", "node node_modules/tsx/dist/cli.mjs src/check-migration-numbering.ts", db);
  run("migration safety", "node node_modules/tsx/dist/cli.mjs src/check-migration-safety.ts", db);
  run("migration compatibility", `node node_modules/tsx/dist/cli.mjs scripts/migration-compatibility.ts --check --base ${base}`, db);
  console.log(`\nDone. Review and stage with: git add -A ${MIGRATIONS}`);
}

try {
  main();
} catch (error) {
  console.error(`renumber-migrations: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
