import { afterEach, describe, expect, it, vi } from "vitest";
import { access, chmod, mkdtemp, mkdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";
import { WINDOWS_CREDENTIAL_FILE_SOURCE } from "./windows-credential-file-source.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string | undefined;
function usePlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value });
}
async function credentialHome() {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-credential-read-"));
  const home = path.join(root, "private");
  await mkdir(home, { mode: 0o700 });
  return home;
}
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  if (root) await rm(root, { force: true, recursive: true });
  root = undefined;
});

describe("isolated subscription credential read", () => {
  it.skipIf(process.platform !== "win32")("accepts a regular private Windows credential file without POSIX uid/mode assertions", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "test credential", { mode: 0o600 });
    await chmod(file, 0o644); // Windows file modes cannot be used for this check.
    usePlatform("win32");
    expect(await readLocalAiCredentialFile(file)).toBe("test credential");
  });

  it.skipIf(process.platform === "win32")("rejects a Windows credential symlink", async () => {
    const home = await credentialHome();
    const target = path.join(root!, "elsewhere");
    await writeFile(target, "not a credential");
    const link = path.join(home, ".credentials.json");
    await symlink(target, link);
    await expect(readLocalAiCredentialFile(link)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked Windows login directory", async () => {
    const home = await credentialHome();
    const link = path.join(root!, "redirect");
    await symlink(home, link, "dir");
    await writeFile(path.join(home, ".credentials.json"), "not valid");
    await expect(readLocalAiCredentialFile(path.join(link, ".credentials.json"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("rejects a Windows login directory junction", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "not valid");
    const junction = path.join(root!, "redirect-junction");
    await symlink(home, junction, "junction");

    await expect(readLocalAiCredentialFile(path.join(junction, ".credentials.json"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("rejects a higher junction ancestor above a real login directory", async () => {
    const home = await credentialHome();
    await writeFile(path.join(home, ".credentials.json"), "other session credential");
    const junction = path.join(root!, "higher-junction");
    await symlink(root!, junction, "junction");
    await expect(readLocalAiCredentialFile(path.join(junction, "private", ".credentials.json"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("pins every ancestor until the credential read finishes", async () => {
    await credentialHome();
    const execute = promisify(execFile), owned = path.join(root!, "owned"), moved = path.join(root!, "moved"), other = path.join(root!, "other");
    await mkdir(path.join(owned, "login"), { recursive: true });
    await mkdir(path.join(other, "login"), { recursive: true });
    const filename = path.join(owned, "login", "auth.json");
    await writeFile(filename, "own session credential");
    await writeFile(path.join(other, "login", "auth.json"), "other session credential");
    const source = path.join(root!, "Race.cs"), executable = path.join(root!, "Race.exe"), ready = path.join(root!, "ready"), release = path.join(root!, "release");
    await writeFile(source, WINDOWS_CREDENTIAL_FILE_SOURCE + String.raw`
public static class CredentialRaceHarness {
  public static int Main(string[] args) {
    try {
      var result = WindowsCredentialReader.Read(args[0], () => {
        System.IO.File.WriteAllText(args[1], "ready");
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!System.IO.File.Exists(args[2])) {
          if (DateTime.UtcNow > deadline) throw new IOException("test handshake timed out");
          System.Threading.Thread.Sleep(10);
        }
      });
      Console.Write(System.Text.Encoding.UTF8.GetString(result)); return 0;
    } catch { return 1; }
  }
}`);
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    let compiler = path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!(await stat(compiler).catch(() => null))?.isFile()) compiler = path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
    await execute(compiler, ["/nologo", "/target:exe", "/main:CredentialRaceHarness", `/out:${executable}`, source], { windowsHide: true, timeout: 30_000 });
    const running = execute(executable, [filename, ready, release], { windowsHide: true, timeout: 15_000 })
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    let redirected = false;
    try {
      await vi.waitFor(async () => { await access(ready); }, { timeout: 5_000, interval: 10 });
      try { await rename(owned, moved); await symlink(other, owned, "junction"); redirected = true; }
      catch (error) { expect(["EPERM", "EACCES", "EBUSY"]).toContain((error as NodeJS.ErrnoException).code); }
      await writeFile(release, "continue");
      const result = await running;
      expect(result.error).toBeNull();
      expect(result.value?.stdout).toBe("own session credential");
      expect(redirected).toBe(false);
    } finally {
      await writeFile(release, "continue"); await running;
      if (redirected) { await rm(owned, { force: true }); await rename(moved, owned); }
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("rejects oversized Windows credentials", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "x".repeat(64 * 1024 + 1));
    usePlatform("win32");
    await expect(readLocalAiCredentialFile(file)).rejects.toThrow("Invalid credential file");
  });

  it.skipIf(process.platform !== "win32")("reads refreshed bytes with a reused helper and restored timestamps", async () => {
    const file = path.join(await credentialHome(), "auth.json");
    await writeFile(file, "credential one");
    const before = await stat(file);
    expect(await readLocalAiCredentialFile(file)).toBe("credential one");
    await writeFile(file, "credential two");
    await utimes(file, before.atime, before.mtime);
    expect(await readLocalAiCredentialFile(file)).toBe("credential two");
  });

  it.skipIf(process.platform === "win32")("keeps the original POSIX owner/mode policy", async () => {
    const home = await credentialHome();
    const file = path.join(home, ".credentials.json");
    await writeFile(file, "private", { mode: 0o600 });
    expect(await readLocalAiCredentialFile(file)).toBe("private");
    await chmod(file, 0o644);
    await expect(readLocalAiCredentialFile(file)).rejects.toThrow();
  });
});
