import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repo, waitFor } from "../helpers.ts";
import {
  callTool,
  type Editor,
  failure as failureOn,
  freePort,
  godotBin,
  headersPath,
  ok as okOn,
  prepareProject,
  removeProjects,
  startEditor,
} from "./harness.ts";

// The slice 6 self-setup against a real editor. The project sits under a path with a space and a quote,
// so the headersHelper quoting is tested on every call. The menu item is checked in the GUI smoke test.

const SKILL_SOURCE = join(repo, "addons", "godot_mcp", "SKILL.md");
const SKILL_REL = ".claude/skills/godot-mcp/SKILL.md";

let editor: Editor;
let outside: string;

beforeAll(async () => {
  const port = await freePort();
  const dir = await prepareProject(port, "godot mcp it's ");
  editor = await startEditor({ dir, port });
  await waitFor(async () => {
    const info = await okOn(editor, "get_project_info");
    return info.scanning === false ? true : undefined;
  }, 60_000);
  // Link targets live outside the project, so a write that followed a link would land here.
  outside = await mkdtemp(join(tmpdir(), "setup-outside-"));
}, 180_000);

afterAll(async () => {
  await editor?.stop();
  await removeProjects();
  await rm(outside, { recursive: true, force: true });
});

const ok = (name: string, args: Record<string, unknown> = {}) =>
  okOn(editor, name, args);
const failure = (name: string, args: Record<string, unknown> = {}) =>
  failureOn(editor, name, args);

// Every path under the project with its kind and a content hash. .godot/ is skipped: the running
// editor writes there on its own, and the install never touches it (checked by headers.json below).
async function snapshot(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const rel of await readdir(root, { recursive: true })) {
    if (rel === ".godot" || rel.startsWith(".godot/")) continue;
    const path = join(root, rel);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) entries.set(rel, `link ${await readlink(path)}`);
    else if (stat.isDirectory()) entries.set(rel, "dir");
    else
      entries.set(
        rel,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
  }
  return entries;
}

