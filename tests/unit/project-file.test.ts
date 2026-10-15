import { describe, expect, test } from "bun:test";
import { parseProjectFile } from "../../src/godot/project-file.ts";

describe("parseProjectFile", () => {
  test("reads top-level keys and sections", () => {
    const file = parseProjectFile(`; comment
config_version=5

[application]

config/name="Demo"
run/main_scene="res://main.tscn"
`);
    expect(file[""]).toEqual({ config_version: "5" });
    expect(file.application).toEqual({
      "config/name": "Demo",
      "run/main_scene": "res://main.tscn",
    });
  });

  test("parses PackedStringArray into a string array", () => {
    const file = parseProjectFile(`[application]
config/features=PackedStringArray("4.7", "C#", "Forward Plus")
empty=PackedStringArray()
`);
    expect(file.application).toEqual({
      "config/features": ["4.7", "C#", "Forward Plus"],
      empty: [],
    });
  });

  test("keeps other values as raw strings and unescapes quoted ones", () => {
    const file = parseProjectFile(`[section]
flag=true
number=0.5
path="res://a \\"b\\".gd"
object=Object(Node,"name":"x")
`);
    expect(file.section).toEqual({
      flag: "true",
      number: "0.5",
      path: 'res://a "b".gd',
      object: 'Object(Node,"name":"x")',
    });
  });

  test("joins a multi-line value until its brackets balance", () => {
    const file = parseProjectFile(`[input]
ui_accept={
"deadzone": 0.5,
"events": [Object(InputEventKey,"keycode":32)]
}
after="ok"
`);
    expect(file.input?.ui_accept).toBe(
      '{\n"deadzone": 0.5,\n"events": [Object(InputEventKey,"keycode":32)]\n}',
    );
    expect(file.input?.after).toBe("ok");
  });

  test("ignores brackets inside quoted strings", () => {
    const file = parseProjectFile(`[s]
label="a { not a block"
next=1
`);
    expect(file.s).toEqual({ label: "a { not a block", next: "1" });
  });

  test("rejects a line that is neither a section nor key=value", () => {
    expect(() => parseProjectFile("[application]\nnot a key\n")).toThrow(
      "malformed project.godot line",
    );
  });
});
