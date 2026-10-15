import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "../helpers.ts";
import {
  callTool,
  type Editor,
  failure as failureOn,
  freePort,
  freshScene as freshSceneOn,
  ok as okOn,
  prepareProject,
  removeProjects,
  saved as savedOn,
  startEditor,
} from "./harness.ts";

// The slice 3 file, project and play tools against a real editor: save_scene, create_scene,
// set_project_setting, play_scene and stop_scene.

let editor: Editor;

beforeAll(async () => {
  const port = await freePort();
  const dir = await prepareProject(port);
  await writeFile(join(dir, "attach.gd"), "extends Node2D\n");
  await writeFile(
    join(dir, "other.tscn"),
    '[gd_scene format=3]\n\n[node name="Other" type="Node"]\n',
  );
  await writeFile(
    join(dir, "remapped.tscn.remap"),
    '[remap]\n\npath="res://other.tscn"\n',
  );
  await mkdir(join(dir, "locked"));
  editor = await startEditor({ dir, port });
  // The icon must be imported before a scene that uses it opens.
  await waitFor(async () => {
    const info = await callTool(editor, "get_project_info");
    return info.structuredContent.scanning === false ? true : undefined;
  }, 60_000);
}, 180_000);

afterAll(async () => {
  await editor?.stop();
  await removeProjects();
});

const ok = (name: string, args: Record<string, unknown> = {}) =>
  okOn(editor, name, args);
const failure = (
  name: string,
  args: Record<string, unknown> = {},
  bare: Pick<Editor, "port" | "auth"> = editor,
) => failureOn(bare, name, args);
const freshScene = () => freshSceneOn(editor);
const saved = (path: string) => savedOn(editor, path);

describe("save_scene", () => {
  test("a read-only .tscn gives SAVE_FAILED and keeps its content", async () => {
    const path = await freshScene();
    const file = join(editor.dir, path.replace("res://", ""));
    await ok("add_node", { parentPath: ".", type: "Node", name: "Unsaved" });
    await chmod(file, 0o444);
    expect(await failure("save_scene")).toBe("SAVE_FAILED");
    expect(await readFile(file, "utf8")).not.toContain("Unsaved");
    await chmod(file, 0o644);
    expect(await saved(path)).toContain("Unsaved");
  });

  test("a read-only directory gives SAVE_FAILED", async () => {
    await ok("create_scene", {
      path: "res://locked/in.tscn",
      rootType: "Node",
    });
    await ok("add_node", { parentPath: ".", type: "Node", name: "Unsaved" });
    await chmod(join(editor.dir, "locked"), 0o555);
    try {
      // The message carries the editor's own error line, so the Logger check is what failed it.
      const result = await callTool(editor, "save_scene");
      expect(result.structuredContent.error.code).toBe("SAVE_FAILED");
      expect(result.structuredContent.error.message).toContain(
        "Cannot save file",
      );
    } finally {
      await chmod(join(editor.dir, "locked"), 0o755);
    }
    const text = await saved("res://locked/in.tscn");
    expect(text).toContain("Unsaved");
  });

  test("a scene that gained a .remap is not overwritten", async () => {
    const path = await freshScene();
    await ok("add_node", { parentPath: ".", type: "Node", name: "Unsaved" });
    const file = join(editor.dir, path.replace("res://", ""));
    await writeFile(`${file}.remap`, '[remap]\n\npath="res://other.tscn"\n');
    expect(await failure("save_scene")).toBe("SAVE_FAILED");
    expect(await readFile(file, "utf8")).not.toContain("Unsaved");
    expect(
      await readFile(join(editor.dir, "other.tscn"), "utf8"),
    ).not.toContain("Unsaved");
    await rm(`${file}.remap`);
    expect(await saved(path)).toContain("Unsaved");
  });

  test("a save clears the scene from unsavedScenes", async () => {
    const path = await freshScene();
    await ok("add_node", { parentPath: ".", type: "Node", name: "N" });
    expect((await ok("get_project_info")).unsavedScenes).toContain(path);
    expect(await ok("save_scene")).toEqual({ path });
    expect((await ok("get_project_info")).unsavedScenes).not.toContain(path);
  });
});

