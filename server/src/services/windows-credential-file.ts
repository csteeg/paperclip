import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { WINDOWS_CREDENTIAL_FILE_SOURCE } from "./windows-credential-file-source.js";

const execute = promisify(execFile);
let executable: Promise<string> | undefined;

async function readerExecutable(): Promise<string> {
  executable ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-credential-reader-"));
    const source = join(directory, "CredentialReader.cs"), target = join(directory, "CredentialReader.exe");
    await writeFile(source, WINDOWS_CREDENTIAL_FILE_SOURCE);
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    let compiler = join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!(await stat(compiler).catch(() => null))?.isFile()) compiler = join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
    await execute(compiler, ["/nologo", "/target:exe", `/out:${target}`, source], { windowsHide: true, timeout: 30_000 });
    return target;
  })().catch(error => { executable = undefined; throw error; });
  return executable;
}

export async function readWindowsCredentialFile(filename: string): Promise<string> {
  if (!isAbsolute(filename) || /[\r\n\0]/.test(filename)) throw new Error("Invalid credential file");
  try {
    const reader = await readerExecutable();
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(reader, [], { windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024, encoding: "utf8" }, (error, output) => {
        if (error) reject(new Error("Invalid credential file")); else resolve(output);
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(`${filename}\n`);
    });
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stdout)) throw new Error("Invalid credential file");
    const bytes = Buffer.from(stdout, "base64");
    if (bytes.length > 64 * 1024) throw new Error("Invalid credential file");
    return bytes.toString("utf8");
  } catch { throw new Error("Invalid credential file"); }
}
