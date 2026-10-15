import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import {
  connect,
  copyFixture,
  fakeGodot,
  isAlive,
  readPid,
  waitFor,
} from "../helpers.ts";

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "godot-mcp-run-"));
}

function fakeEnv(mode: string, extra: Record<string, string> = {}) {
  return { GODOT_BIN: fakeGodot, FAKE_GODOT_MODE: mode, ...extra };
}

describe("godot_run with the real engine", () => {
  test("diag.gd yields exactly the expected diagnostics (pins A4)", async () => {
    const project = await copyFixture();
    const client = await connect();
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        script: "diag.gd",
        import: false,
      });
      expect(result.isError).toBeFalsy();
      const run = result.structuredContent as Record<string, unknown>;
      expect(run).toMatchObject({
        ok: false,
        exitCode: 0,
        timedOut: false,
        errorCount: 2,
        warningCount: 1,
        stdoutTail: expect.stringContaining("diag-start"),
      });
      expect(run.diagnostics).toEqual([
        {
          severity: "error",
          kind: "ERROR",
          message: "pushed error",
          file: "res://diag.gd",
          line: 8,
          stack: ["_init (res://diag.gd:8)"],
        },
        {
          severity: "warning",
          kind: "WARNING",
          message: "pushed warning",
          file: "res://diag.gd",
          line: 9,
          stack: ["_init (res://diag.gd:9)"],
        },
        {
          severity: "error",
          kind: "SCRIPT ERROR",
          message: "Out of bounds get index '5' (on base: 'Array')",
          file: "res://diag.gd",
          line: 11,
          stack: ["_init (res://diag.gd:11)"],
        },
      ]);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("quit_code.gd gives exitCode 3 and ok: false", async () => {
    const project = await copyFixture();
    const client = await connect();
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        script: "res://quit_code.gd",
        import: false,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        exitCode: 3,
        errorCount: 0,
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  test("frames: 30 on the main scene is ok, after an import phase", async () => {
    const project = await copyFixture();
    const client = await connect();
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        frames: 30,
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        exitCode: 0,
        errorCount: 0,
        phases: { import: { ok: true } },
      });
    } finally {
      await client.close();
    }
  }, 60_000);

  test("frames: 60 wall time (slice measurement)", async () => {
    const project = await copyFixture();
    const client = await connect();
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        frames: 60,
      });
      const run = result.structuredContent as {
        ok: boolean;
        durationMs: number;
      };
      expect(run.ok).toBe(true);
      console.log(`frames:60 run phase wall time: ${run.durationMs} ms`);
    } finally {
      await client.close();
    }
  }, 60_000);

  test("hang.gd with timeoutSec: 2 times out", async () => {
    const project = await copyFixture();
    const client = await connect();
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        script: "hang.gd",
        import: false,
        timeoutSec: 2,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        timedOut: true,
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  test("godot_import runs --import and reports ok", async () => {
    const project = await copyFixture();
    const client = await connect();
    try {
      const result = await call(client, "godot_import", {
        projectPath: project,
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        exitCode: 0,
        errorCount: 0,
      });
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("godot_run with fake-godot.sh", () => {
  test("a TERM-proof grandchild is dead after a timeout", async () => {
    const project = await copyFixture();
    const pidfile = join(await scratch(), "pid");
    const client = await connect(
      fakeEnv("hang", { FAKE_GODOT_PIDFILE: pidfile }),
    );
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        import: false,
        timeoutSec: 2,
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        timedOut: true,
      });
      const grandchild = await waitFor(() => readPid(pidfile));
      await waitFor(() => (isAlive(grandchild) ? undefined : true));
    } finally {
      await client.close();
    }
  }, 30_000);

  test("an early ERROR followed by 300 KB of stdout still fails the run", async () => {
    const project = await copyFixture();
    const client = await connect(fakeEnv("flood"));
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        import: false,
      });
      const run = result.structuredContent as {
        ok: boolean;
        errorCount: number;
        stdoutTail: string;
        truncated: boolean;
        diagnostics: { message: string }[];
      };
      expect(run.ok).toBe(false);
      expect(run.errorCount).toBeGreaterThanOrEqual(1);
      expect(run.diagnostics[0]?.message).toBe("early failure");
      expect(run.truncated).toBe(true);
      expect(run.stdoutTail.length).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("an MCP cancel kills the process group", async () => {
    const project = await copyFixture();
    const pidfile = join(await scratch(), "pid");
    const client = await connect(
      fakeEnv("hang", { FAKE_GODOT_PIDFILE: pidfile }),
    );
    try {
      const controller = new AbortController();
      const cancelled = client
        .callTool(
          {
            name: "godot_run",
            arguments: { projectPath: project, import: false, timeoutSec: 120 },
          },
          { signal: controller.signal },
        )
        .catch((e: unknown) => e);
      const grandchild = await waitFor(() => readPid(pidfile));
      expect(isAlive(grandchild)).toBe(true);
      controller.abort();
      await cancelled;
      await waitFor(() => (isAlive(grandchild) ? undefined : true), 10_000);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("passes arg arrays, runs in the project dir, and puts userArgs after --", async () => {
    const project = await copyFixture();
    const argsFile = join(await scratch(), "args");
    const client = await connect(
      fakeEnv("ok", { FAKE_GODOT_ARGSFILE: argsFile }),
    );
    try {
      const result = await call(client, "godot_run", {
        projectPath: project,
        scene: "main.tscn",
        frames: 30,
        import: false,
        userArgs: ["--flag", "$(echo hi)"],
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect((await readFile(argsFile, "utf8")).trimEnd().split("\n")).toEqual([
        project,
        "--headless",
        "--path",
        project,
        "res://main.tscn",
        "--quit-after",
        "30",
        "--",
        "--flag",
        "$(echo hi)",
      ]);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("rejects bad input as an error result", async () => {
    const project = await copyFixture();
    await writeFile(join(project, "Game.csproj"), "<Project />");
    const client = await connect(fakeEnv("ok"));
    try {
      const cases: [Record<string, unknown>, RegExp][] = [
        [
          { build: false, scene: "main.tscn", script: "diag.gd" },
          /mutually exclusive/,
        ],
        [
          { build: false, scene: "../escape.tscn" },
          /not a path inside the project/,
        ],
        [{ build: false, scene: "missing.tscn" }, /no such file/],
        [{}, /until godot_build lands/],
        [{ build: true }, /until godot_build lands/],
      ];
      for (const [extra, message] of cases) {
        const result = await call(client, "godot_run", {
          projectPath: project,
          import: false,
          ...extra,
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(message);
      }
      const ok = await call(client, "godot_run", {
        projectPath: project,
        import: false,
        build: false,
      });
      expect(ok.structuredContent).toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("two server processes on one project", () => {
  test("the second run waits for the first, then runs", async () => {
    const project = await copyFixture();
    const pidfile = join(await scratch(), "pid");
    const first = await connect(
      fakeEnv("hang", { FAKE_GODOT_PIDFILE: pidfile }),
    );
    const second = await connect(fakeEnv("ok"));
    try {
      const firstRun = call(first, "godot_run", {
        projectPath: project,
        import: false,
        timeoutSec: 2,
      }).then((r) => ({ r, at: Date.now() }));
      await waitFor(() => readPid(pidfile)); // the first run holds the lock
      const secondRun = call(second, "godot_run", {
        projectPath: project,
        import: false,
        timeoutSec: 30,
      }).then((r) => ({ r, at: Date.now() }));
      const [a, b] = await Promise.all([firstRun, secondRun]);
      expect(a.r.structuredContent).toMatchObject({ timedOut: true });
      expect(b.r.structuredContent).toMatchObject({ ok: true });
      expect(b.at).toBeGreaterThanOrEqual(a.at);
    } finally {
      await first.close();
      await second.close();
    }
  }, 30_000);

  test("the second run reports `project busy` when its timeout is shorter", async () => {
    const project = await copyFixture();
    const pidfile = join(await scratch(), "pid");
    const first = await connect(
      fakeEnv("hang", { FAKE_GODOT_PIDFILE: pidfile }),
    );
    const second = await connect(fakeEnv("ok"));
    try {
      const firstRun = call(first, "godot_run", {
        projectPath: project,
        import: false,
        timeoutSec: 3,
      });
      await waitFor(() => readPid(pidfile));
      const busy = await call(second, "godot_run", {
        projectPath: project,
        import: false,
        timeoutSec: 1,
      });
      expect(busy.isError).toBe(true);
      expect(JSON.stringify(busy.content)).toMatch(/project busy \(pid \d+\)/);
      await firstRun;
    } finally {
      await first.close();
      await second.close();
    }
  }, 30_000);
});
