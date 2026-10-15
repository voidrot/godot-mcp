import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class ProjectBusyError extends Error {
  override name = "ProjectBusyError";

  constructor(readonly ownerPid: number | null) {
    super(`project busy (pid ${ownerPid ?? "unknown"})`);
  }
}

const POLL_MS = 50;

// Serializes work on one project across server processes. The lock is a
// directory that appears atomically, already holding owner.json, because
// rename onto a non-empty directory fails. Pass the real project root.
export async function withProjectLock<T>(
  root: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const base = join(root, ".godot", "godot_mcp");
  const lock = join(base, "lock");
  await mkdir(base, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryAcquire(base, lock)) break;
    const owner = await readOwner(lock);
    if (owner !== null && !isAlive(owner)) {
      await reclaim(base, lock);
      continue;
    }
    if (Date.now() >= deadline) throw new ProjectBusyError(owner);
    await Bun.sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function tryAcquire(base: string, lock: string): Promise<boolean> {
  const staging = join(base, `lock.${process.pid}.${crypto.randomUUID()}`);
  await mkdir(staging);
  await writeFile(
    join(staging, "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  try {
    await rename(staging, lock);
    return true;
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw err;
  }
}

async function readOwner(lock: string): Promise<number | null> {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    return typeof owner.pid === "number" ? owner.pid : null;
  } catch (err) {
    // The holder may have released between our failed acquire and this read.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Moving the dead holder's lock aside first means only one reclaimer wins.
// shortcut: a reclaimer that read a stale owner can still move a lock that a
// third process took in between; upgrade if that ever shows up.
async function reclaim(base: string, lock: string): Promise<void> {
  const aside = join(base, `lock.stale.${crypto.randomUUID()}`);
  try {
    await rename(lock, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await rm(aside, { recursive: true, force: true });
}
