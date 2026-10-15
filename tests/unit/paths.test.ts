import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PathError,
  resolveProjectDir,
  resolveResPath,
} from "../../src/paths.ts";

// Layout: <base>/project (valid), <base>/bare (no project.godot), <base>/outside (sibling).
let base: string;
let project: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "godot-mcp-paths-"));
  project = join(base, "project");
  await mkdir(join(project, "scenes"), { recursive: true });
  await mkdir(join(base, "bare"));
  await mkdir(join(base, "outside"));
  await writeFile(join(project, "project.godot"), "config_version=5\n");
  await writeFile(join(project, "scenes", "main.tscn"), "");
  await writeFile(join(base, "outside", "secret.gd"), "");
  await symlink(join(base, "outside", "secret.gd"), join(project, "escape.gd"));
  await symlink(join(base, "outside"), join(project, "outdir"));
  await symlink(join(base, "nowhere"), join(project, "dangling.gd"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PathError) return err.code;
    throw err;
  }
  throw new Error("expected PathError");
}

describe("resolveProjectDir", () => {
  test("returns the real path of a project", async () => {
    expect(await resolveProjectDir(project)).toBe(await realpath(project));
  });

  test("rejects a relative path", async () => {
    expect(await codeOf(resolveProjectDir("project"))).toBe("NOT_ABSOLUTE");
  });

  test("rejects a directory without project.godot", async () => {
    expect(await codeOf(resolveProjectDir(join(base, "bare")))).toBe(
      "NOT_A_PROJECT",
    );
  });

  test("rejects a missing directory", async () => {
    expect(await codeOf(resolveProjectDir(join(base, "missing")))).toBe(
      "NOT_A_PROJECT",
    );
  });
});

describe("resolveResPath", () => {
  test("resolves res:// and relative paths inside the project", async () => {
    const root = await resolveProjectDir(project);
    const expected = join(root, "scenes", "main.tscn");
    expect(await resolveResPath(root, "res://scenes/main.tscn")).toBe(expected);
    expect(await resolveResPath(root, "scenes/main.tscn")).toBe(expected);
  });

  test("rejects res://../x", async () => {
    const root = await resolveProjectDir(project);
    expect(
      await codeOf(resolveResPath(root, "res://../outside/secret.gd")),
    ).toBe("INVALID_RES_PATH");
  });

  test("rejects an absolute path", async () => {
    const root = await resolveProjectDir(project);
    expect(
      await codeOf(resolveResPath(root, join(base, "outside", "secret.gd"))),
    ).toBe("INVALID_RES_PATH");
  });

  test("rejects a file symlink that escapes the project", async () => {
    const root = await resolveProjectDir(project);
    expect(await codeOf(resolveResPath(root, "res://escape.gd"))).toBe(
      "OUTSIDE_PROJECT",
    );
  });

  test("rejects a directory symlink that escapes the project", async () => {
    const root = await resolveProjectDir(project);
    expect(await codeOf(resolveResPath(root, "res://outdir/secret.gd"))).toBe(
      "OUTSIDE_PROJECT",
    );
  });

  test("rejects a dangling symlink", async () => {
    const root = await resolveProjectDir(project);
    expect(await codeOf(resolveResPath(root, "res://dangling.gd"))).toBe(
      "NOT_FOUND",
    );
  });

  test("rejects a missing file", async () => {
    const root = await resolveProjectDir(project);
    expect(await codeOf(resolveResPath(root, "res://nope.tscn"))).toBe(
      "NOT_FOUND",
    );
  });
});
