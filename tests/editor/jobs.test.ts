import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { isAlive, waitFor } from "../helpers.ts";
import {
  callTool,
  type Editor,
  failure as failureOn,
  freePort,
  freshScene as freshSceneOn,
  ok as okOn,
  prepareProject,
  removeProjects,
  startEditor,
} from "./harness.ts";

// The slice 5 job tools against a real editor: import_assets, run_headless and the output parser
// through them. Each child is a second `godot --headless` process the addon spawns.

let editor: Editor;

beforeAll(async () => {
  const port = await freePort();
  const dir = await prepareProject(port);
  editor = await startEditor({ dir, port });
  await idle(editor);
}, 180_000);

afterAll(async () => {
  await editor?.stop();
  await removeProjects();
});

const ok = (name: string, args: Record<string, unknown> = {}) =>
  okOn(editor, name, args);
const failure = (name: string, args: Record<string, unknown> = {}) =>
  failureOn(editor, name, args);
const run = (args: Record<string, unknown>) => ok("run_headless", args);

// The icon import at startup must finish before a job starts, or run_headless waits for it.
async function idle(target: Editor): Promise<void> {
  await waitFor(async () => {
    const info = await callTool(target, "get_project_info");
    return info.structuredContent.scanning === false ? true : undefined;
  }, 60_000);
}

// Pids of the headless children the addon spawned for `script` in this editor's project.
async function children(dir: string, script: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
      () => "",
    );
    const args = cmdline.split("\0");
    // The game runs under `timeout`, whose own command line repeats the game's.
    if (
      !args[0]?.endsWith("timeout") &&
      args.includes(`res://${script}`) &&
      args.includes(dir)
    )
      found.push(Number(entry));
  }
  return found;
}

// Pids of the background `sleep 31337` that hang_group.gd starts.
async function sleeping(): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
      () => "",
    );
    if (cmdline === "sleep\x0031337\x00") found.push(Number(entry));
  }
  return found;
}

const noChildren = async (script: string, timeoutMs = 5000) =>
  await waitFor(async () => {
    const found = await children(editor.dir, script);
    return found.length === 0 ? true : undefined;
  }, timeoutMs);

