import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
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
  startEditor,
} from "./harness.ts";

// The slice 4 script tools against a real editor: read_script, create_script, edit_script and
// validate_script. Scripts that are deliberately broken are named bad_*; the engine prints a
// SCRIPT ERROR when it loads one, and the last test accepts exactly those.
//
// Not covered here: the dirty-buffer refusal of edit_script and `unsavedInEditor` being true. The
// headless editor opens no script tab, so both are checked by code review only.

let editor: Editor;

const GOOD = "extends Node2D\n\nfunc hello() -> int:\n\treturn 1\n";

beforeAll(async () => {
  const port = await freePort();
  const dir = await prepareProject(port);
  await writeFile(join(dir, "good.gd"), GOOD);
  // CRLF, a tab, a multibyte character and no trailing newline must all survive a read.
  await writeFile(
    join(dir, "exact.gd"),
    "extends Node\r\n# héllo ✓\r\n\tvar a = 1",
  );
  await writeFile(join(dir, "Foo.cs"), "public partial class Foo {}\n");
  await writeFile(join(dir, "huge.gd"), Buffer.alloc(2 * 1024 * 1024, "#"));
  await writeFile(
    join(dir, "binary.gd"),
    Buffer.from([0x65, 0xff, 0xfe, 0x0a]),
  );
  await writeFile(
    join(dir, "bad_load.gd"),
    "extends Node\n\nfunc f() -> void:\n\tvar x := \n\tpass\n",
  );
  await writeFile(
    join(dir, "warn.gd"),
    "extends Node\n\nfunc f() -> void:\n\tvar unused := 1\n",
  );
  await writeFile(
    join(dir, "marker_validate.gd"),
    '@tool\nextends Node\n\nstatic func _static_init() -> void:\n\tprint("MARKER_VALIDATE_LOADED")\n',
  );
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
const failure = (name: string, args: Record<string, unknown> = {}) =>
  failureOn(editor, name, args);
const onDisk = (path: string) =>
  readFile(join(editor.dir, path.replace("res://", "")), "utf8");

describe("read_script", () => {
  test("returns the exact text and says whether the editor holds unsaved changes", async () => {
    expect(await ok("read_script", { path: "res://good.gd" })).toEqual({
      content: GOOD,
      unsavedInEditor: false,
    });
    const exact = await ok("read_script", { path: "res://exact.gd" });
    expect(exact.content).toBe("extends Node\r\n# héllo ✓\r\n\tvar a = 1");
    expect(exact.unsavedInEditor).toBe(false);
  });

  test("a C# file can be read", async () => {
    expect((await ok("read_script", { path: "res://Foo.cs" })).content).toBe(
      "public partial class Foo {}\n",
    );
  });

  test("a wrong type, a bad path and a missing file are refused", async () => {
    for (const path of [
      "res://icon.svg",
      "res://main.tscn",
      "res://project.godot",
      "res://../x.gd",
      "res://.godot/x.gd",
      "/etc/passwd",
    ])
      expect([path, await failure("read_script", { path })]).toEqual([
        path,
        "INVALID_PATH",
      ]);
    expect(await failure("read_script", { path: "res://nope.gd" })).toBe(
      "FILE_NOT_FOUND",
    );
  });

  test("a 2 MB file gives TOO_LARGE and a non-UTF-8 file NOT_UTF8", async () => {
    expect(await failure("read_script", { path: "res://huge.gd" })).toBe(
      "TOO_LARGE",
    );
    expect(await failure("read_script", { path: "res://binary.gd" })).toBe(
      "NOT_UTF8",
    );
    expect(
      await failure("edit_script", { path: "res://binary.gd", content: "x" }),
    ).toBe("NOT_UTF8");
  });
});

describe("create_script", () => {
  test("writes the file, reports no diagnostics, and the script attaches", async () => {
    const created = await ok("create_script", {
      path: "res://made.gd",
      extends: "Node2D",
      className: "MadeScript",
      content: "@export var speed := 3\n",
    });
    expect(created).toEqual({ path: "res://made.gd", diagnostics: [] });
    expect(await onDisk("res://made.gd")).toBe(
      "class_name MadeScript\nextends Node2D\n\n@export var speed := 3\n",
    );
    await freshSceneOn(editor);
    await ok("add_node", { parentPath: ".", type: "Node2D", name: "N" });
    const attached = await ok("update_property", {
      path: "N",
      property: "script",
      value: "res://made.gd",
    });
    expect(attached.value.value).toBe("res://made.gd");
    expect(
      (await ok("get_node_properties", { path: "N", names: ["speed"] }))
        .properties.speed.value,
    ).toBe(3);
  });

  test("with only path and extends it writes the extends line", async () => {
    await ok("create_script", { path: "res://plain.gd", extends: "Node" });
    expect(await onDisk("res://plain.gd")).toBe("extends Node\n");
  });

  test("an existing path is refused and left alone", async () => {
    expect(
      await failure("create_script", {
        path: "res://good.gd",
        extends: "Node",
      }),
    ).toBe("FILE_EXISTS");
    expect(await onDisk("res://good.gd")).toBe(GOOD);
  });

  test("bad arguments are refused and write nothing", async () => {
    const base = { path: "res://refused.gd", extends: "Node" };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, extends: "NoSuchClass" }, "INVALID_VALUE"],
      [{ ...base, extends: "Node\nfunc x(): pass" }, "INVALID_VALUE"],
      [{ ...base, extends: '"res://good.gd"' }, "INVALID_VALUE"],
      [{ ...base, className: "Bad Name" }, "INVALID_VALUE"],
      [{ ...base, className: "1abc" }, "INVALID_VALUE"],
      [{ ...base, className: "A\nextends Node" }, "INVALID_VALUE"],
      [{ ...base, path: "res://refused.txt" }, "INVALID_PATH"],
      [{ ...base, path: "res://refused.tscn" }, "INVALID_PATH"],
      [{ ...base, path: "res://../refused.gd" }, "INVALID_PATH"],
      [{ ...base, path: "res://.godot/refused.gd" }, "INVALID_PATH"],
      [{ ...base, path: "res://nodir/refused.gd" }, "DIR_NOT_FOUND"],
    ];
    for (const [args, code] of cases)
      expect([args, await failure("create_script", args)]).toEqual([
        args,
        code,
      ]);
    expect(await Bun.file(join(editor.dir, "refused.gd")).exists()).toBe(false);
  });

  test("a syntax error is written and reported at its line", async () => {
    const result = await ok("create_script", {
      path: "res://bad_created.gd",
      extends: "Node",
      content: "func a():\n\tvar y = (\n",
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].line).toBe(4);
    expect(result.diagnostics[0].message).toContain("Parse Error");
    expect(await onDisk("res://bad_created.gd")).toContain("var y = (");
  });
});

