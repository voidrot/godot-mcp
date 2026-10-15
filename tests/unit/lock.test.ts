import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectBusyError, withProjectLock } from "../../src/lock.ts";

async function project(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "godot-mcp-lock-"));
}

describe("withProjectLock", () => {
  test("serializes holders", async () => {
    const root = await project();
    const events: string[] = [];
    const hold = (name: string) =>
      withProjectLock(root, 5000, async () => {
        events.push(`${name}:in`);
        await Bun.sleep(100);
        events.push(`${name}:out`);
      });
    await Promise.all([hold("a"), hold("b")]);
    expect(events.join(" ")).toMatch(
      /^(a:in a:out b:in b:out|b:in b:out a:in a:out)$/,
    );
  });

  test("fails with `project busy (pid N)` when not free in time", async () => {
    const root = await project();
    await withProjectLock(root, 1000, async () => {
      const err = await withProjectLock(root, 150, async () => {}).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ProjectBusyError);
      expect(err.message).toBe(`project busy (pid ${process.pid})`);
    });
  });

  test("releases the lock when the callback throws", async () => {
    const root = await project();
    await expect(
      withProjectLock(root, 1000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await withProjectLock(root, 200, async () => {});
  });

  test("reclaims a lock whose owner is dead", async () => {
    const root = await project();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const lock = join(root, ".godot", "godot_mcp", "lock");
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: dead.pid }),
    );
    let ran = false;
    await withProjectLock(root, 500, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