describe("run_headless", () => {
  test("diag.gd yields exactly the expected diagnostics", async () => {
    const result = await run({ script: "res://diag.gd" });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 0,
      timedOut: false,
      errorCount: 2,
      warningCount: 1,
      stdoutTail: expect.stringContaining("diag-start"),
      unsavedScenes: [],
    });
    expect(result.diagnostics).toEqual([
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
  }, 60_000);

  test("quit_code.gd gives exitCode 3 and ok: false", async () => {
    expect(await run({ script: "res://quit_code.gd" })).toMatchObject({
      ok: false,
      exitCode: 3,
      errorCount: 0,
    });
  }, 60_000);

  test("frames: 30 on the main scene is ok", async () => {
    const result = await run({ frames: 30 });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      errorCount: 0,
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThan(0);
  }, 60_000);

  test("a scene path runs that scene", async () => {
    expect(await run({ scene: "res://sub.tscn", frames: 5 })).toMatchObject({
      ok: true,
      exitCode: 0,
    });
  }, 60_000);

  test("hang.gd with timeoutSec: 2 times out and the child is dead", async () => {
    const result = await run({ script: "res://hang.gd", timeoutSec: 2 });
    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      exitCode: null,
      stdoutTail: expect.stringContaining("hang-start"),
    });
    await noChildren("hang.gd");
    expect((await ok("get_project_info")).jobActive).toBe(false);
  }, 60_000);

  test("a normal exit also kills what the child left in its group", async () => {
    const result = await run({ script: "res://hang_group.gd", frames: 5 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    await waitFor(async () =>
      (await sleeping()).length === 0 ? true : undefined,
    );
  }, 60_000);

  test("a game killed by a signal fails the run (Godot reports the signal number as the exit code)", async () => {
    expect(await run({ script: "res://crash.gd" })).toMatchObject({
      ok: false,
      exitCode: 9,
      timedOut: false,
    });
  }, 60_000);

  test("adversarial output that would overflow the 4 MB reply still returns a result", async () => {
    const res = await callTool(editor, "run_headless", {
      script: "res://adversarial.gd",
    });
    expect(res.isError).toBe(false);
    const result = res.structuredContent;
    expect(result).toMatchObject({
      ok: false,
      errorCount: 200,
      truncated: true,
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.length).toBeLessThan(200);
  }, 60_000);

  test("a long file name stored twice per diagnostic is charged to the text budget", async () => {
    const res = await callTool(editor, "run_headless", {
      script: "res://adversarial_file.gd",
    });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({
      ok: false,
      errorCount: 200,
      truncated: true,
    });
    expect(res.structuredContent.diagnostics.length).toBeLessThan(200);
  }, 60_000);

  test("a run past the 30 s default budget times out normally", async () => {
    const result = await callTool(editor, "run_headless", {
      script: "res://hang.gd",
      timeoutSec: 32,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      timedOut: true,
      ok: false,
    });
  }, 60_000);

  test("a timeout kills the child's whole group, grandchildren included", async () => {
    const first = run({ script: "res://hang_group.gd", timeoutSec: 3 });
    const [grandchild] = await waitFor(async () => {
      const found = await sleeping();
      return found.length > 0 ? found : undefined;
    }, 20_000);
    expect(isAlive(grandchild as number)).toBe(true);
    expect(await first).toMatchObject({ timedOut: true, exitCode: null });
    await waitFor(async () =>
      (await sleeping()).length === 0 ? true : undefined,
    );
    await noChildren("hang_group.gd");
  }, 60_000);

  test("an early ERROR followed by 300 KB of stdout still fails the run", async () => {
    const result = await run({ script: "res://flood.gd" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics[0].message).toBe("early failure");
    expect(result.truncated).toBe(true);
    expect(result.stdoutTail.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdoutTail).toContain("xxxxxxxx");
  }, 60_000);

  test("a line and a multibyte character split across chunks parse whole", async () => {
    const result = await run({ script: "res://split_line.gd" });
    expect(result.diagnostics).toEqual([
      { severity: "error", kind: "ERROR", message: "x" },
      { severity: "error", kind: "ERROR", message: "café" },
    ]);
    expect(result).toMatchObject({ errorCount: 2, ok: false, exitCode: 0 });
  }, 60_000);

  test("userArgs arrive after -- and cannot become engine flags", async () => {
    const userArgs = ["--quit", "-s", "res://hang.gd", "$(echo hi)", "a b", ""];
    const result = await run({ script: "res://args.gd", userArgs });
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(result.stdoutTail).toContain(`ARGS:${JSON.stringify(userArgs)}`);
  }, 60_000);

  test("rejects bad input before spawning anything", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { scene: "res://main.tscn", script: "res://diag.gd" },
        "INVALID_ARGUMENT",
      ],
      [{ scene: "res://../escape.tscn" }, "INVALID_PATH"],
      [{ scene: "res://.godot/x.tscn" }, "INVALID_PATH"],
      [{ scene: "res://diag.gd" }, "INVALID_PATH"],
      [{ script: "res://main.tscn" }, "INVALID_PATH"],
      [{ script: "diag.gd" }, "INVALID_PATH"],
      [{ scene: "res://missing.tscn" }, "FILE_NOT_FOUND"],
      [{ script: "res://missing.gd" }, "FILE_NOT_FOUND"],
      [{ userArgs: Array.from({ length: 65 }, () => "a") }, "INVALID_ARGUMENT"],
      [{ userArgs: ["a".repeat(1025)] }, "INVALID_ARGUMENT"],
    ];
    for (const [args, code] of cases)
      expect([args, await failure("run_headless", args)]).toEqual([args, code]);
    const info = await ok("get_project_info");
    expect(info.jobActive).toBe(false);
  }, 60_000);

  test("schema bounds: frames >= 1, timeoutSec 1..540", async () => {
    for (const args of [
      { frames: 0 },
      { timeoutSec: 0 },
      { timeoutSec: 541 },
    ]) {
      const res = await fetch(`http://127.0.0.1:${editor.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: editor.auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "run_headless", arguments: args },
        }),
      });
      expect((await res.json()).error.code).toBe(-32602);
    }
  });

  test("reports the scenes the editor holds unsaved", async () => {
    const scene = await freshSceneOn(editor);
    await ok("add_node", { parentPath: ".", type: "Node2D", name: "Dirty" });
    const result = await run({ script: "res://quit_code.gd" });
    expect(result.unsavedScenes).toEqual([scene]);
    await ok("save_scene");
    expect((await run({ script: "res://quit_code.gd" })).unsavedScenes).toEqual(
      [],
    );
  }, 60_000);
});

describe("job concurrency", () => {
  test("a second job gets PROJECT_BUSY and other tools answer during a 5 s run", async () => {
    const started = Date.now();
    const first = run({ script: "res://hang.gd", timeoutSec: 5 });
    await waitFor(async () => {
      const info = await ok("get_project_info");
      return info.jobActive === true ? true : undefined;
    });
    expect(await failure("run_headless", { frames: 1 })).toBe("PROJECT_BUSY");
    expect(await failure("import_assets")).toBe("PROJECT_BUSY");
    // The FIFO is free: an editor-state tool answers well inside the run.
    const tool = Date.now();
    expect((await ok("get_project_info")).jobActive).toBe(true);
    expect((await ok("get_editor_log", { limit: 1 })).entries).toBeArray();
    expect(Date.now() - tool).toBeLessThan(2000);
    expect(await first).toMatchObject({ timedOut: true, ok: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    expect((await ok("get_project_info")).jobActive).toBe(false);
    await noChildren("hang.gd");
    // The slot is free again.
    expect(await run({ script: "res://quit_code.gd" })).toMatchObject({
      exitCode: 3,
    });
  }, 60_000);

  test("an SDK AbortSignal kills the child", async () => {
    const client = new Client({ name: "jobs-abort", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${editor.port}/mcp`),
        { requestInit: { headers: { Authorization: editor.auth } } },
      ),
    );
    try {
      // The harness's own calls all use JSON-RPC id 1, and a cancel ignores an id that finished within
      // a minute (it could be another client's). Spend the SDK's low ids first.
      for (let i = 0; i < 5; i++) await client.ping();
      const controller = new AbortController();
      const call = client
        .callTool(
          {
            name: "run_headless",
            arguments: { script: "res://hang.gd", timeoutSec: 120 },
          },
          { signal: controller.signal, timeout: 120_000 },
        )
        .catch((error: unknown) => error);
      const [pid] = await waitFor(async () => {
        const found = await children(editor.dir, "hang.gd");
        return found.length > 0 ? found : undefined;
      }, 20_000);
      expect(isAlive(pid as number)).toBe(true);
      controller.abort();
      expect(await call).toBeInstanceOf(Error);
      await waitFor(() => (isAlive(pid as number) ? undefined : true), 10_000);
      await waitFor(async () => {
        const info = await ok("get_project_info");
        return info.jobActive === false ? true : undefined;
      });
    } finally {
      await client.close();
    }
  }, 60_000);
});