describe("C# scripts", () => {
  const NOTE = "C# diagnostics come from build_dotnet";

  test("create_script writes a partial class named after the file, with no diagnostics", async () => {
    expect(
      await ok("create_script", {
        path: "res://Plain.cs",
        extends: "Node2D",
      }),
    ).toEqual({ path: "res://Plain.cs", diagnostics: [], note: NOTE });
    expect(await onDisk("res://Plain.cs")).toBe(
      "using Godot;\n\npublic partial class Plain : Node2D\n{\n}\n",
    );
  });

  test("a namespace becomes a file-scoped declaration, and content is the class body", async () => {
    await ok("create_script", {
      path: "res://Spaced.cs",
      extends: "Node",
      namespace: "Game.Actors",
      content: "\tpublic int Speed = 3;",
    });
    expect(await onDisk("res://Spaced.cs")).toBe(
      "using Godot;\n\nnamespace Game.Actors;\n\npublic partial class Spaced : Node\n{\n\tpublic int Speed = 3;\n}\n",
    );
  });

  test("bad arguments are refused and write nothing", async () => {
    const base = { path: "res://Refused.cs", extends: "Node" };
    await ok("create_script", {
      path: "res://cs_probe.gd",
      extends: "Node",
      className: "CsProbe",
    });
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, className: "Other" }, "INVALID_ARGUMENT"],
      [{ ...base, namespace: "A..B" }, "INVALID_VALUE"],
      [{ ...base, namespace: "A.1B" }, "INVALID_VALUE"],
      [{ ...base, namespace: "A;\nclass X {}" }, "INVALID_VALUE"],
      [{ ...base, extends: "NoSuchClass" }, "INVALID_VALUE"],
      // A GDScript class_name is not a C# base.
      [{ ...base, extends: "CsProbe" }, "INVALID_VALUE"],
      [{ ...base, path: "res://Not-An-Identifier.cs" }, "INVALID_PATH"],
      [{ ...base, path: "res://1Bad.cs" }, "INVALID_PATH"],
      [
        { ...base, path: "res://addons/godot_mcp/Refused.cs" },
        "PROTECTED_PATH",
      ],
      [
        { path: "res://refused.gd", extends: "Node", namespace: "A" },
        "INVALID_ARGUMENT",
      ],
    ];
    for (const [args, code] of cases)
      expect([args, await failure("create_script", args)]).toEqual([
        args,
        code,
      ]);
    expect(await Bun.file(join(editor.dir, "Refused.cs")).exists()).toBe(false);
    expect(await Bun.file(join(editor.dir, "refused.gd")).exists()).toBe(false);
  });

  test("an existing .cs path is refused", async () => {
    expect(
      await failure("create_script", { path: "res://Foo.cs", extends: "Node" }),
    ).toBe("FILE_EXISTS");
  });

  test("edit_script replaces text and a BOM survives, with no diagnostics", async () => {
    await writeFile(
      join(editor.dir, "Edited.cs"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("public partial class Edited {\n  int a = 1;\n}\n"),
      ]),
    );
    expect(
      await ok("edit_script", {
        path: "res://Edited.cs",
        oldText: "a = 1",
        newText: "a = 2 +",
      }),
    ).toEqual({ path: "res://Edited.cs", diagnostics: [], note: NOTE });
    const bytes = await readFile(join(editor.dir, "Edited.cs"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString()).toBe(
      "public partial class Edited {\n  int a = 2 +;\n}\n",
    );
    expect(
      await failure("edit_script", {
        path: "res://Edited.cs",
        oldText: "absent",
        newText: "x",
      }),
    ).toBe("NO_MATCH");
  });

  test("validate_script stays .gd only", async () => {
    expect(await failure("validate_script", { path: "res://Foo.cs" })).toBe(
      "INVALID_PATH",
    );
  });
});

