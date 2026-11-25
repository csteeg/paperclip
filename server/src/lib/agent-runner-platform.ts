import { execFile } from "node:child_process";
import { paperclipRunnerSupportsPlatform } from "@paperclipai/shared";

type LocalRunnerTarget = {
  driver: "local";
  platform: NodeJS.Platform;
  architecture: string;
  libc?: "glibc" | "unknown";
  glibcVersion?: string;
};

/**
 * Delays between re-probes after `getconf` itself failed (timeout, spawn
 * error). The last delay repeats. A failed probe is not an answer about the
 * platform, so it must not disable the Paperclip Runner for the whole process.
 */
const LIBC_REPROBE_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

type LibcProbe =
  | { status: "measured"; libc: "glibc"; glibcVersion: string }
  | { status: "unrecognized" }
  | { status: "failed" };

async function probeLibc(): Promise<LibcProbe> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("getconf", ["GNU_LIBC_VERSION"], {
        encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1_024,
      }, (error, output) => error ? reject(error) : resolve(output));
    });
    const version = /^glibc\s+(\d+\.\d+(?:\.\d+)?)$/.exec(stdout.trim())?.[1];
    return version ? { status: "measured", libc: "glibc", glibcVersion: version } : { status: "unrecognized" };
  } catch {
    return { status: "failed" };
  }
}

function targetFor(probe: LibcProbe | null): LocalRunnerTarget {
  const target: LocalRunnerTarget = {
    driver: "local", platform: process.platform, architecture: process.arch,
  };
  if (!probe) return target;
  if (probe.status === "measured") return { ...target, libc: probe.libc, glibcVersion: probe.glibcVersion };
  return { ...target, libc: "unknown" };
}

function scheduleReprobe(attempt: number) {
  const delay = LIBC_REPROBE_DELAYS_MS[Math.min(attempt, LIBC_REPROBE_DELAYS_MS.length - 1)]!;
  const timer = setTimeout(() => {
    void probeLibc().then((probe) => {
      if (probe.status === "failed") {
        scheduleReprobe(attempt + 1);
        return;
      }
      localTarget = targetFor(probe);
    });
  }, delay);
  timer.unref?.();
}

async function detectLocalRunnerTarget(): Promise<LocalRunnerTarget> {
  if (process.platform !== "linux") return targetFor(null);
  const probe = await probeLibc();
  if (probe.status === "failed") scheduleReprobe(0);
  return targetFor(probe);
}

let localTarget = await detectLocalRunnerTarget();

export function localAgentRunnerTarget(): LocalRunnerTarget {
  return { ...localTarget };
}

export function localPaperclipRunnerSupported(): boolean {
  const target = localAgentRunnerTarget();
  return paperclipRunnerSupportsPlatform("codex_local", target.platform, target.architecture, target.libc, target.glibcVersion);
}