// The sorted paths whose entry differs between two snapshots.
function changedPaths(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

// Clears .claude/ so a case starts clean. rm removes a symlink itself and never follows it.
const resetClaude = () =>
  rm(join(editor.dir, ".claude"), { recursive: true, force: true });

async function placeLink(rel: string, target: string): Promise<void> {
  await mkdir(join(editor.dir, dirname(rel)), { recursive: true });
  await symlink(target, join(editor.dir, rel));
}

// Runs probes/setup_probe.gd in a project with no editor. Args after -- reach OS.get_cmdline_user_args().
// biome-ignore lint/suspicious/noExplicitAny: probe reports are checked field by field in each test
async function runProbe(dir: string, args: string[] = []): Promise<any> {
  await cp(
    join(import.meta.dir, "probes", "setup_probe.gd"),
    join(dir, "setup_probe.gd"),
  );
  const extra = args.length > 0 ? ["--", ...args] : [];
  const child = Bun.spawn(
    [
      godotBin(),
      "--headless",
      "--path",
      dir,
      "-s",
      "res://setup_probe.gd",
      ...extra,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = out.split("\n").find((text) => text.startsWith("PROBE "));
  if (line === undefined)
    throw new Error(`the probe did not report:\n${out}\n${err}`);
  return JSON.parse(line.slice("PROBE ".length));
}

describe("setup logic outside the editor", () => {
  test("NOT_LISTENING writes nothing, and Windows is refused with no entry", async () => {
    const report = await runProbe(
      await prepareProject(null, "godot mcp probe "),
    );
    expect(report.notListening.error.code).toBe("NOT_LISTENING");
    expect(report.claudeAfterNotListening).toBe(false);
    expect(report.windows.error.code).toBe("UNSUPPORTED_PLATFORM");
    expect(report.windows.mcpJson).toBeUndefined();
    expect(report.linux).toEqual({});
  });

  // Claude Code expands ${...} in headersHelper, and a control character cannot be carried in it.
  test.each([["godot mcp $" + "{X} "], ["godot\tmcp "]])(
    "refuses the project path %s with no entry and no .claude",
    async (prefix) => {
      const dir = await prepareProject(null, prefix);
      const report = await runProbe(dir);
      expect(report.install.error.code).toBe("UNSAFE_PATH");
      expect(report.install.mcpJson).toBeUndefined();
      expect(existsSync(join(dir, ".claude"))).toBe(false);
    },
  );

  // $( and backticks are not expanded by Claude Code, and single quotes keep them literal in sh.
  test.each([["godot mcp $(echo x) "], ["godot mcp `echo x` "]])(
    "the headersHelper for %s reads the file at that literal path",
    async (prefix) => {
      const dir = await prepareProject(null, prefix);
      const report = await runProbe(dir);
      expect(report.install.changed).toBe(true);
      const helper =
        report.install.mcpJson.mcpServers["godot-editor"].headersHelper;
      const headers = '{"Authorization":"Bearer test"}';
      await mkdir(join(dir, ".godot", "godot_mcp"), { recursive: true });
      await writeFile(
        join(dir, ".godot", "godot_mcp", "headers.json"),
        headers,
      );
      const proc = Bun.spawn(["sh", "-c", helper], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const printed = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(printed).toBe(headers);
    },
  );

  test("the menu dialog shows the entry when the skill is foreign, and does not tell a menu user to pass overwrite", async () => {
    const report = await runProbe(
      await prepareProject(null, "godot mcp dialog "),
      ["dialog"],
    );
    const labels: string[] = report.dialogLabels;
    expect(labels.some((text) => text.includes("godot_mcp marker"))).toBe(true);
    expect(labels.some((text) => text.includes("pass overwrite"))).toBe(false);
    const entry = JSON.parse(report.dialogEntry);
    expect(entry.mcpServers["godot-editor"].type).toBe("http");
  });
});

describe("install_agent_skill", () => {
  test("writes the addon's SKILL.md and reports changed only on the first call", async () => {
    const before = await snapshot(editor.dir);
    const headers = await readFile(headersPath(editor.dir));

    const first = await ok("install_agent_skill");
    expect(first.changed).toBe(true);
    expect(first.skillPath).toBe(join(editor.dir, SKILL_REL));
    const written = await readFile(join(editor.dir, SKILL_REL));
    expect(written.equals(await readFile(SKILL_SOURCE))).toBe(true);

    // Only the four new entries: the three directories and the file. No .tmp, no .mcp.json.
    const after = await snapshot(editor.dir);
    expect(changedPaths(before, after)).toEqual([
      ".claude",
      ".claude/skills",
      ".claude/skills/godot-mcp",
      SKILL_REL,
    ]);
    expect(existsSync(join(editor.dir, ".mcp.json"))).toBe(false);
    expect(await readFile(headersPath(editor.dir))).toEqual(headers);

    const second = await ok("install_agent_skill");
    expect(second.changed).toBe(false);
    expect(changedPaths(after, await snapshot(editor.dir))).toEqual([]);
  });

  test("mcpJson is the ready entry, and its headersHelper prints the token through sh", async () => {
    const result = await ok("install_agent_skill");
    // Each ' in the project path becomes '\'' inside the single-quoted helper argument.
    const quoted = editor.dir.replaceAll("'", "'\\''");
    expect(result.mcpJson).toEqual({
      mcpServers: {
        "godot-editor": {
          type: "http",
          url: `http://127.0.0.1:${editor.port}/mcp`,
          headersHelper: `cat '${quoted}/.godot/godot_mcp/headers.json'`,
          timeout: 600000,
        },
      },
    });

    const helper = result.mcpJson.mcpServers["godot-editor"].headersHelper;
    const proc = Bun.spawn(["sh", "-c", helper], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const printed = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(printed)).toEqual({ Authorization: editor.auth });
  });

  test.each([
    [".claude", "dir"],
    [".claude/skills", "dir"],
    [".claude/skills/godot-mcp", "dir"],
    [SKILL_REL, "file"],
    [`${SKILL_REL}.tmp`, "file"],
  ])("refuses a symlink at %s, even with overwrite", async (rel, kind) => {
    await resetClaude();
    const target = join(outside, rel.replaceAll("/", "_"));
    if (kind === "dir") await mkdir(target);
    else await writeFile(target, "keep");
    await placeLink(rel, target);

    expect(await failure("install_agent_skill", { overwrite: true })).toBe(
      "IS_LINK",
    );
    if (kind === "dir") expect(await readdir(target)).toEqual([]);
    else expect(await readFile(target, "utf8")).toBe("keep");
    // lstat, not existsSync: the link must survive, and existsSync would follow it to the target.
    expect((await lstat(join(editor.dir, rel))).isSymbolicLink()).toBe(true);
  });

  test("refuses a dangling symlink at SKILL.md and creates nothing behind it", async () => {
    await resetClaude();
    const target = join(outside, "missing-dir", "SKILL.md");
    await placeLink(SKILL_REL, target);

    expect(await failure("install_agent_skill", { overwrite: true })).toBe(
      "IS_LINK",
    );
    expect(existsSync(join(outside, "missing-dir"))).toBe(false);
  });

  test("refuses a SKILL.md without the frontmatter marker unless overwrite is set", async () => {
    await resetClaude();
    const skill = join(editor.dir, SKILL_REL);
    await mkdir(dirname(skill), { recursive: true });
    // The marker in the body does not count; only the frontmatter does.
    const foreign = '# my own skill\n\ngodot_mcp: "true"\n';
    await writeFile(skill, foreign);

    expect(await failure("install_agent_skill")).toBe("FOREIGN_SKILL");
    expect(await readFile(skill, "utf8")).toBe(foreign);

    const replaced = await ok("install_agent_skill", { overwrite: true });
    expect(replaced.changed).toBe(true);
    expect((await readFile(skill)).equals(await readFile(SKILL_SOURCE))).toBe(
      true,
    );
    expect(existsSync(`${skill}.tmp`)).toBe(false);
  });

  test("a godot_mcp line after the frontmatter closes does not count", async () => {
    await resetClaude();
    const skill = join(editor.dir, SKILL_REL);
    await mkdir(dirname(skill), { recursive: true });
    const foreign =
      '---\nname: godot-mcp\ndescription: a guide\n---\n\nmetadata:\n  godot_mcp: "true"\n';
    await writeFile(skill, foreign);

    expect(await failure("install_agent_skill")).toBe("FOREIGN_SKILL");
    expect(await readFile(skill, "utf8")).toBe(foreign);
  });

  test("a top-level godot_mcp key does not count; the marker sits under metadata", async () => {
    await resetClaude();
    const skill = join(editor.dir, SKILL_REL);
    await mkdir(dirname(skill), { recursive: true });
    const foreign =
      '---\nname: godot-mcp\ndescription: a guide\ngodot_mcp: "true"\n---\n\nbody\n';
    await writeFile(skill, foreign);

    expect(await failure("install_agent_skill")).toBe("FOREIGN_SKILL");
    expect(await readFile(skill, "utf8")).toBe(foreign);
  });

  test("a refused install still returns mcpJson, so the user can connect", async () => {
    await resetClaude();
    const target = join(outside, "refused-claude");
    await mkdir(target);
    await placeLink(".claude", target);

    const result = await callTool(editor, "install_agent_skill");
    expect(result.structuredContent.error.code).toBe("IS_LINK");
    expect(
      result.structuredContent.mcpJson.mcpServers["godot-editor"].url,
    ).toBe(`http://127.0.0.1:${editor.port}/mcp`);
    expect(await readdir(target)).toEqual([]);
  });

  test("replaces an older copy that carries the marker, without overwrite", async () => {
    await resetClaude();
    const skill = join(editor.dir, SKILL_REL);
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(
      skill,
      '---\nname: godot-mcp\nmetadata:\n  godot_mcp: "true"\n---\n\nan older guide\n',
    );

    const upgraded = await ok("install_agent_skill");
    expect(upgraded.changed).toBe(true);
    expect((await readFile(skill)).equals(await readFile(SKILL_SOURCE))).toBe(
      true,
    );
  });
});