// A tools/call under a chosen JSON-RPC id, as a separate client with its own id counter would send.
async function callAs(
  id: number,
  name: string,
  args: Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: the reply is checked field by field in each test
): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${editor.port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: editor.auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await res.json()).result.structuredContent;
}

async function cancel(requestId: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${editor.port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: editor.auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    }),
  });
  expect(res.status).toBe(202);
}

const jobActive = async () => (await ok("get_project_info")).jobActive;

describe("cancellation", () => {
  test("a stale cancel does not kill another client's new job under the same id", async () => {
    expect(
      await callAs(701, "run_headless", { script: "res://quit_code.gd" }),
    ).toMatchObject({ exitCode: 3 });
    const job = callAs(701, "run_headless", {
      script: "res://hang.gd",
      timeoutSec: 4,
    });
    await waitFor(async () => ((await jobActive()) ? true : undefined));
    await cancel(701);
    await Bun.sleep(1500);
    expect(await jobActive()).toBe(true);
    expect((await children(editor.dir, "hang.gd")).length).toBe(1);
    expect(await job).toMatchObject({ timedOut: true });
  }, 60_000);

  test("an id shared by two requests in flight cancels neither", async () => {
    const job = callAs(702, "run_headless", {
      script: "res://hang.gd",
      timeoutSec: 20,
    });
    await waitFor(async () => ((await jobActive()) ? true : undefined));
    // The second request is slow too: the editor cannot open this scene, and says so after 10 s.
    const other = callAs(702, "open_scene", { path: "res://broken_ref.tscn" });
    await Bun.sleep(300);
    await cancel(702);
    await Bun.sleep(1500);
    // Not jobActive(): that tool call would queue behind the slow open_scene.
    expect((await children(editor.dir, "hang.gd")).length).toBe(1);
    expect(await job).toMatchObject({ timedOut: true });
    expect((await other).error.code).toBe("SCENE_SWITCH_TIMEOUT");
  }, 60_000);

  test("a cancel stops an import_assets that is waiting in the FIFO", async () => {
    // 200 small SVGs import in about 40 ms, so many more keep the import running when the cancel lands.
    const svg = await readFile(join(editor.dir, "icon.svg"));
    for (let i = 0; i < 1500; i++)
      await writeFile(join(editor.dir, `bulk${i}.svg`), svg);
    const importing = callAs(703, "import_assets", {});
    // Not jobActive(): that tool call would queue behind the import.
    await Bun.sleep(100);
    await cancel(703);
    expect((await importing).error.code).toBe("CANCELLED");
    expect(await jobActive()).toBe(false);
    // The scan carries on in the editor.
    await idle(editor);
  }, 120_000);
});

