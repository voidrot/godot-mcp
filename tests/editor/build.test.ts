import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDotnet, isAlive, repo, waitFor } from "../helpers.ts";
import {
  callTool,
  type Editor,
  failure as failureOn,
  freePort,
  ok as okOn,
  prepareProject,
  removeProjects,
  rpc,
  startEditor,
} from "./harness.ts";

// The slice 8 build_dotnet tool. Most cases run against a fake `dotnet` on PATH whose behaviour the
// build configuration selects; the e2e block at the end runs the real dotnet on fixtures/cs.

async function toolNames(editor: Editor): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${editor.port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: editor.auth,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: rpc("tools/list"),
  });
  const parsed = await res.json();
  return parsed.result.tools.map((tool: { name: string }) => tool.name);
}

// Pids of the background `sleep 31338` that fake-dotnet's hang mode starts.
async function sleeping(): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
      () => "",
    );
    if (cmdline === "sleep\x0031338\x00") found.push(Number(entry));
  }
  return found;
}

afterAll(removeProjects);

const skill = () =>
  readFile(join(repo, "addons", "godot_mcp", "SKILL.md"), "utf8");

describe("build_dotnet with a fake dotnet", () => {
  let editor: Editor;
  let dir: string;
  let scratch: string;
  let argsFile: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "godot-mcp-fake-dotnet-"));
    await symlink(fakeDotnet, join(scratch, "dotnet"));
    argsFile = join(scratch, "args.txt");
    const port = await freePort();
    dir = await prepareProject(port, undefined, "cs");
    editor = await startEditor({
      dir,
      port,
      env: {
        PATH: `${scratch}:${process.env.PATH}`,
        FAKE_DOTNET_ARGSFILE: argsFile,
        FAKE_DOTNET_ROOT: dir,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await editor?.stop();
    await rm(scratch, { recursive: true, force: true });
  });

  const build = (args: Record<string, unknown> = {}) =>
    okOn(editor, "build_dotnet", args);
  const failure = (args: Record<string, unknown>) =>
    failureOn(editor, "build_dotnet", args);

  test("is listed, and the skill names every listed tool", async () => {
    const names = await toolNames(editor);
    expect(names).toContain("build_dotnet");
    const text = await skill();
    for (const name of names) expect(text).toContain(`\`${name}\``);
    expect((await okOn(editor, "get_project_info")).dotnet).toEqual({
      csproj: "res://FixtureGame.csproj",
    });
  });

  test("runs env -C <project> dotnet build with the D13 flags, and cwd is the project root", async () => {
    const result = await build();
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      timedOut: false,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      outputTail: expect.stringContaining("Build succeeded."),
    });
    // The fake exits 99 with an error when its cwd is not FAKE_DOTNET_ROOT, so ok also proves cwd.
    expect((await readFile(argsFile, "utf8")).split("\n")).toEqual([
      dir,
      "1 1 1",
      "build",
      join(dir, "FixtureGame.csproj"),
      "-c",
      "Debug",
      "-nologo",
      "-v:q",
      "-tl:off",
      "-clp:NoSummary",
      "-nodeReuse:false",
      "-p:UseSharedCompilation=false",
      "",
    ]);
  }, 60_000);

  test("passes the configuration", async () => {
    await build({ configuration: "Release.1-x_y" });
    expect(await readFile(argsFile, "utf8")).toContain("\n-c\nRelease.1-x_y\n");
  }, 60_000);

  test("located errors and warnings parse once each, with res:// paths", async () => {
    const result = await build({ configuration: "errors" });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      errorCount: 2,
      warningCount: 1,
      truncated: false,
    });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message: "; expected",
        code: "CS1002",
        file: "res://Main.cs",
        line: 8,
        column: 25,
      },
      {
        severity: "warning",
        kind: "WARNING",
        message: "The variable 'x' is declared but never used",
        code: "CS0168",
        file: "res://Main.cs",
        line: 12,
        column: 5,
      },
      {
        severity: "error",
        kind: "ERROR",
        message: "The name 'y' does not exist in the current context",
        code: "CS0103",
        file: "/elsewhere/Lib.cs",
        line: 3,
        column: 1,
      },
    ]);
  }, 60_000);

  test("a warning alone leaves the build ok", async () => {
    expect(await build({ configuration: "warnings" })).toMatchObject({
      ok: true,
      errorCount: 0,
      warningCount: 1,
    });
  }, 60_000);

  test("x.csproj : error NU1301 parses, with the csproj as the file", async () => {
    const result = await build({ configuration: "nu1301" });
    expect(result).toMatchObject({ ok: false, errorCount: 1 });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message:
          "Unable to load the service index for source https://api.nuget.org/v3/index.json.",
        code: "NU1301",
        file: "res://FixtureGame.csproj",
      },
    ]);
  }, 60_000);

  test("MSBUILD : error MSB1009 parses, with no file", async () => {
    const result = await build({ configuration: "msb1009" });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message: "Project file does not exist.",
        code: "MSB1009",
      },
    ]);
    expect(result.errorCount).toBe(1);
  }, 60_000);

  test("diagnostics without a code parse", async () => {
    const result = await build({ configuration: "nocode" });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message: "custom task failed",
        file: "res://Main.cs",
        line: 3,
        column: 4,
      },
      { severity: "warning", kind: "WARNING", message: "something looks off" },
    ]);
    expect(result).toMatchObject({ errorCount: 1, warningCount: 1 });
  }, 60_000);

  test("a nonzero exit with no diagnostic gives BUILD_FAILED and keeps the output", async () => {
    const result = await build({ configuration: "silent" });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 3,
      errorCount: 1,
      outputTail: expect.stringContaining("You must install or update .NET"),
    });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message: expect.stringContaining("exited with code 3"),
        code: "BUILD_FAILED",
      },
    ]);
  }, 60_000);

  test("a timeout kills the group, a background sleep included", async () => {
    const first = build({ configuration: "hang", timeoutSec: 3 });
    const [grandchild] = await waitFor(async () => {
      const found = await sleeping();
      return found.length > 0 ? found : undefined;
    }, 20_000);
    expect(isAlive(grandchild as number)).toBe(true);
    expect(await first).toMatchObject({
      ok: false,
      timedOut: true,
      exitCode: null,
      outputTail: expect.stringContaining("fake-hang"),
    });
    await waitFor(async () =>
      (await sleeping()).length === 0 ? true : undefined,
    );
    expect((await okOn(editor, "get_project_info")).jobActive).toBe(false);
  }, 60_000);

  test("CRLF line endings and TargetFramework project suffixes parse clean", async () => {
    const result = await build({ configuration: "crlf" });
    expect(result).toMatchObject({ errorCount: 1, warningCount: 2 });
    expect(result.diagnostics.slice(2)).toMatchObject([
      {
        severity: "warning",
        message: "line one",
        code: "XY0001",
        file: "res://FixtureGame.csproj",
      },
    ]);
    expect(result.diagnostics.slice(0, 2)).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message: "; expected",
        code: "CS1002",
        file: "res://Main.cs",
        line: 8,
        column: 25,
      },
      {
        severity: "warning",
        kind: "WARNING",
        message: "unused",
        code: "CS0168",
        file: "res://Main.cs",
        line: 12,
        column: 5,
      },
    ]);
  }, 60_000);

  test("hostile output is parsed in linear time and never stalls the editor", async () => {
    // 600 lines of ~1,000 characters that cost a naive regex ~57 ms each: ~20 s in all, and about a
    // second per frame in which the editor answers nothing.
    let finished = false;
    const running = build({ configuration: "hostile", timeoutSec: 60 }).finally(
      () => {
        finished = true;
      },
    );
    let worst = 0;
    while (!finished) {
      const asked = Date.now();
      await okOn(editor, "get_project_info");
      worst = Math.max(worst, Date.now() - asked);
      await Bun.sleep(20);
    }
    const result = await running;
    expect(result).toMatchObject({ ok: false, exitCode: 1, errorCount: 1 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "CS1", message: "x" }),
    ]);
    expect(result.durationMs).toBeLessThan(5000);
    expect(worst).toBeLessThan(1000);
  }, 60_000);

  test("truncated is set when the combined output tail is cut", async () => {
    const result = await build({ configuration: "split" });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.outputTail.length).toBeLessThanOrEqual(64 * 1024);
    // stderr comes last in the tail.
    expect(result.outputTail.trimEnd().endsWith("eeee")).toBe(true);
  }, 60_000);

  test("cancelling a running build kills its process group", async () => {
    const send = (body: unknown) =>
      fetch(`http://127.0.0.1:${editor.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: editor.auth,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(body as object) }),
      });
    const call = send({
      id: 901,
      method: "tools/call",
      params: {
        name: "build_dotnet",
        arguments: { configuration: "hang", timeoutSec: 120 },
      },
    }).then(async (res) => (await res.json()).result.structuredContent);
    const [grandchild] = await waitFor(async () => {
      const found = await sleeping();
      return found.length > 0 ? found : undefined;
    }, 20_000);
    expect(isAlive(grandchild as number)).toBe(true);
    const cancelled = await send({
      method: "notifications/cancelled",
      params: { requestId: 901 },
    });
    expect(cancelled.status).toBe(202);
    expect((await call).error.code).toBe("CANCELLED");
    await waitFor(async () =>
      (await sleeping()).length === 0 ? true : undefined,
    );
    expect((await okOn(editor, "get_project_info")).jobActive).toBe(false);
  }, 60_000);

  test("a second job gets PROJECT_BUSY while other tools answer", async () => {
    const first = build({ configuration: "hang", timeoutSec: 3 });
    await waitFor(async () => {
      const info = await okOn(editor, "get_project_info");
      return info.jobActive === true ? true : undefined;
    });
    expect(await failure({})).toBe("PROJECT_BUSY");
    expect(await failureOn(editor, "run_headless", { frames: 1 })).toBe(
      "PROJECT_BUSY",
    );
    expect(await failureOn(editor, "import_assets")).toBe("PROJECT_BUSY");
    // play_scene would start the editor's own build beside this one.
    expect(await failureOn(editor, "play_scene", { mode: "main" })).toBe(
      "PROJECT_BUSY",
    );
    expect(await first).toMatchObject({ timedOut: true });
    expect((await okOn(editor, "get_project_info")).jobActive).toBe(false);
  }, 60_000);

  test("a configuration that could pass a switch is refused before anything runs", async () => {
    await rm(argsFile, { force: true });
    for (const configuration of [
      "",
      "-p:Foo=1",
      "--help",
      "Debug;Release",
      "Debug Release",
      "Debug\n",
      "$(id)",
      "../x",
      "x".repeat(65),
    ])
      expect([configuration, await failure({ configuration })]).toEqual([
        configuration,
        "INVALID_ARGUMENT",
      ]);
    expect(await Bun.file(argsFile).exists()).toBe(false);
  }, 60_000);

  test("a csproj added or removed after startup is an error", async () => {
    const extra = join(dir, "Extra.csproj");
    await writeFile(extra, "<Project />\n");
    expect(await failure({})).toBe("AMBIGUOUS_MATCH");
    await rm(extra);
    const original = join(dir, "FixtureGame.csproj");
    const text = await readFile(original, "utf8");
    await rm(original);
    expect(await failure({})).toBe("FILE_NOT_FOUND");
    await writeFile(original, text);
    expect(await build()).toMatchObject({ ok: true });
  }, 60_000);
});

describe("build_dotnet registration", () => {
  test("two root csprojs leave the tool unregistered", async () => {
    const port = await freePort();
    const dir = await prepareProject(port);
    await writeFile(join(dir, "A.csproj"), "<Project />\n");
    await writeFile(join(dir, "B.csproj"), "<Project />\n");
    const editor = await startEditor({ dir, port });
    try {
      const names = await toolNames(editor);
      expect(names).toContain("run_headless");
      expect(names).not.toContain("build_dotnet");
      expect((await okOn(editor, "get_project_info")).dotnet).toEqual({
        csproj: null,
        count: 2,
      });
      // An unknown tool is a JSON-RPC -32602.
      await expect(callTool(editor, "build_dotnet")).rejects.toThrow("-32602");
    } finally {
      await editor.stop();
    }
  }, 180_000);
});

describe("build_dotnet without dotnet", () => {
  test("a missing dotnet is exit 127 with a BUILD_FAILED that names it", async () => {
    // A PATH holding only `timeout`: env then can't find dotnet.
    const scratch = await mkdtemp(join(tmpdir(), "godot-mcp-no-dotnet-"));
    const timeout = Bun.which("timeout");
    if (timeout === null) throw new Error("timeout not found");
    await symlink(timeout, join(scratch, "timeout"));
    const port = await freePort();
    const dir = await prepareProject(port, undefined, "cs");
    const editor = await startEditor({ dir, port, env: { PATH: scratch } });
    try {
      const result = await okOn(editor, "build_dotnet");
      expect(result).toMatchObject({
        ok: false,
        exitCode: 127,
        errorCount: 1,
        outputTail: expect.stringContaining("dotnet"),
      });
      expect(result.diagnostics).toEqual([
        {
          severity: "error",
          kind: "ERROR",
          message: expect.stringContaining("dotnet was not found"),
          code: "BUILD_FAILED",
        },
      ]);
    } finally {
      await editor.stop();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});

// The real dotnet on fixtures/cs. A cold NuGet cache needs network access to nuget.org for
// Godot.NET.Sdk, GodotSharp and the net8.0 reference pack; with them in ~/.nuget/packages the build is offline.
describe("build_dotnet end to end", () => {
  let editor: Editor;
  let dir: string;

  beforeAll(async () => {
    const version = Bun.which("dotnet")
      ? await Bun.spawn(["dotnet", "--version"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited
      : 1;
    if (version !== 0)
      throw new Error(
        ".NET runtime missing for SDK; install dotnet-runtime (operator)",
      );
    const port = await freePort();
    dir = await prepareProject(port, undefined, "cs");
    editor = await startEditor({ dir, port });
  }, 180_000);

  afterAll(async () => {
    await editor?.stop();
  });

  const build = (args: Record<string, unknown> = {}) =>
    okOn(editor, "build_dotnet", args);
  const mainCs = () => join(dir, "Main.cs");

  // Runs first: it needs the project unbuilt. An unbuilt script's get_instance_base_type() is empty,
  // so update_property refuses it. The editor loads the built assembly about a second after a build.
  test("a C# script can be attached only once the project is built", async () => {
    await okOn(editor, "create_scene", {
      path: "res://t1.tscn",
      rootType: "Node",
      rootName: "Root",
    });
    const attach = () =>
      callTool(editor, "update_property", {
        path: ".",
        property: "script",
        value: "res://Main.cs",
      });
    expect((await attach()).structuredContent.error.code).toBe("INVALID_VALUE");
    expect(await build()).toMatchObject({ ok: true });
    await waitFor(async () => {
      const result = await attach();
      return result.structuredContent.error === undefined ? true : undefined;
    }, 20_000);
  }, 240_000);

  test("a clean build is ok and writes the assembly", async () => {
    const result = await build();
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      timedOut: false,
      diagnostics: [],
      errorCount: 0,
    });
    expect(
      await Bun.file(
        join(dir, ".godot", "mono", "temp", "bin", "Debug", "FixtureGame.dll"),
      ).exists(),
    ).toBe(true);
  }, 240_000);

  test("run_headless on the C# scene prints the FixtureLib marker with no diagnostics", async () => {
    const result = await okOn(editor, "run_headless", {
      scene: "res://main.tscn",
    });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      errorCount: 0,
      diagnostics: [],
      stdoutTail: expect.stringContaining("fixturelib-marker hello world"),
    });
  }, 60_000);

  test("a missing semicolon is reported as CS1002 with file and line", async () => {
    const original = await readFile(mainCs(), "utf8");
    await writeFile(
      mainCs(),
      original.replace("GetTree().Quit();", "GetTree().Quit()"),
    );
    try {
      const result = await build();
      expect(result).toMatchObject({ ok: false, exitCode: 1, errorCount: 1 });
      expect(result.diagnostics).toEqual([
        {
          severity: "error",
          kind: "ERROR",
          message: "; expected",
          code: "CS1002",
          file: "res://Main.cs",
          line: 8,
          column: 25,
        },
      ]);
    } finally {
      await writeFile(mainCs(), original);
    }
    expect(await build()).toMatchObject({ ok: true });
  }, 240_000);
});
