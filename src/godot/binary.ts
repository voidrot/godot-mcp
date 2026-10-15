import { runProc } from "../proc.ts";

const VERSION_TIMEOUT_MS = 10_000;

export class GodotNotFoundError extends Error {
  override name = "GodotNotFoundError";

  constructor(bin: string) {
    super(
      `Godot binary "${bin}" was not found on PATH. Set GODOT_BIN to its path.`,
    );
  }
}

export function resolveGodotBin(
  env: Record<string, string | undefined> = process.env,
): string {
  const bin = env.GODOT_BIN || "godot-mono";
  const found = Bun.which(bin);
  if (found === null) throw new GodotNotFoundError(bin);
  return found;
}

export async function godotVersion(bin: string): Promise<string> {
  let stdout = "";
  const result = await runProc([bin, "--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });
  if (result.timedOut)
    throw new Error(
      `${bin} --version timed out after ${VERSION_TIMEOUT_MS} ms`,
    );
  if (result.exitCode !== 0)
    throw new Error(`${bin} --version exited with code ${result.exitCode}`);
  return stdout.trim();
}
