import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProc, Tail } from "../../src/proc.ts";
import { isAlive, readPid, waitFor } from "../helpers.ts";

// A group leader plus a grandchild that ignores SIGTERM and records its pid.
const stubborn = (pidfile: string) => [
  "sh",
  "-c",
  `sh -c 'trap "" TERM; echo $$ > ${pidfile}; while :; do sleep 1; done' & sleep 300`,
];

async function pidfile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "godot-mcp-proc-")), "pid");
}

describe("runProc", () => {
  test("streams stdout and stderr and reports the exit code", async () => {
    let out = "";
    let err = "";
    const result = await runProc(["sh", "-c", "echo a; echo b >&2; exit 4"], {
      timeoutMs: 5000,
      onStdout: (c) => {
        out += c;
      },
      onStderr: (c) => {
        err += c;
      },
    });
    expect(result).toMatchObject({
      exitCode: 4,
      timedOut: false,
      aborted: false,
    });
    expect(out).toBe("a\n");
    expect(err).toBe("b\n");
  });

  test("passes cwd and does not interpret argv as a shell string", async () => {
    let out = "";
    await runProc(["sh", "-c", 'pwd; echo "$1"', "_", "$(echo hi); x"], {
      cwd: "/tmp",
      timeoutMs: 5000,
      onStdout: (c) => {
        out += c;
      },
    });
    expect(out).toBe("/tmp\n$(echo hi); x\n");
  });

  test("a timeout kills the group, including a SIGTERM-proof grandchild", async () => {
    const file = await pidfile();
    const result = await runProc(stubborn(file), {
      timeoutMs: 500,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    const grandchild = await waitFor(() => readPid(file));
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
  });

  test("an abort kills the group", async () => {
    const file = await pidfile();
    const controller = new AbortController();
    const running = runProc(stubborn(file), {
      timeoutMs: 60_000,
      killGraceMs: 200,
      signal: controller.signal,
    });
    const grandchild = await waitFor(() => readPid(file));
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
  });

  test("a grandchild left behind after a normal exit is killed too", async () => {
    const file = await pidfile();
    const result = await runProc(
      [
        "sh",
        "-c",
        `sh -c 'echo $$ > ${file}; exec sleep 300' >/dev/null 2>&1 & while [ ! -s ${file} ]; do sleep 0.05; done`,
      ],
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(0);
    const grandchild = Number((await readFile(file, "utf8")).trim());
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
  });

  test("an already-aborted signal stops the process at once", async () => {
    const result = await runProc(["sleep", "300"], {
      timeoutMs: 60_000,
      signal: AbortSignal.abort(),
    });
    expect(result.aborted).toBe(true);
  });
});

describe("Tail", () => {
  test("keeps the last characters and flags truncation", () => {
    const tail = new Tail(5);
    tail.push("abc");
    expect(tail.truncated).toBe(false);
    tail.push("defg");
    expect(tail.toString()).toBe("cdefg");
    expect(tail.truncated).toBe(true);
  });
});
