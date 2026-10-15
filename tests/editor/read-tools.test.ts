import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "../helpers.ts";
import {
  buildRequest,
  callTool,
  type Editor,
  freePort,
  prepareProject,
  rawRequest,
  rpc,
  startEditor,
} from "./harness.ts";

// The slice 2 read tools against a real editor: get_project_settings, get_scene_tree, open_scene,
// get_node_properties, get_editor_log, path rules (D38), and write backpressure (D27).

interface TreeNode {
  name: string;
  type: string;
  instance?: string;
  childCount?: number;
  children?: TreeNode[];
}

const countNodes = (node: TreeNode): number =>
  1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);

// A flat scene of `count` children under the root; long names make the tree reply large.
const wideScene = (count: number, nameLength: number): string => {
  const lines = ["[gd_scene format=3]", "", '[node name="Wide" type="Node"]'];
  for (let i = 0; i < count; i++) {
    const name = `n${i}`.padEnd(nameLength, "x");
    lines.push("", `[node name="${name}" type="Node" parent="."]`);
  }
  return `${lines.join("\n")}\n`;
};

let editor: Editor;
let outside: string;

beforeAll(async () => {
  const port = await freePort();
  const dir = await prepareProject(port);
  outside = join(dir, "..", `outside-${port}`);
  await mkdir(join(outside, "dir"), { recursive: true });
  const sceneText = await readFile(join(dir, "sub.tscn"), "utf8");
  await writeFile(join(outside, "out.tscn"), sceneText);
  await writeFile(join(outside, "dir", "in.tscn"), sceneText);
  await symlink(join(outside, "out.tscn"), join(dir, "link.tscn"));
  await symlink(join(outside, "dir"), join(dir, "linkdir"));
  await writeFile(join(dir, "wide.tscn"), wideScene(3000, 640));
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

const tree = async (args: Record<string, unknown> = {}) =>
  (await callTool(editor, "get_scene_tree", args)).structuredContent;

describe("A11 and NO_SCENE", () => {
  test("a fresh editor has auto-opened the main scene", async () => {
    const result = await waitFor(async () => {
      const r = await callTool(editor, "get_scene_tree");
      return r.isError ? undefined : r.structuredContent;
    }, 30_000);
    expect(result).toEqual({
      scenePath: "res://main.tscn",
      truncated: false,
      root: { name: "Main", type: "Node2D" },
    });
  });

  test("NO_SCENE when no scene is open", async () => {
    const port = await freePort();
    const dir = await prepareProject(port);
    const project = join(dir, "project.godot");
    const text = await readFile(project, "utf8");
    await writeFile(project, text.replace(/^run\/main_scene=.*\n/m, ""));
    const bare = await startEditor({ dir, port });
    try {
      for (const [name, args] of [
        ["get_scene_tree", {}],
        ["get_node_properties", { path: "." }],
      ] as const) {
        const r = await callTool(bare, name, args);
        expect(r.isError).toBe(true);
        expect(r.structuredContent.error.code).toBe("NO_SCENE");
      }
    } finally {
      await bare.stop();
    }
  }, 120_000);
});

describe("get_project_settings", () => {
  test("includes defaults and project values, as {type, value}", async () => {
    const { settings, truncated } = (
      await callTool(editor, "get_project_settings", { prefix: "physics/2d/" })
    ).structuredContent;
    expect(settings["physics/2d/default_gravity"]).toEqual({
      type: "float",
      value: 980,
    });
    expect(
      Object.keys(settings).every((k) => k.startsWith("physics/2d/")),
    ).toBe(true);
    expect(truncated).toBe(false);
    const name = await callTool(editor, "get_project_settings", {
      prefix: "application/config/name",
    });
    expect(name.structuredContent.settings["application/config/name"]).toEqual({
      type: "String",
      value: "GD Fixture",
    });
  });

  test("limit truncates in name order", async () => {
    const { settings, truncated } = (
      await callTool(editor, "get_project_settings", { limit: 3 })
    ).structuredContent;
    const keys = Object.keys(settings);
    expect(keys).toHaveLength(3);
    expect(keys).toEqual([...keys].sort());
    expect(truncated).toBe(true);
  });

  test("a limit of 0 is invalid params", async () => {
    await expect(
      callTool(editor, "get_project_settings", { limit: 0 }),
    ).rejects.toThrow("-32602");
  });
});

describe("open_scene and get_scene_tree", () => {
  test("opens rich.tscn; an immediate read matches exactly; the instance is not expanded", async () => {
    const opened = await callTool(editor, "open_scene", {
      path: "res://rich.tscn",
    });
    expect(opened.structuredContent).toEqual({
      editedScene: "res://rich.tscn",
    });
    expect(await tree()).toEqual({
      scenePath: "res://rich.tscn",
      truncated: false,
      root: {
        name: "Rich",
        type: "Node2D",
        children: [
          { name: "Sprite", type: "Sprite2D" },
          { name: "Label", type: "Label" },
          {
            name: "Holder",
            type: "Node",
            children: [
              {
                name: "Inner",
                type: "Node2D",
                children: [{ name: "Leaf", type: "Node" }],
              },
            ],
          },
          { name: "Sub", type: "Node2D", instance: "res://sub.tscn" },
        ],
      },
    });
  });

  test("opening the edited scene again returns at once; opening main switches back and forth", async () => {
    const again = await callTool(editor, "open_scene", {
      path: "res://rich.tscn",
    });
    expect(again.structuredContent).toEqual({ editedScene: "res://rich.tscn" });
    await callTool(editor, "open_scene", { path: "res://main.tscn" });
    expect((await tree()).scenePath).toBe("res://main.tscn");
    await callTool(editor, "open_scene", { path: "res://rich.tscn" });
    expect((await tree()).scenePath).toBe("res://rich.tscn");
  });

  test("maxDepth cuts below the limit and reports childCount", async () => {
    const result = await tree({ maxDepth: 1 });
    expect(result.truncated).toBe(true);
    const holder = result.root.children.find(
      (n: TreeNode) => n.name === "Holder",
    );
    expect(holder).toEqual({ name: "Holder", type: "Node", childCount: 1 });
    const zero = await tree({ maxDepth: 0 });
    expect(zero.root).toEqual({ name: "Rich", type: "Node2D", childCount: 4 });
  });

  test("rootPath starts the tree at a node; a bad one is NODE_NOT_FOUND", async () => {
    expect((await tree({ rootPath: "Holder/Inner" })).root).toEqual({
      name: "Inner",
      type: "Node2D",
      children: [{ name: "Leaf", type: "Node" }],
    });
    for (const rootPath of ["Nope", "../Rich", "/root", "Sub/SubChild"]) {
      const r = await callTool(editor, "get_scene_tree", { rootPath });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("NODE_NOT_FOUND");
    }
  });

  test("a 3,000-node scene is cut to exactly maxNodes", async () => {
    await callTool(editor, "open_scene", { path: "res://wide.tscn" });
    const byDefault = await tree();
    expect(byDefault.truncated).toBe(true);
    expect(countNodes(byDefault.root)).toBe(2000);
    expect(byDefault.root.childCount).toBe(3000);
    const few = await tree({ maxNodes: 7 });
    expect(countNodes(few.root)).toBe(7);
    expect(few.truncated).toBe(true);
    const all = await tree({ maxNodes: 3001 });
    expect(countNodes(all.root)).toBe(3001);
    expect(all.truncated).toBe(false);
  });
});

describe("get_node_properties", () => {
  const props = async (path: string, names?: string[]) =>
    await callTool(editor, "get_node_properties", { path, names });

  test("values are exact: Vector2 literal, texture path, native text", async () => {
    await callTool(editor, "open_scene", { path: "res://rich.tscn" });
    const root = (await props(".", ["position", "visible", "z_index"]))
      .structuredContent.properties;
    expect(root).toEqual({
      position: { type: "Vector2", value: "Vector2(10.5, -20)" },
      visible: { type: "bool", value: true },
      z_index: { type: "int", value: 0 },
    });
    const sprite = (await props("Sprite", ["texture"])).structuredContent
      .properties;
    expect(sprite.texture).toEqual({
      type: "Object",
      value: "res://icon.svg",
      class: "CompressedTexture2D",
    });
    const label = (await props("Label", ["text"])).structuredContent.properties;
    expect(label.text).toEqual({ type: "String", value: "héllo\nworld" });
  });

  test("a null Resource names its declared type", async () => {
    const r = (await props("Label", ["label_settings"])).structuredContent
      .properties;
    expect(r.label_settings).toEqual({
      type: "Object",
      value: null,
      class: null,
    });
  });

  test("without names it returns every editor property", async () => {
    const all = (await props("Label")).structuredContent.properties;
    expect(all.text.value).toBe("héllo\nworld");
    expect(all.position).toBeDefined();
    expect(Object.keys(all).length).toBeGreaterThan(20);
  });

  test("NODE_NOT_FOUND and PROPERTY_NOT_FOUND", async () => {
    for (const path of ["Nope", "Sub/SubChild", "/root", ".."]) {
      const r = await props(path);
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("NODE_NOT_FOUND");
    }
    const bad = await props("Label", ["text", "no_such_property"]);
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe("PROPERTY_NOT_FOUND");
    expect(bad.structuredContent.error.message).toContain("no_such_property");
  });
});

describe("path rules", () => {
  const rejected = [
    ["a path outside res://", "/etc/passwd"],
    ["a user:// path", "user://x.tscn"],
    ["..", "res://../x.tscn"],
    ["a .. in the middle", "res://sub/../rich.tscn"],
    ["a . segment", "res://./rich.tscn"],
    ["an empty segment", "res:////rich.tscn"],
    ["res://.godot", "res://.godot/editor/x.tscn"],
    ["res://.GODOT in capitals", "res://.GODOT/x.tscn"],
    ["a backslash before ..", "res://..\\x.tscn"],
    ["a backslash after .godot", "res://.godot\\x.tscn"],
    ["a backslash through a symlinked directory", "res://linkdir\\in.tscn"],
    [
      "a backslash traversal to an absolute path",
      "res://addons\\..\\..\\tmp\\x.tscn",
    ],
    ["a colon", "res://c:/x.tscn"],
    ["a control character", "res://rich\u0001.tscn"],
    ["a trailing slash", "res://rich.tscn/"],
    ["a wrong extension", "res://icon.svg"],
    ["a symlinked file that escapes", "res://link.tscn"],
    ["a file under a symlinked directory", "res://linkdir/in.tscn"],
  ] as const;
  for (const [label, path] of rejected) {
    test(`open_scene rejects ${label}`, async () => {
      const r = await callTool(editor, "open_scene", { path });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error.code).toBe("INVALID_PATH");
    });
  }

  test("a path with a half-million segments is rejected fast", async () => {
    const path = `res://${"a/".repeat(500_000)}x.tscn`;
    const started = Date.now();
    const r = await callTool(editor, "open_scene", { path });
    expect(r.structuredContent.error.code).toBe("INVALID_PATH");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a missing file is FILE_NOT_FOUND", async () => {
    const r = await callTool(editor, "open_scene", { path: "res://nope.tscn" });
    expect(r.structuredContent.error.code).toBe("FILE_NOT_FOUND");
  });
});

describe("backpressure", () => {
  test("a client that never reads the 3,000-node tree does not block a second client", async () => {
    await callTool(editor, "open_scene", { path: "res://wide.tscn" });
    const request = buildRequest(editor, {
      body: rpc("tools/call", {
        name: "get_scene_tree",
        arguments: { maxNodes: 3000 },
      }),
    });
    const full = await rawRequest(editor.port, [request]);
    expect(full.status).toBe(200);
    const fullBytes = Buffer.byteLength(full.body);
    expect(fullBytes).toBeGreaterThan(3_500_000);

    // Node and Bun sockets read eagerly, so the stalled client is a shell that sends the request,
    // then sleeps without reading. Whether a reply near the 4 MB cap fills the kernel buffers depends on
    // the host's tcp_wmem and tcp_rmem; dispatch.test.ts proves the write deadline with a larger reply.
    const script = [
      `exec 3<>/dev/tcp/127.0.0.1/${editor.port}`,
      'printf "%s" "$REQ" >&3',
      "sleep 3",
      "timeout 5 cat <&3 | wc -c",
      "echo $PIPESTATUS",
    ].join("\n");
    const stalled = Bun.spawn(["bash", "-c", script], {
      env: { ...process.env, REQ: request },
      stdout: "pipe",
    });
    await Bun.sleep(500);

    // The editor keeps answering other clients while the first one stalls.
    const started = Date.now();
    const info = await callTool(editor, "get_project_info");
    expect(info.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);

    const [bytes, catStatus] = (await new Response(stalled.stdout).text())
      .trim()
      .split("\n")
      .map(Number);
    // cat reached EOF (status 0, not timeout's 124): the server closed the connection. A closed
    // connection may have lost part of the reply, but never gains bytes.
    expect(catStatus).toBe(0);
    expect(bytes).toBeLessThanOrEqual(fullBytes + 200);
  }, 40_000);
});

describe("get_editor_log", () => {
  test("opening broken_ref.tscn logs an error; the since cursor skips what was read", async () => {
    const before = (await callTool(editor, "get_editor_log")).structuredContent;
    expect(before.dropped).toBe(0);
    // The editor refuses a scene with a missing dependency, so the switch never settles.
    const opened = await callTool(editor, "open_scene", {
      path: "res://broken_ref.tscn",
    });
    expect(opened.structuredContent.error.code).toBe("SCENE_SWITCH_TIMEOUT");
    const log = (
      await callTool(editor, "get_editor_log", {
        since: before.nextSince,
        level: "error",
      })
    ).structuredContent;
    const hit = log.entries.find((e: { message: string }) =>
      e.message.includes("missing_texture.png"),
    );
    expect(hit).toBeDefined();
    expect(hit.level).toBe("error");
    expect(hit.seq).toBeGreaterThan(before.nextSince);
    expect(
      log.entries.every((e: { level: string }) => e.level === "error"),
    ).toBe(true);

    const next = (
      await callTool(editor, "get_editor_log", { since: log.nextSince })
    ).structuredContent;
    expect(
      next.entries.some((e: { message: string }) =>
        e.message.includes("missing_texture.png"),
      ),
    ).toBe(false);
    const limited = (await callTool(editor, "get_editor_log", { limit: 1 }))
      .structuredContent;
    expect(limited.entries).toHaveLength(1);
    expect(limited.nextSince).toBe(limited.entries[0].seq);
  }, 60_000);
});

describe("hygiene", () => {
  test("the editor printed no SCRIPT ERROR", () => {
    expect(editor.output()).not.toContain("SCRIPT ERROR");
  });
});