describe("create_scene", () => {
  test("creates, opens and saves a scene with the given root", async () => {
    const result = await ok("create_scene", {
      path: "res://made.tscn",
      rootType: "Control",
      rootName: "Panel",
    });
    expect(result).toEqual({ path: "res://made.tscn" });
    expect((await ok("get_scene_tree")).scenePath).toBe("res://made.tscn");
    const text = await readFile(join(editor.dir, "made.tscn"), "utf8");
    expect(text).toContain('[node name="Panel" type="Control"');
  });

  test("the root is named after the file by default", async () => {
    await ok("create_scene", {
      path: "res://my_level-two.tscn",
      rootType: "Node2D",
    });
    expect((await ok("get_scene_tree")).root.name).toBe("MyLevelTwo");
  });

  test("an existing path is refused and left alone", async () => {
    expect(
      await failure("create_scene", {
        path: "res://sub.tscn",
        rootType: "Node",
      }),
    ).toBe("FILE_EXISTS");
    expect(await readFile(join(editor.dir, "sub.tscn"), "utf8")).toContain(
      "SubChild",
    );
  });

  test("bad paths and root types are refused", async () => {
    for (const [path, code] of [
      ["res://../escape.tscn", "INVALID_PATH"],
      ["res://.godot/x.tscn", "INVALID_PATH"],
      ["res://a\\b.tscn", "INVALID_PATH"],
      ["res://./x.tscn", "INVALID_PATH"],
      ["/tmp/x.tscn", "INVALID_PATH"],
      ["res://x.txt", "INVALID_PATH"],
      ["res://nodir/x.tscn", "DIR_NOT_FOUND"],
    ] as const)
      expect([
        path,
        await failure("create_scene", { path, rootType: "Node" }),
      ]).toEqual([path, code]);
    for (const rootType of ["Resource", "EditorPlugin", "Node3DDoesNotExist"])
      expect(
        await failure("create_scene", { path: "res://bad.tscn", rootType }),
      ).toBe("INVALID_TYPE");
    expect(
      await failure("create_scene", {
        path: "res://bad.tscn",
        rootType: "Node",
        rootName: "a/b",
      }),
    ).toBe("INVALID_VALUE");
  });

  test("a .remap beside the path is refused, since it redirects loading", async () => {
    expect(
      await failure("create_scene", {
        path: "res://remapped.tscn",
        rootType: "Node",
      }),
    ).toBe("INVALID_PATH");
    expect(await failure("open_scene", { path: "res://remapped.tscn" })).toBe(
      "INVALID_PATH",
    );
    expect(await readFile(join(editor.dir, "other.tscn"), "utf8")).toContain(
      'name="Other"',
    );
  });
});

