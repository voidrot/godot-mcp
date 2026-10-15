import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
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
  saved as savedOn,
  startEditor,
} from "./harness.ts";

// The slice 3 scene-edit tools against a real editor: add_node, delete_node, move_node and
// update_property. Persistence is checked by save_scene followed by reading the .tscn from disk.
// Undo replay is not covered here.

let editor: Editor;

beforeAll(async () => {
  const port = await freePort();
  const dir = await prepareProject(port);
  await writeFile(join(dir, "attach.gd"), "extends Node2D\n");
  // Both scripts print when loaded: a marker that fires on load shows code ran.
  await writeFile(
    join(dir, "marker_node.gd"),
    '@tool\nextends Node2D\n\nstatic func _static_init() -> void:\n\tprint("MARKER_NODE_LOADED")\n',
  );
  await writeFile(
    join(dir, "marker_resource.gd"),
    '@tool\nextends Resource\n\nstatic func _static_init() -> void:\n\tprint("MARKER_RESOURCE_LOADED")\n',
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
});

const ok = (name: string, args: Record<string, unknown> = {}) =>
  okOn(editor, name, args);
const failure = (name: string, args: Record<string, unknown> = {}) =>
  failureOn(editor, name, args);
const freshScene = () => freshSceneOn(editor);
const saved = (path: string) => savedOn(editor, path);

const nodeNames = (node: { name: string; children?: unknown[] }): string[] => [
  node.name,
  ...(node.children ?? []).flatMap((c) =>
    nodeNames(c as { name: string; children?: unknown[] }),
  ),
];

const treeNames = async (): Promise<string[]> =>
  nodeNames((await ok("get_scene_tree")).root);

describe("add_node", () => {
  test("a node is saved with its properties and reports an MCP undoAction", async () => {
    const path = await freshScene();
    const added = await ok("add_node", {
      parentPath: ".",
      type: "Sprite2D",
      name: "Hero",
      properties: {
        position: "Vector2(3, 4)",
        visible: false,
        z_index: 2,
        modulate: "#ff0000",
        texture: "res://icon.svg",
      },
    });
    expect(added.path).toBe("Hero");
    expect(added.type).toBe("Sprite2D");
    expect(added.undoAction).toStartWith("MCP: ");
    const text = await saved(path);
    expect(text).toContain('[node name="Hero" type="Sprite2D" parent="."');
    expect(text).toContain("position = Vector2(3, 4)");
    expect(text).toContain("visible = false");
    expect(text).toContain("z_index = 2");
    expect(text).toContain("modulate = Color(1, 0, 0, 1)");
    expect(text).toMatch(/texture = ExtResource\("[^"]+"\)/);
    expect(text).toContain('[ext_resource type="Texture2D"');
  });

  test("a default name is made unique, and a nested path is reported", async () => {
    await freshScene();
    expect((await ok("add_node", { parentPath: ".", type: "Node" })).path).toBe(
      "Node",
    );
    expect(
      (await ok("add_node", { parentPath: ".", type: "Node" })).path,
    ).not.toBe("Node");
    await ok("add_node", { parentPath: ".", type: "Node", name: "A" });
    expect(
      (await ok("add_node", { parentPath: "A", type: "Node", name: "B" })).path,
    ).toBe("A/B");
  });

  test("an instance is saved as an ExtResource", async () => {
    const path = await freshScene();
    const added = await ok("add_node", {
      parentPath: ".",
      scene: "res://sub.tscn",
      name: "Inst",
    });
    expect(added.undoAction).toStartWith("MCP: ");
    const text = await saved(path);
    expect(text).toContain('[ext_resource type="PackedScene"');
    expect(text).toMatch(
      /\[node name="Inst" parent="\." [^\]]*instance=ExtResource\("[^"]+"\)\]/,
    );
    // The instance's own nodes are not copied into this scene.
    expect(text).not.toContain("SubChild");
  });

  test("bad types and arguments are refused", async () => {
    const path = await freshScene();
    for (const type of [
      "Resource",
      "EditorPlugin",
      "CanvasItem",
      "NoSuchClass",
    ])
      expect(await failure("add_node", { parentPath: ".", type })).toBe(
        "INVALID_TYPE",
      );
    expect(await failure("add_node", { parentPath: "." })).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      await failure("add_node", {
        parentPath: ".",
        type: "Node",
        scene: "res://sub.tscn",
      }),
    ).toBe("INVALID_ARGUMENT");
    expect(
      await failure("add_node", { parentPath: "Nope", type: "Node" }),
    ).toBe("NODE_NOT_FOUND");
    expect(
      await failure("add_node", { parentPath: ".", scene: "res://../x.tscn" }),
    ).toBe("INVALID_PATH");
    expect(await failure("add_node", { parentPath: ".", scene: path })).toBe(
      "SCENE_CYCLE",
    );
    expect(
      await failure("add_node", { parentPath: ".", type: "Node", name: "a/b" }),
    ).toBe("INVALID_VALUE");
    await ok("add_node", { parentPath: ".", type: "Node", name: "Same" });
    expect(
      await failure("add_node", {
        parentPath: ".",
        type: "Node",
        name: "Same",
      }),
    ).toBe("DUPLICATE_NAME");
    expect(
      await failure("add_node", {
        parentPath: ".",
        type: "Node",
        properties: { name: "x" },
      }),
    ).toBe("INVALID_ARGUMENT");
    // Nothing from the refused calls reached the tree.
    expect(await treeNames()).toEqual(["Root", "Same"]);
  });

  test("a bad property value refuses the whole call", async () => {
    await freshScene();
    expect(
      await failure("add_node", {
        parentPath: ".",
        type: "Sprite2D",
        properties: { visible: false, z_index: 2.5 },
      }),
    ).toBe("INVALID_VALUE");
    expect(
      await failure("add_node", {
        parentPath: ".",
        type: "Sprite2D",
        properties: { no_such_property: 1 },
      }),
    ).toBe("PROPERTY_NOT_FOUND");
    expect(await treeNames()).toEqual(["Root"]);
  });
});

describe("delete_node and move_node", () => {
  const family = async () => {
    const path = await freshScene();
    for (const [parentPath, name] of [
      [".", "Kid"],
      ["Kid", "Grand"],
      [".", "Other"],
    ] as const)
      await ok("add_node", { parentPath, type: "Node", name });
    await ok("add_node", {
      parentPath: ".",
      scene: "res://sub.tscn",
      name: "Inst",
    });
    return path;
  };

  test("deleting a node with a grandchild removes both", async () => {
    const path = await family();
    const deleted = await ok("delete_node", { path: "Kid" });
    expect(deleted.undoAction).toStartWith("MCP: ");
    expect(await treeNames()).toEqual(["Root", "Other", "Inst"]);
    const text = await saved(path);
    expect(text).not.toContain('"Kid"');
    expect(text).not.toContain('"Grand"');
    expect(text).toContain('name="Other"');
  });

  test("the root and nodes inside an instance cannot be deleted", async () => {
    await family();
    expect(await failure("delete_node", { path: "." })).toBe(
      "INVALID_OPERATION",
    );
    expect(await failure("delete_node", { path: "Inst/SubChild" })).toBe(
      "NODE_NOT_FOUND",
    );
    expect(await failure("delete_node", { path: "Missing" })).toBe(
      "NODE_NOT_FOUND",
    );
  });

  test("a valid move keeps the grandchildren and their owners", async () => {
    const path = await family();
    const moved = await ok("move_node", {
      path: "Kid",
      newParentPath: "Other",
      index: 0,
    });
    expect(moved.path).toBe("Other/Kid");
    expect(moved.undoAction).toStartWith("MCP: ");
    const text = await saved(path);
    expect(text).toContain('[node name="Kid" type="Node" parent="Other"');
    expect(text).toContain('[node name="Grand" type="Node" parent="Other/Kid"');
    const tree = (await ok("get_scene_tree")).root;
    expect(nodeNames(tree)).toEqual(["Root", "Other", "Kid", "Grand", "Inst"]);
  });

  test("an instance moves as one node, and index orders siblings", async () => {
    const path = await family();
    await ok("move_node", { path: "Inst", newParentPath: "Other" });
    await ok("move_node", { path: "Other", newParentPath: ".", index: 0 });
    expect(await treeNames()).toEqual([
      "Root",
      "Other",
      "Inst",
      "Kid",
      "Grand",
    ]);
    const text = await saved(path);
    expect(text).toMatch(/\[node name="Inst" parent="Other" [^\]]*instance=/);
  });

  test("refused moves leave the tree alone", async () => {
    await family();
    const before = await treeNames();
    for (const [args, code] of [
      [{ path: "Kid", newParentPath: "Kid/Grand" }, "INVALID_MOVE"],
      [{ path: "Kid", newParentPath: "Kid" }, "INVALID_MOVE"],
      [{ path: ".", newParentPath: "Kid" }, "INVALID_OPERATION"],
      [{ path: "Kid", newParentPath: "Inst/SubChild" }, "NODE_NOT_FOUND"],
      [{ path: "Kid", newParentPath: "Missing" }, "NODE_NOT_FOUND"],
      [{ path: "Kid", newParentPath: ".", index: 9 }, "INVALID_ARGUMENT"],
    ] as const)
      expect(await failure("move_node", args)).toBe(code);
    expect(before).toEqual(["Root", "Kid", "Grand", "Other", "Inst"]);
    expect(await treeNames()).toEqual(before);
    await ok("add_node", { parentPath: "Other", type: "Node", name: "Kid" });
    expect(
      await failure("move_node", { path: "Kid", newParentPath: "Other" }),
    ).toBe("DUPLICATE_NAME");
    expect(await treeNames()).toEqual([
      "Root",
      "Kid",
      "Grand",
      "Other",
      "Kid",
      "Inst",
    ]);
  });
});

describe("update_property", () => {
  test("values are parsed by declared type and saved", async () => {
    const path = await freshScene();
    await ok("add_node", { parentPath: ".", type: "Sprite2D", name: "S" });
    const result = await ok("update_property", {
      path: "S",
      property: "position",
      value: "Vector2(1.5, -2)",
    });
    expect(result).toEqual({
      previous: { type: "Vector2", value: "Vector2(0, 0)" },
      value: { type: "Vector2", value: "Vector2(1.5, -2)" },
      undoAction: "MCP: set S.position",
    });
    await ok("update_property", { path: "S", property: "z_index", value: 7 });
    await ok("update_property", {
      path: "S",
      property: "centered",
      value: false,
    });
    await ok("update_property", {
      path: "S",
      property: "modulate",
      value: "Color(0, 1, 0, 1)",
    });
    await ok("update_property", {
      path: "S",
      property: "texture",
      value: "res://icon.svg",
    });
    await ok("update_property", {
      path: "S",
      property: "scale",
      value: "Vector2(2, 2)",
    });
    await ok("update_property", {
      path: "S",
      property: "texture",
      value: null,
    });
    const text = await saved(path);
    expect(text).toContain("position = Vector2(1.5, -2)");
    expect(text).toContain("z_index = 7");
    expect(text).toContain("centered = false");
    expect(text).toContain("modulate = Color(0, 1, 0, 1)");
    expect(text).toContain("scale = Vector2(2, 2)");
    expect(text).not.toContain("texture");
  });

  test("the codec refuses values that do not match the declared type", async () => {
    const path = await freshScene();
    await ok("add_node", { parentPath: ".", type: "Sprite2D", name: "S" });
    const bad: [string, unknown, string][] = [
      ["z_index", 2.5, "INVALID_VALUE"],
      ["z_index", "3", "INVALID_VALUE"],
      ["z_index", 1e300, "INVALID_VALUE"],
      ["visible", 1, "INVALID_VALUE"],
      ["position", "Color(1, 0, 0, 1)", "INVALID_VALUE"],
      ["position", "Vector2 (1, 2)", "INVALID_VALUE"],
      ["position", "Vector2(1, 2) ", "INVALID_VALUE"],
      ["position", "Vector2(1)", "INVALID_VALUE"],
      ["position", "Vector2(1, 2).x", "INVALID_VALUE"],
      ["position", "Vector2(1, Object(RefCounted))", "INVALID_VALUE"],
      ["position", "[Object (RefCounted,)]", "INVALID_VALUE"],
      ["position", "Object(RefCounted,)", "INVALID_VALUE"],
      ["position", [1, 2], "INVALID_VALUE"],
      ["modulate", "Vector2(1, 2)", "INVALID_VALUE"],
      ["texture", "res://../x.png", "INVALID_PATH"],
      ["texture", "res://icon.svg\\..\\x", "INVALID_PATH"],
      ["texture", "res://.godot/x.png", "INVALID_PATH"],
      ["texture", "/etc/passwd", "INVALID_PATH"],
      ["texture", "res://sub.tscn", "INVALID_VALUE"],
      ["texture", "res://missing.png", "FILE_NOT_FOUND"],
      ["texture", 5, "INVALID_VALUE"],
      ["no_such_property", 1, "PROPERTY_NOT_FOUND"],
      ["owner", "x", "PROPERTY_NOT_FOUND"],
    ];
    for (const [property, value, code] of bad)
      expect([
        property,
        await failure("update_property", { path: "S", property, value }),
      ]).toEqual([property, code]);
    expect(
      await failure("update_property", {
        path: "Missing",
        property: "z_index",
        value: 1,
      }),
    ).toBe("NODE_NOT_FOUND");
    const text = await saved(path);
    for (const key of ["position", "z_index", "visible", "texture", "modulate"])
      expect(text).not.toContain(`${key} =`);
  });

  test("name renames a node and refuses a clash", async () => {
    const path = await freshScene();
    await ok("add_node", { parentPath: ".", type: "Node", name: "Old" });
    await ok("add_node", { parentPath: ".", type: "Node", name: "Taken" });
    await ok("add_node", { parentPath: "Old", type: "Node", name: "Kid" });
    const renamed = await ok("update_property", {
      path: "Old",
      property: "name",
      value: "New",
    });
    expect(renamed.value).toEqual({ type: "StringName", value: "New" });
    expect(renamed.undoAction).toStartWith("MCP: ");
    expect(
      await failure("update_property", {
        path: "New",
        property: "name",
        value: "Taken",
      }),
    ).toBe("DUPLICATE_NAME");
    for (const value of ["", "a/b", "a.b", 5])
      expect(
        await failure("update_property", {
          path: "New",
          property: "name",
          value,
        }),
      ).toBe("INVALID_VALUE");
    expect(await treeNames()).toEqual(["Root", "New", "Kid", "Taken"]);
    const text = await saved(path);
    expect(text).toContain('[node name="New" type="Node" parent="."');
    expect(text).toContain('[node name="Kid" type="Node" parent="New"');
    expect(text).not.toContain('"Old"');
  });

  test("script attaches a script by path", async () => {
    const path = await freshScene();
    await ok("add_node", { parentPath: ".", type: "Node2D", name: "Scripted" });
    const result = await ok("update_property", {
      path: "Scripted",
      property: "script",
      value: "res://attach.gd",
    });
    expect(result.value).toEqual({
      type: "Object",
      value: "res://attach.gd",
      class: "GDScript",
    });
    expect(
      await failure("update_property", {
        path: "Scripted",
        property: "script",
        value: "res://icon.svg",
      }),
    ).toBe("INVALID_VALUE");
    const text = await saved(path);
    expect(text).toContain('[ext_resource type="Script"');
    expect(text).toMatch(/script = ExtResource\("[^"]+"\)/);
    const props = await ok("get_node_properties", {
      path: "Scripted",
      names: ["script"],
    });
    expect(props.properties.script.value).toBe("res://attach.gd");
  });

  test("a property can be set while adding a node, with script", async () => {
    const path = await freshScene();
    await ok("add_node", {
      parentPath: ".",
      type: "Node2D",
      name: "Both",
      properties: { script: "res://attach.gd", position: "Vector2(9, 9)" },
    });
    const text = await saved(path);
    expect(text).toContain("position = Vector2(9, 9)");
    expect(text).toMatch(/script = ExtResource/);
  });
});

describe("loading and bounds", () => {
  test("a resource of the wrong type is refused without being loaded", async () => {
    await freshScene();
    await ok("add_node", { parentPath: ".", type: "Sprite2D", name: "S" });
    expect(
      await failure("update_property", {
        path: "S",
        property: "texture",
        value: "res://marker_resource.gd",
      }),
    ).toBe("INVALID_VALUE");
    expect(editor.output()).not.toContain("MARKER_RESOURCE_LOADED");
  });

  test("a script that does load runs its static init (the marker is live)", async () => {
    await freshScene();
    await ok("add_node", { parentPath: ".", type: "Node2D", name: "N" });
    await ok("update_property", {
      path: "N",
      property: "script",
      value: "res://marker_node.gd",
    });
    expect(editor.output()).toContain("MARKER_NODE_LOADED");
  });

  test("a script whose base class does not fit the node is refused", async () => {
    await freshScene();
    await ok("add_node", { parentPath: ".", type: "Control", name: "C" });
    expect(
      await failure("update_property", {
        path: "C",
        property: "script",
        value: "res://attach.gd",
      }),
    ).toBe("INVALID_VALUE");
    expect(
      await failure("add_node", {
        parentPath: ".",
        type: "Control",
        properties: { script: "res://attach.gd" },
      }),
    ).toBe("INVALID_VALUE");
    expect(await treeNames()).toEqual(["Root", "C"]);
  });

  test("literal elements are bounded and finite", async () => {
    await freshScene();
    await ok("add_node", { parentPath: ".", type: "Line2D", name: "L" });
    for (const value of [
      "PackedVector2Array(1e999, 0)",
      "PackedVector2Array(1, 2, 3)",
    ])
      expect(
        await failure("update_property", {
          path: "L",
          property: "points",
          value,
        }),
      ).toBe("INVALID_VALUE");
    await ok("update_property", {
      path: "L",
      property: "points",
      value: "PackedVector2Array(1, 2, 3, 4)",
    });
  });
});
