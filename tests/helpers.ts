import { cp, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const repo = join(import.meta.dir, "..");
export const fakeGodot = join(repo, "tests", "fakes", "fake-godot.sh");

// Fixtures are copied so `.godot/` never lands in the repo (plan D4).
export async function copyFixture(name = "gd"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "godot-mcp-"));
  await cp(join(repo, "fixtures", name), dir, { recursive: true });
  return await realpath(dir);
}

// Spawns a separate server process, as a Claude session would.
export async function connect(
  env: Record<string, string> = {},
): Promise<Client> {
  const client = new Client({ name: "godot-mcp-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, "src", "server.ts")],
      cwd: repo,
      env,
    }),
  );
  return client;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(25);
  }
}

export async function readPid(file: string): Promise<number | undefined> {
  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  return text.trim() === "" ? undefined : Number(text);
}