describe("import_assets", () => {
  // A 1x1 PNG.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );

  const imported = async (stem: string) =>
    (await readdir(join(editor.dir, ".godot", "imported"))).filter(
      (name) => name.startsWith(`${stem}.png-`) && name.endsWith(".ctex"),
    );

  test("a PNG copied in gets its .ctex (A14)", async () => {
    await writeFile(join(editor.dir, "fresh.png"), PNG);
    expect(await imported("fresh")).toEqual([]);
    const result = await ok("import_assets");
    expect(result).toMatchObject({
      ok: true,
      timedOut: false,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
    });
    expect((await imported("fresh")).length).toBe(1);
    expect((await ok("get_project_info")).jobActive).toBe(false);
  }, 60_000);

  test("an unreadable image reports its errors", async () => {
    await writeFile(join(editor.dir, "broken.png"), "not an image");
    const result = await ok("import_assets");
    expect(result.ok).toBe(false);
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        kind: "ERROR",
        message: expect.stringContaining("broken.png"),
      }),
    );
    expect(result.warningCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", kind: "WARNING" }),
    );
  }, 60_000);

  test("errors the 1,000-entry log ring has evicted are still counted", async () => {
    for (let i = 0; i < 400; i++)
      await writeFile(join(editor.dir, `junk${i}.png`), "not an image");
    const result = await ok("import_assets");
    // Each bad file logs several lines, so the ring cannot hold them all; the counts come from totals.
    expect(result.errorCount).toBeGreaterThanOrEqual(400);
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.length).toBeLessThanOrEqual(200);
  }, 120_000);

  test("a second import with nothing changed returns promptly", async () => {
    const result = await ok("import_assets");
    expect(result).toMatchObject({ timedOut: false });
    expect(result.durationMs).toBeLessThan(10_000);
  }, 60_000);

  test("a run after an import sees the new asset (A15: the child leaves .godot alone)", async () => {
    await writeFile(join(editor.dir, "again.png"), PNG);
    await ok("import_assets");
    const before = await snapshot(join(editor.dir, ".godot"));
    expect(await run({ frames: 30 })).toMatchObject({ ok: true });
    expect(await snapshot(join(editor.dir, ".godot"))).toEqual(before);
  }, 60_000);
});

// Path -> content hash of every file under dir, except the addon's own state.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.includes("godot_mcp")) continue;
    out[path] = createHash("sha1")
      .update(await readFile(path))
      .digest("hex");
  }
  return out;
}

test("the editor printed no SCRIPT ERROR", () => {
  expect(editor.output()).not.toContain("SCRIPT ERROR");
});

describe("editor shutdown", () => {
  // The editor dies without running _exit_tree on SIGTERM and SIGINT (a job child then outlives it),
  // so this quits it from inside: a @tool script's static initializer runs when edit_script loads it
  // (plan D33), and the plugin unloads as the editor exits.
  // timeout, which wraps every job, ends the child at timeoutSec + 60 s (+ 5 s to SIGKILL) even when
  // nothing else can: here the editor is killed without any cleanup.
  test("a job child outlives a SIGTERMed editor only until its own timeout", async () => {
    const port = await freePort();
    const dir = await prepareProject(port);
    const second = await startEditor({ dir, port });
    try {
      await idle(second);
      const call = callTool(second, "run_headless", {
        script: "res://hang.gd",
        timeoutSec: 5,
      }).catch((error: unknown) => error);
      const [pid] = await waitFor(async () => {
        const found = await children(dir, "hang.gd");
        return found.length > 0 ? found : undefined;
      }, 20_000);
      const killedAt = Date.now();
      process.kill(second.pid, "SIGTERM");
      await waitFor(() => (isAlive(second.pid) ? undefined : true), 20_000);
      expect(isAlive(pid as number)).toBe(true);
      await waitFor(() => (isAlive(pid as number) ? undefined : true), 75_000);
      expect(Date.now() - killedAt).toBeLessThan(72_000);
      await call;
    } finally {
      await second.stop();
    }
  }, 150_000);

  test("quitting the editor kills a running job", async () => {
    const port = await freePort();
    const dir = await prepareProject(port);
    const second = await startEditor({ dir, port });
    try {
      await idle(second);
      const call = callTool(second, "run_headless", {
        script: "res://hang.gd",
        timeoutSec: 120,
      }).catch((error: unknown) => error);
      const [pid] = await waitFor(async () => {
        const found = await children(dir, "hang.gd");
        return found.length > 0 ? found : undefined;
      }, 20_000);
      await okOn(second, "create_script", {
        path: "res://bye.gd",
        extends: "Node",
      });
      const quit = callTool(second, "edit_script", {
        path: "res://bye.gd",
        content:
          "@tool\nextends Node\n\nstatic func _static_init() -> void:\n\t(Engine.get_main_loop() as SceneTree).quit()\n",
      }).catch((error: unknown) => error);
      await waitFor(() => (isAlive(second.pid) ? undefined : true), 30_000);
      await waitFor(() => (isAlive(pid as number) ? undefined : true), 10_000);
      await Promise.all([call, quit]);
    } finally {
      await second.stop();
    }
  }, 120_000);
});