describe("set_project_setting", () => {
  test("a change lands in project.godot", async () => {
    const result = await ok("set_project_setting", {
      name: "display/window/size/viewport_width",
      value: 800,
    });
    expect(result).toEqual({
      name: "display/window/size/viewport_width",
      previous: { type: "int", value: 1152 },
      value: { type: "int", value: 800 },
    });
    const text = await readFile(join(editor.dir, "project.godot"), "utf8");
    expect(text).toMatch(/viewport_width=800/);
    const read = await ok("get_project_settings", {
      prefix: "display/window/size/viewport_width",
    });
    expect(read.settings["display/window/size/viewport_width"].value).toBe(800);
  });

  test("main scene and a new setting are written", async () => {
    try {
      await mainSceneAndNewSettings();
    } finally {
      // Later tests play the main scene.
      await ok("set_project_setting", {
        name: "application/run/main_scene",
        value: "res://main.tscn",
      });
    }
  });

  const mainSceneAndNewSettings = async () => {
    await ok("set_project_setting", {
      name: "application/run/main_scene",
      value: "res://sub.tscn",
    });
    const big = await ok("set_project_setting", {
      name: "mutation_test/big",
      value: 1e20,
    });
    expect(big.value.type).toBe("float");
    const created = await ok("set_project_setting", {
      name: "mutation_test/flag",
      value: true,
    });
    expect(created.previous).toBeNull();
    const dict = await ok("set_project_setting", {
      name: "mutation_test/table",
      value: { "1": "a", "01": "b" },
    });
    expect(dict.value.value).toEqual({ "1": "a", "01": "b" });
    const text = await readFile(join(editor.dir, "project.godot"), "utf8");
    expect(text).toContain('run/main_scene="res://sub.tscn"');
    expect(text).toContain("flag=true");
    expect(text).toContain('"01": "b"');
    expect((await ok("get_project_info")).mainScene).toBe("res://sub.tscn");
  };

  test("main scene and autoloads accept a uid:// that resolves to a checked path", async () => {
    const path = await freshScene();
    await ok("save_scene");
    const header = await readFile(join(editor.dir, path.slice(6)), "utf8");
    const uid = header.match(/uid="(uid:\/\/[^"]+)"/)?.[1];
    expect(uid).toBeDefined();
    // The editor writes a .uid file beside each script it indexes.
    const scriptUid = (
      await readFile(join(editor.dir, "game_state.gd.uid"), "utf8")
    ).trim();
    expect(scriptUid).toStartWith("uid://");
    try {
      const result = await ok("set_project_setting", {
        name: "application/run/main_scene",
        value: uid,
      });
      expect(result.value.value).toBe(uid);
      await ok("set_project_setting", {
        name: "autoload/GameState",
        value: `*${scriptUid}`,
      });
      const text = await readFile(join(editor.dir, "project.godot"), "utf8");
      expect(text).toContain(`run/main_scene="${uid}"`);
      expect(text).toContain(`GameState="*${scriptUid}"`);
    } finally {
      await ok("set_project_setting", {
        name: "application/run/main_scene",
        value: "res://main.tscn",
      });
      await ok("set_project_setting", {
        name: "autoload/GameState",
        value: "*res://game_state.gd",
      });
    }
    // An unknown uid fails; a known one is held to the same extension rule as its path.
    for (const value of ["uid://nonsense", "uid://", "uid://aaaaaaaaaaaaa"])
      expect([
        value,
        await failure("set_project_setting", {
          name: "application/run/main_scene",
          value,
        }),
      ]).toEqual([value, "INVALID_VALUE"]);
    expect(
      await failure("set_project_setting", {
        name: "application/run/main_scene",
        value: scriptUid,
      }),
    ).toBe("INVALID_PATH");
  });

  test("settings that run code or change the command line are refused", async () => {
    // main_run_args is how play mode got an arbitrary --log-file path.
    for (const name of [
      "editor/run/main_run_args",
      "Editor/Run/Main_Run_Args",
      "editor/anything/else",
    ])
      expect([
        name,
        await failure("set_project_setting", {
          name,
          value: "--headless --log-file /tmp/x",
        }),
      ]).toEqual([name, "PROTECTED_SETTING"]);
    expect(
      await failure("set_project_setting", {
        name: "autoload/Zz",
        value: "*res://nope\nshell line #\n.gd",
      }),
    ).toBe("INVALID_PATH");
    expect(
      await failure("set_project_setting", {
        name: "autoload/Zz",
        value: "*res://nope.gd",
      }),
    ).toBe("FILE_NOT_FOUND");
    for (const value of ["res://../x.tscn", "/etc/passwd", "res://nope.tscn"])
      expect(
        await failure("set_project_setting", {
          name: "application/run/main_scene",
          value,
        }),
      ).toMatch(/^(INVALID_PATH|FILE_NOT_FOUND)$/);
    expect(
      await failure("set_project_setting", {
        name: "application/config/name",
        value: "two\nlines",
      }),
    ).toBe("INVALID_VALUE");
    expect(
      await failure("set_project_setting", {
        name: "mutation_test/list",
        value: ["fine", "bad\u0001"],
      }),
    ).toBe("INVALID_VALUE");
    const text = await readFile(join(editor.dir, "project.godot"), "utf8");
    expect(text).not.toContain("Zz");
    expect(text).not.toContain("log-file");
  });

  test("a failed write restores the setting", async () => {
    const name = "display/window/size/viewport_height";
    const before = (await ok("get_project_settings", { prefix: name }))
      .settings[name].value;
    await chmod(editor.dir, 0o555);
    try {
      expect(await failure("set_project_setting", { name, value: 321 })).toBe(
        "SAVE_FAILED",
      );
    } finally {
      await chmod(editor.dir, 0o755);
    }
    const after = await ok("get_project_settings", { prefix: name });
    expect(after.settings[name].value).toBe(before);
  });

  test("integer literals outside their type are refused", async () => {
    expect(
      await failure("set_project_setting", {
        name: "display/window/size/initial_position",
        value: "Vector2i(4294967297, 0)",
      }),
    ).toBe("INVALID_VALUE");
  });

  test("protected keys, bad names and bad values are refused", async () => {
    for (const name of [
      "editor_plugins/enabled",
      "Editor_Plugins/Enabled",
      "godot_mcp/server/port",
      "godot_mcp/x",
      "GODOT_MCP/server/port",
    ])
      expect([
        name,
        await failure("set_project_setting", { name, value: "x" }),
      ]).toEqual([name, "PROTECTED_SETTING"]);
    for (const name of [
      "noslash",
      "a//b",
      "/a/b",
      "a/b/",
      "a/../b",
      "a/b c",
      "editor_plugins//enabled",
      "",
    ])
      expect([
        name,
        await failure("set_project_setting", { name, value: 1 }),
      ]).toEqual([name, "INVALID_NAME"]);
    expect(
      await failure("set_project_setting", {
        name: "display/window/size/viewport_width",
        value: "wide",
      }),
    ).toBe("INVALID_VALUE");
    expect(
      await failure("set_project_setting", {
        name: "display/window/size/viewport_width",
        value: 99.5,
      }),
    ).toBe("INVALID_VALUE");
    expect(
      await failure("set_project_setting", {
        name: "mutation_test/nothing",
        value: null,
      }),
    ).toBe("UNSUPPORTED_TYPE");
    const text = await readFile(join(editor.dir, "project.godot"), "utf8");
    expect(text).toMatch(
      /enabled=PackedStringArray\("res:\/\/addons\/godot_mcp\/plugin.cfg"\)/,
    );
    expect(text).not.toContain("viewport_width=99");
  });
});