describe("edit_script", () => {
  const seed = async (name: string, text: string) => {
    await writeFile(join(editor.dir, name), text);
    return `res://${name}`;
  };

  test("replaces one exact occurrence", async () => {
    const path = await seed(
      "e1.gd",
      "extends Node\n\nvar a := 1\nvar b := 2\n",
    );
    const result = await ok("edit_script", {
      path,
      oldText: "var b := 2",
      newText: "var b := 20\nvar c := 3",
    });
    expect(result).toEqual({ path, diagnostics: [] });
    expect(await onDisk(path)).toBe(
      "extends Node\n\nvar a := 1\nvar b := 20\nvar c := 3\n",
    );
  });

  test("an empty newText deletes the match", async () => {
    const path = await seed("e2.gd", "extends Node\n# drop me\n");
    await ok("edit_script", { path, oldText: "# drop me\n", newText: "" });
    expect(await onDisk(path)).toBe("extends Node\n");
  });

  test("NO_MATCH and AMBIGUOUS_MATCH leave the file alone", async () => {
    const path = await seed(
      "e3.gd",
      "extends Node\nvar a := 1\nvar a2 := 1\naaa\n",
    );
    const before = await onDisk(path);
    expect(
      await failure("edit_script", { path, oldText: "var z", newText: "x" }),
    ).toBe("NO_MATCH");
    expect(
      await failure("edit_script", { path, oldText: ":= 1", newText: ":= 2" }),
    ).toBe("AMBIGUOUS_MATCH");
    // "aa" occurs at offsets 0 and 1 of "aaa", which overlap.
    expect(
      await failure("edit_script", { path, oldText: "aa", newText: "b" }),
    ).toBe("AMBIGUOUS_MATCH");
    // Line endings are matched literally.
    expect(
      await failure("edit_script", {
        path,
        oldText: "extends Node\r\n",
        newText: "x",
      }),
    ).toBe("NO_MATCH");
    expect(await onDisk(path)).toBe(before);
  });

  test("the argument modes are exclusive", async () => {
    const path = await seed("e4.gd", "extends Node\n");
    for (const args of [
      {},
      { oldText: "a" },
      { newText: "a" },
      { content: "x", oldText: "a", newText: "b" },
      { content: "x", newText: "b" },
      { oldText: "", newText: "b" },
    ])
      expect([args, await failure("edit_script", { path, ...args })]).toEqual([
        args,
        "INVALID_ARGUMENT",
      ]);
    expect(await onDisk(path)).toBe("extends Node\n");
  });

  test("content replaces the whole file", async () => {
    const path = await seed("e5.gd", "extends Node\n");
    const result = await ok("edit_script", {
      path,
      content: "@tool\nextends Node2D\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(await onDisk(path)).toBe("@tool\nextends Node2D\n");
  });

  test("a syntax error on line 3 is written and reported at line 3", async () => {
    const path = await seed(
      "bad_e6.gd",
      "extends Node\n\nfunc f() -> void:\n\tpass\n",
    );
    const result = await ok("edit_script", {
      path,
      oldText: "\tpass\n",
      newText: "\tvar x := \n",
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].line).toBe(4);
    // The same file with the error on line 3.
    const third = await ok("edit_script", {
      path,
      content: "extends Node\n\nvar x := \n",
    });
    expect(third.diagnostics).toHaveLength(1);
    expect(third.diagnostics[0].line).toBe(3);
    expect(await onDisk(path)).toBe("extends Node\n\nvar x := \n");
    // Fixing it clears the diagnostics.
    expect(
      (await ok("edit_script", { path, content: "extends Node\n" }))
        .diagnostics,
    ).toEqual([]);
  });

  // The diagnostics load in edit_script reloads the cached Script in place, which is why the later
  // attach sees the new source.
  test("a script that was loaded earlier sees the edit", async () => {
    const path = "res://cached.gd";
    await ok("create_script", {
      path,
      extends: "Node2D",
      content: "@export var speed := 1\n",
    });
    await freshSceneOn(editor);
    await ok("add_node", { parentPath: ".", type: "Node2D", name: "A" });
    await ok("update_property", { path: "A", property: "script", value: path });
    await ok("edit_script", { path, oldText: ":= 1", newText: ":= 2" });
    await ok("add_node", { parentPath: ".", type: "Node2D", name: "B" });
    await ok("update_property", { path: "B", property: "script", value: path });
    expect(
      (await ok("get_node_properties", { path: "B", names: ["speed"] }))
        .properties.speed.value,
    ).toBe(2);
  });

  test("a UTF-8 BOM is not text, and survives an edit", async () => {
    await writeFile(
      join(editor.dir, "bom.gd"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("extends Node\nvar a := 1\n"),
      ]),
    );
    const path = "res://bom.gd";
    expect((await ok("read_script", { path })).content).toBe(
      "extends Node\nvar a := 1\n",
    );
    await ok("edit_script", { path, oldText: ":= 1", newText: ":= 2" });
    const bytes = await readFile(join(editor.dir, "bom.gd"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString()).toBe("extends Node\nvar a := 2\n");
  });

  test("oldText over 64 KB is refused", async () => {
    const path = await seed("e10.gd", "extends Node\n");
    expect(
      await failure("edit_script", {
        path,
        oldText: "x".repeat(65 * 1024),
        newText: "y",
      }),
    ).toBe("TOO_LARGE");
  });

  test("a read-only file is refused", async () => {
    const path = await seed("e7.gd", "extends Node\n");
    await chmod(join(editor.dir, "e7.gd"), 0o444);
    expect(
      await failure("edit_script", { path, content: "extends Node2D\n" }),
    ).toBe("WRITE_FAILED");
    expect(await onDisk(path)).toBe("extends Node\n");
  });

  test("a result over 1 MB is refused", async () => {
    const filler = "#".repeat(600 * 1024);
    const path = await seed("e8.gd", `extends Node\n${filler}\n`);
    expect(
      await failure("edit_script", {
        path,
        oldText: "extends Node\n",
        newText: `extends Node\n${filler}\n`,
      }),
    ).toBe("TOO_LARGE");
    expect((await onDisk(path)).length).toBe(
      `extends Node\n${filler}\n`.length,
    );
  });
});

describe("the addon cannot be rewritten through script tools", () => {
  const protectedPaths = [
    "res://addons/godot_mcp/plugin.gd",
    "res://addons/godot_mcp/tools/new.gd",
    "res://addons/Godot_MCP/plugin.gd",
    "res://ADDONS/godot_mcp/plugin.gd",
  ];

  test("create_script and edit_script refuse every path under addons/godot_mcp/", async () => {
    const before = await onDisk("res://addons/godot_mcp/plugin.gd");
    for (const path of protectedPaths) {
      expect([
        path,
        await failure("create_script", { path, extends: "Node" }),
      ]).toEqual([path, "PROTECTED_PATH"]);
      expect([
        path,
        await failure("edit_script", { path, content: "extends Node\n" }),
      ]).toEqual([path, "PROTECTED_PATH"]);
    }
    expect(await onDisk("res://addons/godot_mcp/plugin.gd")).toBe(before);
    expect(
      await Bun.file(
        join(editor.dir, "addons/godot_mcp/tools/new.gd"),
      ).exists(),
    ).toBe(false);
  });

  test("the addon can still be read, but validating it is refused", async () => {
    const read = await ok("read_script", {
      path: "res://addons/godot_mcp/tool_error.gd",
    });
    expect(read.content).toContain("static func fail");
    // Reloading a Script whose functions are on the call stack crashed the editor.
    for (const file of [
      "tool_error.gd",
      "mcp_server.gd",
      "tools/script_tools.gd",
    ])
      expect(
        await failure("validate_script", {
          path: `res://addons/godot_mcp/${file}`,
        }),
      ).toBe("PROTECTED_PATH");
    expect(await ok("get_project_info")).toBeDefined();
  });
});

describe("validate_script", () => {
  test("a clean file is ok", async () => {
    expect(await ok("validate_script", { path: "res://good.gd" })).toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  test("a broken file gives its error and line", async () => {
    const result = await ok("validate_script", { path: "res://bad_load.gd" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        line: 4,
        message:
          'Parse Error: Expected expression for variable initial value after "=".',
      },
    ]);
  });

  test("GDScript warnings never reach the log, so a warning-only file is ok", async () => {
    expect(await ok("validate_script", { path: "res://warn.gd" })).toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  test("a wrong type or a missing file is refused", async () => {
    for (const path of ["res://Foo.cs", "res://main.tscn", "res://../x.gd"])
      expect([path, await failure("validate_script", { path })]).toEqual([
        path,
        "INVALID_PATH",
      ]);
    expect(await failure("validate_script", { path: "res://nope.gd" })).toBe(
      "FILE_NOT_FOUND",
    );
  });

  test("validation runs static initializers (the marker is live)", async () => {
    expect(editor.output()).not.toContain("MARKER_VALIDATE_LOADED");
    expect(
      (await ok("validate_script", { path: "res://marker_validate.gd" })).ok,
    ).toBe(true);
    expect(editor.output()).toContain("MARKER_VALIDATE_LOADED");
  });
});

describe("editor output", () => {
  test("every SCRIPT ERROR names a script this suite broke on purpose", () => {
    const lines = editor.output().split("\n");
    const errors = lines.flatMap((line, i) =>
      line.includes("SCRIPT ERROR") ? [lines[i + 1] ?? ""] : [],
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const location of errors)
      expect(location).toMatch(
        /^\s+at: GDScript::reload \(res:\/\/bad_[a-z0-9_]+\.gd:\d+\)$/,
      );
  });
});
