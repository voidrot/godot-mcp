export interface ProcOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  // Aborting kills the process group like a timeout does.
  signal?: AbortSignal;
  // Delay between SIGTERM and SIGKILL. Tests shorten it.
  killGraceMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcResult {
  // null when a signal ended the process.
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

// Process groups of live children, so server shutdown can kill them.
const liveGroups = new Set<number>();

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

export function killAllGroups(): void {
  for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  liveGroups.clear();
}

// Kills every child group when the server is told to stop or its client goes away.
export function installShutdownCleanup(): void {
  const stop = (code: number) => () => {
    killAllGroups();
    process.exit(code);
  };
  process.on("SIGINT", stop(130));
  process.on("SIGTERM", stop(143));
  process.stdin.on("end", stop(0));
}

// Runs argv (never a shell string) in its own process group. A timeout or abort
// sends SIGTERM to the group, then SIGKILL after the grace period. Once the
// leader exits, any stragglers in the group are killed at once.
export async function runProc(
  argv: string[],
  opts: ProcOptions,
): Promise<ProcResult> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const pgid = child.pid;
  liveGroups.add(pgid);

  let timedOut = false;
  let aborted = false;
  let killTimer: Timer | undefined;
  const terminate = () => {
    if (killTimer !== undefined) return;
    killGroup(pgid, "SIGTERM");
    killTimer = setTimeout(
      () => killGroup(pgid, "SIGKILL"),
      opts.killGraceMs ?? 5000,
    );
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, opts.timeoutMs);
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const readers = [
    pump(child.stdout, opts.onStdout),
    pump(child.stderr, opts.onStderr),
  ];
  try {
    await child.exited;
    // The pipes only close once every group member is gone.
    killGroup(pgid, "SIGKILL");
    await Promise.all(readers);
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    liveGroups.delete(pgid);
  }
  return {
    exitCode: child.exitCode,
    timedOut,
    aborted,
    durationMs: Math.round(performance.now() - started),
  };
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: ((chunk: string) => void) | undefined,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const bytes of stream) {
    const text = decoder.decode(bytes, { stream: true });
    if (text !== "") onChunk?.(text);
  }
  const rest = decoder.decode();
  if (rest !== "") onChunk?.(rest);
}

// Keeps the last `max` bytes' worth of characters from a stream of chunks.
export class Tail {
  private text = "";
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max) {
      this.text = this.text.slice(-this.max);
      this.truncated = true;
    }
  }

  toString(): string {
    return this.text;
  }
}