describe("play_scene and stop_scene", () => {
  test("play and stop toggle playingScene", async () => {
    expect((await ok("get_project_info")).playingScene).toBeNull();
    expect(await ok("play_scene", { mode: "main" })).toEqual({
      playingScene: "res://main.tscn",
    });
    expect((await ok("get_project_info")).playingScene).toBe("res://main.tscn");
    expect(await ok("stop_scene")).toEqual({ stopped: true });
    expect((await ok("get_project_info")).playingScene).toBeNull();
    expect(await ok("stop_scene")).toEqual({ stopped: false });
  });

  test("custom and current modes", async () => {
    expect(
      await ok("play_scene", { mode: "custom", path: "res://sub.tscn" }),
    ).toEqual({ playingScene: "res://sub.tscn" });
    await ok("stop_scene");
    await ok("open_scene", { path: "res://main.tscn" });
    expect(await ok("play_scene", { mode: "current" })).toEqual({
      playingScene: "res://main.tscn",
    });
    await ok("stop_scene");
  });

  test("play refuses when its autosave would write an unsafe scene", async () => {
    const path = await freshScene();
    const file = join(editor.dir, path.replace("res://", ""));
    await ok("add_node", { parentPath: ".", type: "Node", name: "Unsaved" });
    await chmod(file, 0o444);
    expect(await failure("play_scene", { mode: "main" })).toBe(
      "UNSAFE_AUTOSAVE",
    );
    await chmod(file, 0o644);
    await writeFile(`${file}.remap`, '[remap]\n\npath="res://other.tscn"\n');
    expect(await failure("play_scene", { mode: "main" })).toBe(
      "UNSAFE_AUTOSAVE",
    );
    await rm(`${file}.remap`);
    expect((await ok("get_project_info")).playingScene).toBeNull();
    expect(await readFile(file, "utf8")).not.toContain("Unsaved");
    await ok("save_scene");
  });

  test("bad arguments are refused", async () => {
    expect(await failure("play_scene", { mode: "custom" })).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      await failure("play_scene", { mode: "custom", path: "res://nope.tscn" }),
    ).toBe("FILE_NOT_FOUND");
    expect(
      await failure("play_scene", { mode: "custom", path: "res://../x.tscn" }),
    ).toBe("INVALID_PATH");
    expect(
      await failure("play_scene", { mode: "main", path: "res://sub.tscn" }),
    ).toBe("INVALID_ARGUMENT");
    await expect(
      callTool(editor, "play_scene", { mode: "bogus" }),
    ).rejects.toThrow("-32602");
    expect((await ok("get_project_info")).playingScene).toBeNull();
  });
});

describe("NO_SCENE", () => {
  test("every scene mutation fails cleanly with no scene open", async () => {
    const port = await freePort();
    const dir = await prepareProject(port);
    const project = join(dir, "project.godot");
    const text = await readFile(project, "utf8");
    await writeFile(project, text.replace(/^run\/main_scene=.*\n/m, ""));
    const bare = await startEditor({ dir, port });
    try {
      for (const [name, args] of [
        ["save_scene", {}],
        ["add_node", { parentPath: ".", type: "Node" }],
        ["delete_node", { path: "X" }],
        ["move_node", { path: "X", newParentPath: "." }],
        ["update_property", { path: ".", property: "name", value: "x" }],
        ["play_scene", { mode: "current" }],
      ] as const)
        expect([name, await failure(name, args, bare)]).toEqual([
          name,
          "NO_SCENE",
        ]);
    } finally {
      await bare.stop();
    }
  }, 120_000);
});

test("the editor logged no script errors", () => {
  expect(editor.output()).not.toContain("SCRIPT ERROR");
});
