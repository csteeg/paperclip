import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Filesystem helpers for retiring native session copies (failover backups and local provider homes). */
export const EXPIRED_PREFIX = ".expired-";
export const RETIRING_PREFIX = ".retiring-";
export const LOCAL_PROVIDER_HOME = "codex-home";
export const LOCAL_PROVIDER_HOME_RETIRING = "provider-home-retiring";
export const LOCAL_PROVIDER_HOME_EXPIRED = "provider-home-expired";

export function missingPath(error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return null;
  throw error;
}

export async function isRealDirectory(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch(missingPath);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

export async function removeBackupTree(target: string): Promise<void> {
  const prepare = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat?.isDirectory()) return;
    await fs.chmod(current, (stat.mode & 0o777) | 0o700);
    for (const name of await fs.readdir(current)) await prepare(path.join(current, name));
  };
  await prepare(target);
  await fs.rm(target, { recursive: true, force: true });
}

export async function allocatedBytes(target: string): Promise<number> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  let bytes = stat.blocks * 512;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of await fs.readdir(target).catch(() => [] as string[])) {
      bytes += await allocatedBytes(path.join(target, entry));
    }
  }
  return bytes;
}

export type RetentionTarget = { path: string; retiring: string; trash: string; local: boolean };

/** The disposable session copies in a root: a remote failover copy and a local provider home. */
export async function retentionTargets(root: string): Promise<RetentionTarget[]> {
  const backupRoot = path.join(root, "failover-backups");
  const id = randomUUID();
  const targets: RetentionTarget[] = [];
  for (const target of [
    { path: path.join(backupRoot, "current"), retiring: path.join(backupRoot, `${RETIRING_PREFIX}${id}`),
      trash: path.join(backupRoot, `${EXPIRED_PREFIX}${id}`), local: false },
    { path: path.join(root, LOCAL_PROVIDER_HOME), retiring: path.join(root, LOCAL_PROVIDER_HOME_RETIRING),
      trash: path.join(root, LOCAL_PROVIDER_HOME_EXPIRED), local: true },
  ]) {
    if (await isRealDirectory(target.path)) targets.push(target);
  }
  return targets;
}

/** Restores a local provider home whose retirement never committed, and finishes an interrupted removal. */
export async function settleLocalProviderHome(root: string) {
  const home = path.join(root, LOCAL_PROVIDER_HOME);
  const retiring = path.join(root, LOCAL_PROVIDER_HOME_RETIRING);
  if (await isRealDirectory(retiring)) {
    if (await fs.lstat(home).catch(missingPath)) await removeBackupTree(retiring);
    else await fs.rename(retiring, home);
  }
  const trash = path.join(root, LOCAL_PROVIDER_HOME_EXPIRED);
  if (await isRealDirectory(trash)) await removeBackupTree(trash);
}

export async function newestModification(targets: RetentionTarget[]): Promise<number> {
  let newest = Number.NEGATIVE_INFINITY;
  for (const target of targets) newest = Math.max(newest, (await fs.stat(target.path)).mtime.getTime());
  return newest;
}
